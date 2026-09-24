require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ORG = process.env.GITHUB_ORG || 'gdncomm';
const TOKEN = process.env.GITHUB_TOKEN;

const NONPROD_TEAM_SLUG = 'dgp-deployment-nonprod';
const PROD_TEAM_SLUG = 'dgp-deployment';

const NONPROD_ENVS = [
  { label: 'qa2', branch: 'qa2', dir: 'qa2' },
  { label: 'canary-qa2', branch: 'canary-qa2', dir: 'canary-qa2' },
  { label: 'preprod', branch: 'preprod', dir: 'preprod' },
  { label: 'canary-preprod', branch: 'canary-preprod', dir: 'canary-preprod' },
];
const PROD_ENVS = [
  { label: 'prod', branch: 'master', dir: 'prod' },
  { label: 'canary-prod', branch: 'canary-prod', dir: 'canary-prod' },
];
const ALL_ENV_LABELS = [...NONPROD_ENVS, ...PROD_ENVS].map((e) => e.label);

const GH_API = 'https://api.github.com';

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
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

async function fetchValuesYaml(repoFullName, branch, dir) {
  const url = `${GH_API}/repos/${repoFullName}/contents/deployment/${dir}/values.yaml?ref=${branch}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

const IMAGE_TAG_RE = /image:\s*\r?\n(?:.*\r?\n)*?\s*tag:\s*["']?([\w.\-]+)["']?/;

// A handful of "shell" repos (e.g. the pyeongyang-ui main UI shell) list dozens
// of child-service versions as plain env vars instead of a single image.tag.
// For those, track one specific key as this repo's "version".
const ENV_VAR_VERSION_KEY_BY_REPO = {
  'gdncomm/nonprod-deployment-gdn-pyeongyang-ui': 'PY_DIGITAL',
  'gdncomm/prod-deployment-gdn-pyeongyang-ui': 'PY_DIGITAL',
};

function extractImageTag(valuesYamlText, repoFullName) {
  const match = valuesYamlText.match(IMAGE_TAG_RE);
  if (match) return match[1];

  const envKey = repoFullName && ENV_VAR_VERSION_KEY_BY_REPO[repoFullName];
  if (envKey) {
    const envMatch = valuesYamlText.match(new RegExp(`\\b${envKey}\\s*:\\s*([\\w.\\-]+)`));
    if (envMatch) return envMatch[1];
  }
  return null;
}

const JENKINSFILE_VERSION_RE = /\bversion\s*[:=]\s*['"]([\w.\-]+)['"]/i;

function extractJenkinsfileVersion(jenkinsfileText) {
  for (const line of jenkinsfileText.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    const match = line.match(JENKINSFILE_VERSION_RE);
    if (match) return match[1];
  }
  return null;
}

async function fetchJenkinsfileVersion(repoFullName, branch) {
  const url = `${GH_API}/repos/${repoFullName}/contents/Jenkinsfile?ref=${branch}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  const text = Buffer.from(data.content, 'base64').toString('utf8');
  return extractJenkinsfileVersion(text);
}

function serviceKey(repoName) {
  return repoName.replace(/^(nonprod|prod)-(deployment|infra)-/, '');
}

// Repos that belong to the same release train but aren't tagged into their
// team (missing squad/tribe custom property), so the Teams API won't return them.
const EXTRA_PROD_REPOS = ['gdncomm/prod-deployment-gdn-pyeongyang-ui'];
const EXTRA_NONPROD_REPOS = ['gdncomm/nonprod-deployment-gdn-pyeongyang-ui'];

async function fetchExtraRepos(fullNames) {
  return Promise.all(fullNames.map((full) => ghGet(`${GH_API}/repos/${full}`)));
}

const CRF_RE = /CRF-\d+/i;

function labelPr(repoName, pr) {
  if (pr.base.ref === 'canary-prod') return 'canary';
  if (repoName.endsWith('-static')) return 'static';
  return 'non-canary';
}

function isAutomatedAuthor(login) {
  return login.includes('[bot]') || login.includes('automation');
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

async function fetchEnvVersions(repoFullName, envs) {
  const out = {};
  await Promise.all(
    envs.map(async (env) => {
      try {
        const content = await fetchValuesYaml(repoFullName, env.branch, env.dir);
        out[env.label] = content ? extractImageTag(content, repoFullName) : null;
      } catch (err) {
        out[env.label] = null;
      }
    })
  );
  return out;
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
        const cRes = await fetch(contentUrl, { headers: ghHeaders() });
        if (cRes.ok) {
          const cData = await cRes.json();
          if (cData.content) {
            const text = Buffer.from(cData.content, 'base64').toString('utf8');
            version = extractor(text);
          }
        }
      } catch (err) {
        version = null;
      }
      return {
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        author: c.commit.author?.name || c.author?.login || 'unknown',
        date: c.commit.author?.date || null,
        message: c.commit.message.split('\n')[0],
        htmlUrl: c.html_url,
        version,
      };
    })
  );
}

