const express = require('express');

const router = express.Router();
router.use(require('./build-status'));
router.use(require('./deploy'));
router.use(require('./restart'));
router.use(require('./refresh'));
router.use(require('./versions'));
router.use(require('./release-prs'));
router.use(require('./jira'));
router.use(require('./locks'));
router.use(require('./github-user'));

module.exports = router;
