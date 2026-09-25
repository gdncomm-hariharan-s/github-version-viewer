const { pool, ensureSchema } = require('./db');

const COLUMNS = 'service, env_label, locked_by, reason, locked_at';

async function listLocks() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM locks`);
  return rows;
}

async function getLock(service, envLabel) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM locks WHERE service = $1 AND env_label = $2`,
    [service, envLabel]
  );
  return rows[0] || null;
}

async function createLock(service, envLabel, lockedBy, reason) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO locks (service, env_label, locked_by, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (service, env_label) DO NOTHING
     RETURNING ${COLUMNS}`,
    [service, envLabel, lockedBy, reason || null]
  );
  if (rows[0]) return { created: true, lock: rows[0] };
  return { created: false, lock: await getLock(service, envLabel) }; // race-safe: someone beat us to it
}

// Only the original locker may delete a lock.
// Returns 'ok' | 'not_found' | 'forbidden' so the route can pick the right status code.
async function deleteLock(service, envLabel, requestedBy) {
  await ensureSchema();
  const lock = await getLock(service, envLabel);
  if (!lock) return { result: 'not_found' };
  if (lock.locked_by.toLowerCase() !== String(requestedBy || '').toLowerCase()) {
    return { result: 'forbidden', lock };
  }
  await pool.query('DELETE FROM locks WHERE service = $1 AND env_label = $2', [service, envLabel]);
  return { result: 'ok' };
}

module.exports = { listLocks, getLock, createLock, deleteLock };