const IMAGE_TAG_REPLACE_RE = /(image:\s*\r?\n(?:.*\r?\n)*?\s*tag:\s*["']?)([\w.\-]+)(["']?)/;

function replaceImageTag(valuesYamlText, newVersion) {
  if (!IMAGE_TAG_REPLACE_RE.test(valuesYamlText)) return null;
  return valuesYamlText.replace(IMAGE_TAG_REPLACE_RE, (_, pre, _old, post) => `${pre}${newVersion}${post}`);
}

const JENKINSFILE_VERSION_REPLACE_RE = /(\bversion\s*[:=]\s*['"])([\w.\-]+)(['"])/i;

function replaceJenkinsfileVersionLine(line, newVersion) {
  return line.replace(JENKINSFILE_VERSION_REPLACE_RE, (_, pre, _old, post) => `${pre}${newVersion}${post}`);
}

function applyVersionChange(fileText, filePath, newVersion) {
  if (filePath.endsWith('Jenkinsfile')) {
    const lines = fileText.split('\n');
    let replaced = false;
    const out = lines.map((line) => {
      if (replaced || line.trim().startsWith('//')) return line;
      if (!JENKINSFILE_VERSION_REPLACE_RE.test(line)) return line;
      replaced = true;
      return replaceJenkinsfileVersionLine(line, newVersion);
    });
    return replaced ? out.join('\n') : null;
  }
  return replaceImageTag(fileText, newVersion);
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

const PROD_LABELS = new Set(['prod', 'canary-prod']);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/deploy-options', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath } = req.query;
  if (!repo || !branch || !filePath) {
    return res.status(400).json({ error: 'repo, branch, and path query params are required' });
  }
  try {
    const history = await fetchFileHistory(repo, branch, filePath);
    const seen = new Set();
    const versions = [];
    for (const h of history) {
      if (h.version && !seen.has(h.version)) {
        seen.add(h.version);
        versions.push(h.version);
      }
    }
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deploy', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath, label, version, service } = req.body || {};
  if (!repo || !branch || !filePath || !label || !version) {
    return res.status(400).json({ error: 'repo, branch, path, label, and version are required' });
  }
  if (!/^[\w.\-]+$/.test(version)) {
    return res.status(400).json({ error: 'version contains invalid characters' });
  }

  try {
    const { content, sha } = await fetchFileWithSha(repo, branch, filePath);
    const newContent = applyVersionChange(content, filePath, version);
    if (!newContent) {
      return res.status(422).json({ error: `Could not find a version/tag field to update in ${filePath}` });
    }

    if (!PROD_LABELS.has(label)) {
      const commitResult = await commitFileUpdate(repo, branch, filePath, newContent, sha, version);
      return res.json({
        mode: 'direct-commit',
        commitUrl: commitResult.commit?.html_url,
        branch,
      });
    }

    const baseSha = await getBranchHeadSha(repo, branch);
    const suffix = Math.random().toString(36).slice(2, 7);
    const newBranch = `deploy-${label}-${version}-${suffix}`;
    await createBranch(repo, newBranch, baseSha);
    await commitFileUpdate(repo, newBranch, filePath, newContent, sha, version);
    const pr = await createPullRequest(
      repo,
      newBranch,
      branch,
      version,
      `Deploy ${service || ''} ${label} to ${version}.\n\nOpened via github-version-viewer.`
    );
    return res.json({ mode: 'pull-request', prUrl: pr.html_url, branch: newBranch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/file-history', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath } = req.query;
  if (!repo || !branch || !filePath) {
    return res.status(400).json({ error: 'repo, branch, and path query params are required' });
  }
  try {
    const history = await fetchFileHistory(repo, branch, filePath);
    res.json({ repo, branch, path: filePath, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/versions/compare', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  try {
    const [nonprodTeamRepos, prodTeamRepos, extraNonprodRepos, extraProdRepos] = await Promise.all([
      listTeamRepos(NONPROD_TEAM_SLUG),
      listTeamRepos(PROD_TEAM_SLUG),
      fetchExtraRepos(EXTRA_NONPROD_REPOS),
      fetchExtraRepos(EXTRA_PROD_REPOS),
    ]);
    const nonprodRepos = [...nonprodTeamRepos, ...extraNonprodRepos];
    const prodRepos = [...prodTeamRepos, ...extraProdRepos];

    const rows = new Map();
    for (const repo of nonprodRepos) {
      const key = serviceKey(repo.name);
      rows.set(key, {
        service: key,
        nonprodRepo: repo.full_name,
        nonprodBranch: repo.default_branch,
        prodRepo: null,
        prodBranch: null,
        versions: {},
      });
    }
    for (const repo of prodRepos) {
      const key = serviceKey(repo.name);
      const existing = rows.get(key);
      if (existing) {
        existing.prodRepo = repo.full_name;
        existing.prodBranch = repo.default_branch;
      } else {
        rows.set(key, {
          service: key,
          nonprodRepo: null,
          nonprodBranch: null,
          prodRepo: repo.full_name,
          prodBranch: repo.default_branch,
          versions: {},
        });
      }
    }

    await Promise.all(
      Array.from(rows.values()).map(async (row) => {
        const [nonprodVersions, prodVersions] = await Promise.all([
          row.nonprodRepo ? fetchEnvVersions(row.nonprodRepo, NONPROD_ENVS) : {},
          row.prodRepo ? fetchEnvVersions(row.prodRepo, PROD_ENVS) : {},
        ]);
        row.versions = { ...nonprodVersions, ...prodVersions };
        row.sources = {};

        const nonprodHasVersion = Object.values(nonprodVersions).some(Boolean);
        if (row.nonprodRepo && !nonprodHasVersion) {
          await Promise.all(
            NONPROD_ENVS.map(async (env) => {
              const jenkinsfileVersion = await fetchJenkinsfileVersion(row.nonprodRepo, env.branch);
              if (jenkinsfileVersion) {
                row.versions[env.label] = jenkinsfileVersion;
                row.sources[env.label] = 'jenkinsfile';
              }
            })
          );
        }

        const prodHasVersion = Object.values(prodVersions).some(Boolean);
        if (row.prodRepo && !prodHasVersion) {
          await Promise.all(
            PROD_ENVS.map(async (env) => {
              const jenkinsfileVersion = await fetchJenkinsfileVersion(row.prodRepo, env.branch);
              if (jenkinsfileVersion) {
                row.versions[env.label] = jenkinsfileVersion;
                row.sources[env.label] = 'jenkinsfile';
              }
            })
          );
        }
      })
    );

    const results = Array.from(rows.values())
      .filter((row) => row.versions.qa2 && row.versions.preprod && row.versions.prod)
      .sort((a, b) => a.service.localeCompare(b.service));
    const envConfig = {};
    for (const env of NONPROD_ENVS) envConfig[env.label] = { side: 'nonprod', branch: env.branch, dir: env.dir };
    for (const env of PROD_ENVS) envConfig[env.label] = { side: 'prod', branch: env.branch, dir: env.dir };
    res.json({ envLabels: ALL_ENV_LABELS, envConfig, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/release-prs', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  try {
    const teamRepos = await listTeamRepos(PROD_TEAM_SLUG);
    const extraRepos = await fetchExtraRepos(EXTRA_PROD_REPOS);
    const repos = [...teamRepos, ...extraRepos];

    const rows = new Map();
    await Promise.all(
      repos.map(async (repo) => {
        let prs;
        try {
          prs = await fetchRecentPrs(repo.full_name);
        } catch (err) {
          prs = [];
        }
        if (prs.length === 0) return;

        // Some repos (e.g. the pyeongyang-ui shell) bundle unrelated changes
        // (infra config, other child services) into PRs alongside real
        // version bumps — only consider PRs that actually touch this repo's
        // tracked key so we don't surface an unrelated PR as "the release".
        const requiredKey = ENV_VAR_VERSION_KEY_BY_REPO[repo.full_name];
        if (requiredKey) {
          const touches = await Promise.all(prs.map((pr) => prTouchesKey(repo.full_name, pr.number, requiredKey)));
          prs = prs.filter((_, i) => touches[i]);
        }
        if (prs.length === 0) return;

        const key = serviceKey(repo.name);
        if (!rows.has(key)) rows.set(key, { service: key, crf: null, prs: [] });
        const row = rows.get(key);

        // Keep only the most recent human-authored PR per label per repo —
        // prefer a real release PR (even closed) over noisier bot/automation
        // PRs (e.g. secret-rotation bumps) that happen to be more recent.
        const latestByLabel = new Map();
        for (const pr of prs) {
          const label = labelPr(repo.name, pr);
          const author = pr.user?.login || 'unknown';
          const automated = isAutomatedAuthor(author);
          const existingPr = latestByLabel.get(label);
          if (!existingPr) {
            latestByLabel.set(label, pr);
            continue;
          }
          const existingAutomated = isAutomatedAuthor(existingPr.user?.login || 'unknown');
          if (existingAutomated && !automated) {
            latestByLabel.set(label, pr);
          } else if (existingAutomated === automated && new Date(pr.created_at) > new Date(existingPr.created_at)) {
            latestByLabel.set(label, pr);
          }
        }

        for (const [label, pr] of latestByLabel) {
          const crfMatch = pr.title.match(CRF_RE) || pr.head.ref.match(CRF_RE);
          if (crfMatch && !row.crf) row.crf = crfMatch[0].toUpperCase();
          const author = pr.user?.login || 'unknown';
          row.prs.push({
            label,
            repo: repo.full_name,
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            author,
            createdAt: pr.created_at,
            baseRef: pr.base.ref,
            state: pr.state,
            automated: author.includes('[bot]') || author.includes('automation'),
          });
        }
      })
    );

    const results = Array.from(rows.values())
      .filter((row) => row.prs.some((pr) => !pr.automated && pr.state === 'open'))
      .sort((a, b) => a.service.localeCompare(b.service));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`github-version-viewer listening on http://localhost:${PORT}`);
});
