const {
  TOKEN,
  ORG,
  GH_API,
  GH_GRAPHQL_API,
  GH_CACHE_TTL_MS,
  BUILD_NOT_STARTED_WINDOW_MS,
  GRAPHQL_BATCH_SIZE,
} = require('./config');
const { serviceKey, extractImageTag, extractJenkinsfileVersion } = require('./versions');

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const ghCache = new Map(); // url -> { expiresAt, promise }

// Cached GET returning { status, data } — lets callers handle 404s etc. themselves.
// Pass { force: true } to bypass the cache and always hit GitHub (used for polling
// in-progress builds, where a 60s-stale "pending" would never resolve on its own).
async function ghGetRaw(url, { force = false } = {}) {
  const cached = ghCache.get(url);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const res = await fetch(url, { headers: ghHeaders() });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) ghCache.delete(url); // don't cache error responses (e.g. rate limit, 404)
    return { status: res.status, ok: res.ok, data };
  })();

  ghCache.set(url, { expiresAt: Date.now() + GH_CACHE_TTL_MS, promise });
  promise.catch(() => ghCache.delete(url)); // don't cache thrown/network failures either
  return promise;
}

async function ghGet(url, opts) {
  const { ok, status, data } = await ghGetRaw(url, opts);
  if (!ok) throw new Error(`GitHub API ${status} for ${url}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// After a commit, the contents fetch AND the commits-list fetch (used by both
// file-history and the build-status poll) are all now stale — purge every
// cached URL for this repo+file, not just the one we happen to name.
function invalidateGhCacheForFile(repoFullName, filePath) {
  const contentsPrefix = `${GH_API}/repos/${repoFullName}/contents/${filePath}?`;
  const commitsPrefix = `${GH_API}/repos/${repoFullName}/commits?path=${encodeURIComponent(filePath)}`;
  for (const key of ghCache.keys()) {
    if (key.startsWith(contentsPrefix) || key.startsWith(commitsPrefix)) ghCache.delete(key);
  }
}

async function listTeamRepos(teamSlug) {
  const repos = [];
  let page = 1;
  for (;;) {
    const batch = await ghGet(
      `${GH_API}/orgs/${ORG}/teams/${teamSlug}/repos?per_page=100&page=${page}`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

// One broken/renamed extra repo shouldn't take down the whole listing — skip it
// and surface why, instead of failing every other service in the response.
async function fetchExtraRepos(fullNames, errors) {
  const repos = await Promise.all(
    fullNames.map(async (full) => {
      try {
        return await ghGet(`${GH_API}/repos/${full}`);
      } catch (err) {
        errors.push({ service: serviceKey(full.split('/').pop()), message: err.message });
        return null;
      }
    })
  );
  return repos.filter(Boolean);
}

// GitHub's combined-status endpoint accepts a branch name directly as `ref` —
// no need to separately list commits just to resolve a SHA first. That was
// doubling every build-status check (list + status) for no reason; this is
// the single biggest contributor to /api/versions/compare's GitHub call count.
async function fetchLatestCommitBuildStatus(repoFullName, branch, filePath, opts) {
  const build = await fetchCommitBuildStatus(repoFullName, branch, opts);
  if (!build) return null;
  if (build.state === 'unknown' && build.sha) {
    // Only pay for a 2nd call in the one case we actually need commit metadata
    // GitHub doesn't include in the status response: the commit's own age.
    try {
      const commit = await ghGet(`${GH_API}/repos/${repoFullName}/commits/${build.sha}`, opts);
      const commitDate = commit?.commit?.author?.date;
      const ageMs = commitDate ? Date.now() - new Date(commitDate).getTime() : Infinity;
      if (ageMs < BUILD_NOT_STARTED_WINDOW_MS) build.state = 'not_started';
    } catch (err) {
      // leave as 'unknown' — age just couldn't be determined
    }
  }
  return build;
}

// --- GraphQL batch fetch (values.yaml/Jenkinsfile content + build status) --
// The REST path above costs 1-2 calls PER ENV PER REPO. GitHub's GraphQL API
// can fetch a file's content by branch+path AND a branch's latest commit +
// combined status in one field each, and multiple repos can be aliased into
// a single HTTP request — so this replaces up to ~226 REST calls (24 services
// x up to 6 envs) with a handful of GraphQL requests for the whole homepage.
async function ghGraphQL(query) {
  const res = await fetch(GH_GRAPHQL_API, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  // GraphQL can return partial `data` alongside `errors` (e.g. one aliased repo
  // was renamed/deleted) — only treat it as a hard failure when there's no data at all.
  if (!body || (!body.data && body.errors)) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(body?.errors).slice(0, 300)}`);
  }
  return body.data || {};
}

