const express = require('express');
const { TOKEN } = require('../lib/config');
const { fetchLatestCommitBuildStatus } = require('../lib/github');

const router = express.Router();

// Lightweight, always-fresh single-cell status check — used by the frontend to
// poll only the builds that are currently "pending", instead of re-fetching the
// whole (cached, expensive) /api/versions/compare payload.
router.get('/api/build-status', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const { repo, branch, path: filePath } = req.query;
  if (!repo || !branch || !filePath) {
    return res.status(400).json({ error: 'repo, branch, and path query params are required' });
  }
  try {
    const build = await fetchLatestCommitBuildStatus(repo, branch, filePath, { force: true });
    res.json({ build });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
