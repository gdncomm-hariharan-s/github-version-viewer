const express = require('express');
const { TOKEN, PROD_LABELS } = require('../lib/config');
const {
  fetchFileWithSha,
  commitFileUpdate,
  invalidateGhCacheForFile,
  getBranchHeadSha,
  createBranch,
  createPullRequest,
} = require('../lib/github');
const { bumpRestartCount } = require('../lib/versions');
const { clearRouteCache } = require('../lib/cache');

const router = express.Router();

// Forces a redeploy of whatever version is already running, by bumping the
// `restart:` counter in values.yaml — no version change, just a fresh rollout
// (useful when a pod/deploy is stuck). Same direct-commit vs PR split as /api/deploy.
router.post('/api/reset', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath, label, service } = req.body || {};
  if (!repo || !branch || !filePath || !label) {
    return res.status(400).json({ error: 'repo, branch, path, and label are required' });
  }
  if (filePath.endsWith('Jenkinsfile')) {
    return res.status(422).json({ error: 'Reset only applies to values.yaml deployments (no restart tag in Jenkinsfile)' });
  }

  try {
    const { content, sha } = await fetchFileWithSha(repo, branch, filePath);
    const newContent = bumpRestartCount(content);
    const message = `Reset ${service || ''} ${label} (restart tag bump)`.trim();

    if (!PROD_LABELS.has(label)) {
      const commitResult = await commitFileUpdate(repo, branch, filePath, newContent, sha, message);
      invalidateGhCacheForFile(repo, filePath);
      clearRouteCache();
      return res.json({ mode: 'direct-commit', commitUrl: commitResult.commit?.html_url, branch });
    }

    const baseSha = await getBranchHeadSha(repo, branch);
    const suffix = Math.random().toString(36).slice(2, 7);
    const newBranch = `reset-${label}-${suffix}`;
    await createBranch(repo, newBranch, baseSha);
    await commitFileUpdate(repo, newBranch, filePath, newContent, sha, message);
    const pr = await createPullRequest(
      repo,
      newBranch,
      branch,
      message,
      `Force redeploy (restart tag bump) for ${service || ''} ${label}.\n\nOpened via github-version-viewer.`
    );
    return res.json({ mode: 'pull-request', prUrl: pr.html_url, branch: newBranch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
