const { ENV_VAR_VERSION_KEY_BY_REPO } = require('./config');

const IMAGE_TAG_RE = /image:\s*\r?\n(?:.*\r?\n)*?\s*tag:\s*["']?([\w.\-]+)["']?/;

function extractImageTag(valuesYamlText, repoFullName) {
  const match = valuesYamlText.match(IMAGE_TAG_RE);
  if (match) return match[1];

  const envKey = repoFullName && ENV_VAR_VERSION_KEY_BY_REPO[repoFullName];
  if (envKey) {
    const envMatch = valuesYamlText.match(new RegExp(`\\b${envKey}\\s*:\\s*([\\w.\\-]+)`));
    if (envMatch) return envMatch[1];
  }
  return null;
}

const JENKINSFILE_VERSION_RE = /\bversion\s*[:=]\s*['"]([\w.\-]+)['"]/i;

function extractJenkinsfileVersion(jenkinsfileText) {
  for (const line of jenkinsfileText.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    const match = line.match(JENKINSFILE_VERSION_RE);
    if (match) return match[1];
  }
  return null;
}

function serviceKey(repoName) {
  return repoName.replace(/^(nonprod|prod)-(deployment|infra)-/, '');
}

const IMAGE_TAG_REPLACE_RE = /(image:\s*\r?\n(?:.*\r?\n)*?\s*tag:\s*["']?)([\w.\-]+)(["']?)/;

function replaceImageTag(valuesYamlText, newVersion) {
  if (!IMAGE_TAG_REPLACE_RE.test(valuesYamlText)) return null;
  return valuesYamlText.replace(IMAGE_TAG_REPLACE_RE, (_, pre, _old, post) => `${pre}${newVersion}${post}`);
}

const JENKINSFILE_VERSION_REPLACE_RE = /(\bversion\s*[:=]\s*['"])([\w.\-]+)(['"])/i;

function replaceJenkinsfileVersionLine(line, newVersion) {
  return line.replace(JENKINSFILE_VERSION_REPLACE_RE, (_, pre, _old, post) => `${pre}${newVersion}${post}`);
}

function applyVersionChange(fileText, filePath, newVersion) {
  if (filePath.endsWith('Jenkinsfile')) {
    const lines = fileText.split('\n');
    let replaced = false;
    const out = lines.map((line) => {
      if (replaced || line.trim().startsWith('//')) return line;
      if (!JENKINSFILE_VERSION_REPLACE_RE.test(line)) return line;
      replaced = true;
      return replaceJenkinsfileVersionLine(line, newVersion);
    });
    return replaced ? out.join('\n') : null;
  }
  return replaceImageTag(fileText, newVersion);
}

const RESTART_RE = /^restart:\s*(\d+)\s*$/m;

// The "restart" counter is a plain top-level field in values.yaml, unrelated
// to image.tag — bumping it forces a redeploy of the SAME version (e.g. a
// stuck pod), without touching what version is actually running.
function bumpRestartCount(valuesYamlText) {
  const match = valuesYamlText.match(RESTART_RE);
  if (match) {
    const next = Number(match[1]) + 1;
    return valuesYamlText.replace(RESTART_RE, `restart: ${next}`);
  }
  return `restart: 1\n${valuesYamlText}`;
}

const CRF_RE = /CRF-\d+/i;

function labelPr(repoName, pr) {
  if (pr.base.ref === 'canary-prod') return 'canary';
  if (repoName.endsWith('-static')) return 'static';
  return 'non-canary';
}

function isAutomatedAuthor(login) {
  return login.includes('[bot]') || login.includes('automation');
}

module.exports = {
  extractImageTag,
  extractJenkinsfileVersion,
  serviceKey,
  applyVersionChange,
  bumpRestartCount,
  CRF_RE,
  labelPr,
  isAutomatedAuthor,
};
