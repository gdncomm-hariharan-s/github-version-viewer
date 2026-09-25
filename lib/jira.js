const { JIRA_URL, JIRA_USER, JIRA_TOKEN } = require('./config');

function jiraHeaders() {
  const auth = Buffer.from(`${JIRA_USER}:${JIRA_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

async function jiraGet(path) {
  const res = await fetch(`${JIRA_URL}${path}`, { headers: jiraHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function jiraPut(path, body) {
  const res = await fetch(`${JIRA_URL}${path}`, { method: 'PUT', headers: jiraHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const respBody = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status} for ${path}: ${respBody.slice(0, 300)}`);
  }
}

// Finds the table right after a "... IMPLEMENTATION STEPS" heading in the ADF description.
function findImplementationStepsTable(doc) {
  const content = doc.content || [];
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    if (node.type !== 'heading') continue;
    const text = (node.content || []).map((c) => c.text || '').join('');
    if (!/implementation steps/i.test(text)) continue;
    for (let j = i + 1; j < content.length; j++) {
      if (content[j].type === 'table') return content[j];
      if (content[j].type === 'heading') break;
    }
  }
  return null;
}

function appendLinksToParagraphCell(cell, entries) {
  if (!cell.content) cell.content = [];
  let para = cell.content.find((n) => n.type === 'paragraph');
  if (!para) {
    para = { type: 'paragraph', content: [] };
    cell.content.push(para);
  }
  if (!para.content) para.content = [];
  entries.forEach(({ label, url }) => {
    if (para.content.length) para.content.push({ type: 'hardBreak' });
    para.content.push({ type: 'text', text: `${label}: ` });
    para.content.push({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] });
  });
}

function setDependencyCell(cell, text) {
  if (!text) return;
  cell.content = [{ type: 'paragraph', content: [{ type: 'text', text }] }];
}

function appendToImplementationPlanDoc(doc, entries) {
  const base = doc && doc.content ? doc : { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PR:' }] }] };
  let para = base.content.find((n) => n.type === 'paragraph');
  if (!para) {
    para = { type: 'paragraph', content: [] };
    base.content.unshift(para);
  }
  if (!para.content) para.content = [];
  entries.forEach(({ label, url }) => {
    para.content.push({ type: 'hardBreak' });
    para.content.push({ type: 'text', text: `${label}: ` });
    para.content.push({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] });
  });
  return base;
}

module.exports = {
  jiraGet,
  jiraPut,
  findImplementationStepsTable,
  appendLinksToParagraphCell,
  setDependencyCell,
  appendToImplementationPlanDoc,
};
