const express = require('express');
const { TOKEN } = require('../lib/config');
const { fetchFileWithSha, fetchLatestCommitBuildStatus } = require('../lib/github');
const { extractImageTag, extractJenkinsfileVersion } = require('../lib/versions');

const router = express.Router();

// On-demand, always-live refetch of one env's version + build status — used by
// the frontend's per-row "refresh" button. Bypasses both cache layers entirely
// (fetchFileWithSha is uncached; force:true bypasses the build-status cache),
// unlike /api/versions/compare which is deliberately cached for the whole table.
router.get('/api/refresh-version', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath } = req.query;
  if (!repo || !branch || !filePath) {
    return res.status(400).json({ error: 'repo, branch, and path query params are required' });
  }
  try {
    const [{ content }, build] = await Promise.all([
      fetchFileWithSha(repo, branch, filePath),
      fetchLatestCommitBuildStatus(repo, branch, filePath, { force: true }),
    ]);
    const version = filePath.endsWith('Jenkinsfile')
      ? extractJenkinsfileVersion(content)
      : extractImageTag(content, repo);
    res.json({ version, build });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
