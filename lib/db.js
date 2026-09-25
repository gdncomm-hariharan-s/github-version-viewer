const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

const pool = new Pool({ connectionString: DATABASE_URL });

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS locks (
    service    TEXT NOT NULL,
    env_label  TEXT NOT NULL,
    locked_by  TEXT NOT NULL,
    reason     TEXT,
    locked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (service, env_label)
  );
`;

let readyPromise = null;

// Idempotent, no migration framework needed for one table — every query
// function re-awaits this so a startup race (DB not up yet) self-heals on
// the next call instead of caching a permanent failure.
function ensureSchema() {
  if (!readyPromise) {
    readyPromise = pool.query(CREATE_TABLE_SQL).catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

module.exports = { pool, ensureSchema };
