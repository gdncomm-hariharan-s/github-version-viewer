const express = require('express');
const { TOKEN, PROD_LABELS } = require('../lib/config');
const {
  fetchFileHistory,
  fetchFileWithSha,
  commitFileUpdate,
  invalidateGhCacheForFile,
  getBranchHeadSha,
  createBranch,
  createPullRequest,
} = require('../lib/github');
const { applyVersionChange } = require('../lib/versions');
const { clearRouteCache } = require('../lib/cache');
const { getLock } = require('../lib/locks');

const router = express.Router();

router.get('/api/deploy-options', async (req, res) => {
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

router.post('/api/deploy', async (req, res) => {
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

  // Fail-open: a lock-check DB error shouldn't block an otherwise-working
  // deploy path — log it and proceed as if unlocked.
  let lock = null;
  try {
    lock = await getLock(service, label);
  } catch (err) {
    console.warn(`[locks] could not verify lock status for ${service}/${label}, proceeding as unlocked: ${err.message}`);
  }
  if (lock) {
    return res.status(423).json({
      error: `${service} / ${label} is locked by ${lock.locked_by}${lock.reason ? ` (${lock.reason})` : ''}`,
      lock,
    });
  }

  try {
    const { content, sha } = await fetchFileWithSha(repo, branch, filePath);
    const newContent = applyVersionChange(content, filePath, version);
    if (!newContent) {
      return res.status(422).json({ error: `Could not find a version/tag field to update in ${filePath}` });
    }

    if (!PROD_LABELS.has(label)) {
      const commitResult = await commitFileUpdate(repo, branch, filePath, newContent, sha, version);
      invalidateGhCacheForFile(repo, filePath);
      clearRouteCache();
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

router.get('/api/file-history', async (req, res) => {
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

module.exports = router;