// GraphQL's StatusState enum is UPPERCASE (SUCCESS/PENDING/FAILURE/ERROR/EXPECTED);
// the rest of this app (and the frontend) expects lowercase, matching the REST API.
function mapStatusToBuild(refTarget) {
  if (!refTarget) return null;
  const contexts = refTarget.status?.contexts || [];
  const jenkins = contexts.find((c) => /jenkins/i.test(c.context));
  const chosen = jenkins || contexts[0];
  if (!chosen) {
    const ageMs = refTarget.committedDate ? Date.now() - new Date(refTarget.committedDate).getTime() : Infinity;
    return { state: ageMs < BUILD_NOT_STARTED_WINDOW_MS ? 'not_started' : 'unknown', targetUrl: null, context: null };
  }
  return { state: chosen.state.toLowerCase(), targetUrl: chosen.targetUrl || null, context: chosen.context };
}

// One "job" = one repo, fetching { text, build } for each of its envs in a
// single query, chunked across repos to keep each request reasonably sized.
async function fetchFileAndStatusBatch(jobs) {
  const results = new Map(); // repoFullName -> { [label]: { text, build } }
  for (let i = 0; i < jobs.length; i += GRAPHQL_BATCH_SIZE) {
    const chunk = jobs.slice(i, i + GRAPHQL_BATCH_SIZE);
    const repoBlocks = chunk.map((job, j) => {
      const [owner, name] = job.repoFullName.split('/');
      const fields = job.envs
        .map((env, k) => {
          const expr = JSON.stringify(`${env.branch}:${env.path}`);
          const qualified = JSON.stringify(`refs/heads/${env.branch}`);
          return `e${k}_blob: object(expression: ${expr}) { ... on Blob { text } }
          e${k}_ref: ref(qualifiedName: ${qualified}) { target { ... on Commit {
            committedDate
            status { contexts { context state targetUrl } }
          } } }`;
        })
        .join('\n');
      return `repo${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${fields}\n}`;
    });

    let data;
    try {
      data = await ghGraphQL(`query {\n${repoBlocks.join('\n')}\n}`);
    } catch (err) {
      continue; // this chunk's repos are left out of `results` — callers treat that as "no data"
    }

    chunk.forEach((job, j) => {
      const repoData = data[`repo${j}`];
      const perEnv = {};
      job.envs.forEach((env, k) => {
        perEnv[env.label] = {
          text: repoData?.[`e${k}_blob`]?.text || null,
          build: mapStatusToBuild(repoData?.[`e${k}_ref`]?.target),
        };
      });
      results.set(job.repoFullName, perEnv);
    });
  }
  return results;
}

// `ref` may be a branch name OR a commit SHA — GitHub accepts either here.
async function fetchCommitBuildStatus(repoFullName, ref, opts) {
  try {
    const data = await ghGet(`${GH_API}/repos/${repoFullName}/commits/${ref}/status`, opts);
    const jenkins = (data.statuses || []).find((s) => /jenkins/i.test(s.context));
    const chosen = jenkins || data.statuses?.[0];
    if (!chosen) return { state: 'unknown', targetUrl: null, context: null, sha: data.sha };
    return { state: chosen.state, targetUrl: chosen.target_url || null, context: chosen.context, sha: data.sha };
  } catch (err) {
    return { state: 'unknown', targetUrl: null, context: null, sha: null };
  }
}

