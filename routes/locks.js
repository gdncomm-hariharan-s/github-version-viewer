const express = require('express');
const { listLocks, createLock, deleteLock } = require('../lib/locks');
const { fetchGithubUser } = require('../lib/github');

const router = express.Router();

function toApiShape(row) {
  return {
    service: row.service,
    label: row.env_label,
    lockedBy: row.locked_by,
    reason: row.reason,
    lockedAt: row.locked_at,
  };
}

router.get('/api/locks', async (req, res) => {
  try {
    res.json({ locks: (await listLocks()).map(toApiShape) });
  } catch (err) {
    res.status(503).json({ error: `Lock database unavailable: ${err.message}` });
  }
});

router.post('/api/locks', async (req, res) => {
  const { service, label, lockedBy, reason } = req.body || {};
  if (!service || !label || !lockedBy) {
    return res.status(400).json({ error: 'service, label, and lockedBy are required' });
  }
  try {
    // Must be a real GitHub user — the unlock permission check later depends
    // on this being a trustworthy handle, not arbitrary text.
    const lockerUser = await fetchGithubUser(lockedBy);
    if (!lockerUser) return res.status(400).json({ error: `No GitHub user "${lockedBy}"` });

    const { created, lock } = await createLock(service, label, lockerUser.username, reason);
    if (!created) return res.status(409).json({ error: `Already locked by ${lock.locked_by}`, lock: toApiShape(lock) });
    res.status(201).json({ lock: toApiShape(lock) });
  } catch (err) {
    res.status(503).json({ error: `Lock database unavailable: ${err.message}` });
  }
});

router.delete('/api/locks', async (req, res) => {
  const { service, label, requestedBy } = req.query;
  if (!service || !label) return res.status(400).json({ error: 'service and label query params are required' });
  if (!requestedBy) return res.status(400).json({ error: 'requestedBy query param is required' });
  try {
    const { result, lock } = await deleteLock(service, label, requestedBy);
    if (result === 'not_found') return res.json({ deleted: false });
    if (result === 'forbidden') {
      return res.status(403).json({ error: `Only ${lock.locked_by} can unlock this` });
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(503).json({ error: `Lock database unavailable: ${err.message}` });
  }
});

module.exports = router;
