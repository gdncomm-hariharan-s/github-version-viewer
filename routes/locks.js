const express = require('express');
const { listLocks, createLock, deleteLock } = require('../lib/locks');

const router = express.Router();

function toApiShape(row) {
  return { service: row.service, label: row.env_label, lockedBy: row.locked_by, reason: row.reason, lockedAt: row.locked_at };
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
    const { created, lock } = await createLock(service, label, lockedBy, reason);
    if (!created) return res.status(409).json({ error: `Already locked by ${lock.locked_by}`, lock: toApiShape(lock) });
    res.status(201).json({ lock: toApiShape(lock) });
  } catch (err) {
    res.status(503).json({ error: `Lock database unavailable: ${err.message}` });
  }
});

router.delete('/api/locks', async (req, res) => {
  const { service, label } = req.query;
  if (!service || !label) return res.status(400).json({ error: 'service and label query params are required' });
  try {
    res.json({ deleted: await deleteLock(service, label) });
  } catch (err) {
    res.status(503).json({ error: `Lock database unavailable: ${err.message}` });
  }
});

module.exports = router;
