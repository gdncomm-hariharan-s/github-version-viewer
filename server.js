require('dotenv').config();
const express = require('express');
const path = require('path');
const { PORT } = require('./lib/config');
const { ensureSchema } = require('./lib/db');
const routes = require('./routes');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(routes);

// Non-blocking: the app has no other DB dependency, so a Postgres outage at
// startup shouldn't prevent it from serving GitHub-backed pages — only the
// lock feature is affected until this succeeds (see lib/locks.js callers).
ensureSchema().catch((err) =>
  console.error('[locks] schema init failed — lock features will error until DB is reachable:', err.message)
);

app.listen(PORT, () => {
  console.log(`github-version-viewer listening on http://localhost:${PORT}`);
});
