const {
  NONPROD_TEAM_SLUG,
  PROD_TEAM_SLUG,
  NONPROD_ENVS,
  PROD_ENVS,
  ALL_ENV_LABELS,
  EXTRA_NONPROD_REPOS,
  EXTRA_PROD_REPOS,
  ENV_VAR_VERSION_KEY_BY_REPO,
} = require('./config');
const { listTeamRepos, fetchExtraRepos, fetchFileAndStatusBatch, fetchRecentPrs, prTouchesKey } = require('./github');
const { serviceKey, extractImageTag, extractJenkinsfileVersion, CRF_RE, labelPr, isAutomatedAuthor } = require('./versions');

async function buildVersionsCompare() {
  const errors = [];

  // A team-listing failure is global (no per-repo isolation possible — we don't
  // know what repos would've been in it), but it shouldn't nuke the OTHER team's
  // results, so each is caught independently and just contributes an empty list.
  const safeListTeamRepos = async (slug) => {
    try {
      return await listTeamRepos(slug);
    } catch (err) {
      errors.push({ service: `team:${slug}`, message: err.message });
      return [];
    }
  };

  const [nonprodTeamRepos, prodTeamRepos, extraNonprodRepos, extraProdRepos] = await Promise.all([
    safeListTeamRepos(NONPROD_TEAM_SLUG),
    safeListTeamRepos(PROD_TEAM_SLUG),
    fetchExtraRepos(EXTRA_NONPROD_REPOS, errors),
    fetchExtraRepos(EXTRA_PROD_REPOS, errors),
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

  // One GraphQL job per (repo, side) — each fetches every env's values.yaml
  // content + branch-head build status in ONE aliased field per env, and jobs
  // across repos are batched into a handful of HTTP requests total (see
  // fetchFileAndStatusBatch), replacing what used to be 1-2 REST calls PER ENV.
  const SIDES = [
    ['nonprodRepo', NONPROD_ENVS],
    ['prodRepo', PROD_ENVS],
  ];

  const primaryJobs = [];
  for (const row of rows.values()) {
    for (const [repoKey, sideEnvs] of SIDES) {
      const repoFullName = row[repoKey];
      if (!repoFullName) continue;
      primaryJobs.push({
        repoFullName,
        envs: sideEnvs.map((e) => ({ label: e.label, branch: e.branch, path: `deployment/${e.dir}/values.yaml` })),
      });
    }
  }
  const primaryResults = await fetchFileAndStatusBatch(primaryJobs);

  // Repos where NONE of their envs resolved a version fall back to reading
  // the version out of the Jenkinsfile instead — batched the same way.
  const fallbackJobs = [];
  for (const row of rows.values()) {
    for (const [repoKey, sideEnvs] of SIDES) {
      const repoFullName = row[repoKey];
      if (!repoFullName) continue;
      const fileData = primaryResults.get(repoFullName) || {};
      const hasVersion = sideEnvs.some((e) => extractImageTag(fileData[e.label]?.text || '', repoFullName));
      if (!hasVersion) {
        fallbackJobs.push({
          repoFullName,
          envs: sideEnvs.map((e) => ({ label: e.label, branch: e.branch, path: 'Jenkinsfile' })),
        });
      }
    }
  }
  const fallbackResults = fallbackJobs.length ? await fetchFileAndStatusBatch(fallbackJobs) : new Map();

  for (const row of rows.values()) {
    // A failure reading one repo's data (rate limit, deleted branch, whatever)
    // must not take down every other service — tag this row and move on.
    try {
      row.versions = {};
      row.builds = {};
      row.sources = {};
      for (const [repoKey, sideEnvs] of SIDES) {
        const repoFullName = row[repoKey];
        if (!repoFullName) continue;

        const primary = primaryResults.get(repoFullName) || {};
        for (const env of sideEnvs) {
          const version = extractImageTag(primary[env.label]?.text || '', repoFullName);
          if (version) {
            row.versions[env.label] = version;
            row.builds[env.label] = primary[env.label].build;
          }
        }

        const hasVersion = sideEnvs.some((e) => row.versions[e.label]);
        if (!hasVersion) {
          const fallback = fallbackResults.get(repoFullName) || {};
          for (const env of sideEnvs) {
            const version = fallback[env.label]?.text ? extractJenkinsfileVersion(fallback[env.label].text) : null;
            if (version) {
              row.versions[env.label] = version;
              row.sources[env.label] = 'jenkinsfile';
              row.builds[env.label] = fallback[env.label].build;
            }
          }
        }
      }
    } catch (err) {
      row.error = err.message;
    }
  }

  const results = Array.from(rows.values())
    .filter((row) => row.error || (row.versions.qa2 && row.versions.preprod && row.versions.prod))
    .sort((a, b) => a.service.localeCompare(b.service));
  const envConfig = {};
  for (const env of NONPROD_ENVS) envConfig[env.label] = { side: 'nonprod', branch: env.branch, dir: env.dir };
  for (const env of PROD_ENVS) envConfig[env.label] = { side: 'prod', branch: env.branch, dir: env.dir };
  return { envLabels: ALL_ENV_LABELS, envConfig, results, errors };
}

async function buildReleasePrs() {
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
  return { results };
}

module.exports = { buildVersionsCompare, buildReleasePrs };
