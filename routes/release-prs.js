const express = require('express');
const { TOKEN } = require('../lib/config');
const { cachedRoute, ROUTE_CACHE_TTL_MS } = require('../lib/cache');
const { buildReleasePrs } = require('../lib/compare');

const router = express.Router();

router.get('/api/release-prs', async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set on server' });
  }
  try {
    const data = await cachedRoute('release-prs', ROUTE_CACHE_TTL_MS, () => buildReleasePrs(), req.query.refresh === '1');
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
