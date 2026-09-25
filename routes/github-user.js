const express = require('express');
const { TOKEN } = require('../lib/config');
const { fetchGithubUser } = require('../lib/github');

const router = express.Router();

// Validates a typed GitHub username, used to confirm lock/unlock identity
// before it's trusted and stored (server-side and in the browser's localStorage).
router.get('/api/github-user', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  const username = (req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username query param is required' });
  try {
    const user = await fetchGithubUser(username);
    if (!user) return res.status(404).json({ error: `No GitHub user "${username}"` });
    res.json({ user });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
