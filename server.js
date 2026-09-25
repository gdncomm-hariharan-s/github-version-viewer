require('dotenv').config();
const express = require('express');
const path = require('path');
const { PORT } = require('./lib/config');
const routes = require('./routes');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(routes);

app.listen(PORT, () => {
  console.log(`github-version-viewer listening on http://localhost:${PORT}`);
});
