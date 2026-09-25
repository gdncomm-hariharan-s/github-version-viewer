const express = require('express');
const { JIRA_URL, JIRA_USER, JIRA_TOKEN, IMPLEMENTATION_PLAN_FIELD } = require('../lib/config');
const {
  jiraGet,
  jiraPut,
  findImplementationStepsTable,
  appendLinksToParagraphCell,
  setDependencyCell,
  appendToImplementationPlanDoc,
} = require('../lib/jira');

const router = express.Router();

// Jira CRF: push PR links into the "IMPLEMENTATION STEPS" description table
// and the "Implementation Plan" custom field.
router.post('/api/jira/update-crf', async (req, res) => {
  if (!JIRA_URL || !JIRA_USER || !JIRA_TOKEN) {
    return res.status(500).json({ error: 'JIRA_URL, JIRA_USER, and JIRA_TOKEN must be set on server' });
  }
  const { crf, entries, taskDependency } = req.body || {};
  if (!crf || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'crf and a non-empty entries[] (label, url) are required' });
  }

  try {
    const issue = await jiraGet(`/rest/api/3/issue/${crf}?fields=description,${IMPLEMENTATION_PLAN_FIELD}`);
    const description = issue.fields.description;
    if (!description) return res.status(422).json({ error: 'Issue has no description to update' });

    const table = findImplementationStepsTable(description);
    if (!table) return res.status(422).json({ error: 'Could not find an "IMPLEMENTATION STEPS" table in the description' });

    const dataRow = table.content[1];
    if (!dataRow || !dataRow.content[1]) {
      return res.status(422).json({ error: 'IMPLEMENTATION STEPS table has an unexpected shape' });
    }
    appendLinksToParagraphCell(dataRow.content[1], entries);
    if (dataRow.content[2]) setDependencyCell(dataRow.content[2], taskDependency);

    const implementationPlan = appendToImplementationPlanDoc(issue.fields[IMPLEMENTATION_PLAN_FIELD], entries);

    await jiraPut(`/rest/api/3/issue/${crf}?notifyUsers=false`, {
      fields: { description, [IMPLEMENTATION_PLAN_FIELD]: implementationPlan },
    });

    res.json({ url: `${JIRA_URL}/browse/${crf}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
