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

function extractImageTag(valuesYamlText) {
  const match = valuesYamlText.match(IMAGE_TAG_RE);
  return match ? match[1] : null;
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

async function fetchEnvVersions(repoFullName, envs) {
  const out = {};
  await Promise.all(
    envs.map(async (env) => {
      try {
        const content = await fetchValuesYaml(repoFullName, env.branch, env.dir);
        out[env.label] = content ? extractImageTag(content) : null;
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

  const extractor = filePath.endsWith('Jenkinsfile') ? extractJenkinsfileVersion : extractImageTag;

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

app.use(express.static(path.join(__dirname, 'public')));

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
    const [nonprodRepos, prodRepos] = await Promise.all([
      listTeamRepos(NONPROD_TEAM_SLUG),
      listTeamRepos(PROD_TEAM_SLUG),
    ]);

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
          const jenkinsfileVersion = await fetchJenkinsfileVersion(row.nonprodRepo, row.nonprodBranch);
          if (jenkinsfileVersion) {
            for (const env of NONPROD_ENVS) {
              row.versions[env.label] = jenkinsfileVersion;
              row.sources[env.label] = 'jenkinsfile';
            }
          }
        }

        const prodHasVersion = Object.values(prodVersions).some(Boolean);
        if (row.prodRepo && !prodHasVersion) {
          const jenkinsfileVersion = await fetchJenkinsfileVersion(row.prodRepo, row.prodBranch);
          if (jenkinsfileVersion) {
            for (const env of PROD_ENVS) {
              row.versions[env.label] = jenkinsfileVersion;
              row.sources[env.label] = 'jenkinsfile';
            }
          }
        }
      })
    );

    const results = Array.from(rows.values()).sort((a, b) => a.service.localeCompare(b.service));
    const envConfig = {};
    for (const env of NONPROD_ENVS) envConfig[env.label] = { side: 'nonprod', branch: env.branch, dir: env.dir };
    for (const env of PROD_ENVS) envConfig[env.label] = { side: 'prod', branch: env.branch, dir: env.dir };
    res.json({ envLabels: ALL_ENV_LABELS, envConfig, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`github-version-viewer listening on http://localhost:${PORT}`);
});
