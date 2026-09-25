const { pool, ensureSchema } = require('./db');

async function listLocks() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT service, env_label, locked_by, reason, locked_at FROM locks');
  return rows;
}

async function getLock(service, envLabel) {
  await ensureSchema();
  const { rows } = await pool.query(
    'SELECT service, env_label, locked_by, reason, locked_at FROM locks WHERE service = $1 AND env_label = $2',
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
     RETURNING service, env_label, locked_by, reason, locked_at`,
    [service, envLabel, lockedBy, reason || null]
  );
  if (rows[0]) return { created: true, lock: rows[0] };
  return { created: false, lock: await getLock(service, envLabel) }; // race-safe: someone beat us to it
}

async function deleteLock(service, envLabel) {
  await ensureSchema();
  const { rowCount } = await pool.query('DELETE FROM locks WHERE service = $1 AND env_label = $2', [service, envLabel]);
  return rowCount > 0;
}

module.exports = { listLocks, getLock, createLock, deleteLock };
