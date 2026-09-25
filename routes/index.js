const express = require('express');

const router = express.Router();
router.use(require('./build-status'));
router.use(require('./deploy'));
router.use(require('./reset'));
router.use(require('./refresh'));
router.use(require('./versions'));
router.use(require('./release-prs'));
router.use(require('./jira'));

module.exports = router;