async function fetchFileHistory(repoFullName, branch, filePath, limit = 10) {
  const url = `${GH_API}/repos/${repoFullName}/commits?path=${encodeURIComponent(
    filePath
  )}&sha=${encodeURIComponent(branch)}&per_page=${limit}`;
  const commits = await ghGet(url);

  const extractor = filePath.endsWith('Jenkinsfile')
    ? extractJenkinsfileVersion
    : (text) => extractImageTag(text, repoFullName);

  return Promise.all(
    commits.map(async (c) => {
      let version = null;
      try {
        const contentUrl = `${GH_API}/repos/${repoFullName}/contents/${filePath}?ref=${c.sha}`;
        const { ok, data: cData } = await ghGetRaw(contentUrl);
        if (ok && cData.content) {
          const text = Buffer.from(cData.content, 'base64').toString('utf8');
          version = extractor(text);
        }
      } catch (err) {
        version = null;
      }
      const build = await fetchCommitBuildStatus(repoFullName, c.sha);
      return {
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        author: c.commit.author?.name || c.author?.login || 'unknown',
        date: c.commit.author?.date || null,
        message: c.commit.message.split('\n')[0],
        htmlUrl: c.html_url,
        version,
        build,
      };
    })
  );
}

async function fetchFileWithSha(repoFullName, branch, filePath) {
  const url = `${GH_API}/repos/${repoFullName}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

async function commitFileUpdate(repoFullName, branch, filePath, newContent, sha, message) {
  const url = `${GH_API}/repos/${repoFullName}/contents/${filePath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha,
      branch,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} committing ${filePath}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getBranchHeadSha(repoFullName, branch) {
  const data = await ghGet(`${GH_API}/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(branch)}`);
  return data.object.sha;
}

async function createBranch(repoFullName, newBranch, fromSha) {
  const url = `${GH_API}/repos/${repoFullName}/git/refs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} creating branch ${newBranch}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function createPullRequest(repoFullName, head, base, title, body) {
  const url = `${GH_API}/repos/${repoFullName}/pulls`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, head, base, body }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} creating PR: ${errBody.slice(0, 300)}`);
  }
  return res.json();
}

// Used to validate a typed GitHub username actually exists (lock identity).
// Returns null for a 404 instead of throwing — that's an expected outcome here,
// not an error — and lets a bad handle over an org's private repo still resolve
// via the public /users endpoint (no org membership required to look this up).
async function fetchGithubUser(username) {
  const { ok, status, data } = await ghGetRaw(`${GH_API}/users/${encodeURIComponent(username)}`);
  if (status === 404) return null;
  if (!ok) throw new Error(`GitHub API ${status} for user ${username}`);
  return { username: data.login, name: data.name || data.login, avatarUrl: data.avatar_url };
}

async function fetchRecentPrs(repoFullName, count = 15) {
  return ghGet(`${GH_API}/repos/${repoFullName}/pulls?state=all&sort=created&direction=desc&per_page=${count}`);
}

async function prTouchesKey(repoFullName, prNumber, key) {
  try {
    const files = await ghGet(`${GH_API}/repos/${repoFullName}/pulls/${prNumber}/files`);
    return files.some((f) => (f.patch || '').includes(key));
  } catch (err) {
    return false;
  }
}

module.exports = {
  ghGetRaw,
  ghGet,
  invalidateGhCacheForFile,
  listTeamRepos,
  fetchExtraRepos,
  fetchLatestCommitBuildStatus,
  fetchCommitBuildStatus,
  fetchFileAndStatusBatch,
  fetchFileHistory,
  fetchFileWithSha,
  commitFileUpdate,
  getBranchHeadSha,
  createBranch,
  createPullRequest,
  fetchGithubUser,
  fetchRecentPrs,
  prTouchesKey,
};
