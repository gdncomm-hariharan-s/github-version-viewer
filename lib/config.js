const PORT = process.env.PORT || 3000;
const ORG = process.env.GITHUB_ORG || 'gdncomm';
const TOKEN = process.env.GITHUB_TOKEN;

const JIRA_URL = process.env.JIRA_URL;
const JIRA_USER = process.env.JIRA_USER;
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const IMPLEMENTATION_PLAN_FIELD = 'customfield_10051';

const NONPROD_TEAM_SLUG = 'dgp-deployment-nonprod';
const PROD_TEAM_SLUG = 'dgp-deployment';

const NONPROD_ENVS = [
  { label: 'qa2', branch: 'qa2', dir: 'qa2' },
  { label: 'canary-qa2', branch: 'canary-qa2', dir: 'canary-qa2' },
  { label: 'preprod', branch: 'preprod', dir: 'preprod' },
  { label: 'canary-preprod', branch: 'canary-preprod', dir: 'canary-preprod' },
];
const PROD_ENVS = [
  { label: 'prod', branch: 'master', dir: 'prod' },
  { label: 'canary-prod', branch: 'canary-prod', dir: 'canary-prod' },
];
const ALL_ENV_LABELS = [...NONPROD_ENVS, ...PROD_ENVS].map((e) => e.label);

const GH_API = 'https://api.github.com';
const GH_GRAPHQL_API = 'https://api.github.com/graphql';

// Repos that belong to the same release train but aren't tagged into their
// team (missing squad/tribe custom property), so the Teams API won't return them.
const EXTRA_PROD_REPOS = ['gdncomm/prod-deployment-gdn-pyeongyang-ui'];
const EXTRA_NONPROD_REPOS = ['gdncomm/nonprod-deployment-gdn-pyeongyang-ui'];

// A handful of "shell" repos (e.g. the pyeongyang-ui main UI shell) list dozens
// of child-service versions as plain env vars instead of a single image.tag.
// For those, track one specific key as this repo's "version".
const ENV_VAR_VERSION_KEY_BY_REPO = {
  'gdncomm/nonprod-deployment-gdn-pyeongyang-ui': 'PY_DIGITAL',
  'gdncomm/prod-deployment-gdn-pyeongyang-ui': 'PY_DIGITAL',
};

const PROD_LABELS = new Set(['prod', 'canary-prod']);

const GH_CACHE_TTL_MS = Number(process.env.GH_CACHE_TTL_MS || 60_000);
const ROUTE_CACHE_TTL_MS = Number(process.env.ROUTE_CACHE_TTL_MS || 60_000);

// A brand-new commit genuinely has zero statuses for the few seconds before
// Jenkins' webhook fires — that's a real, observable fact from GitHub (the
// commit's own timestamp), not a guess, so we can report it authoritatively
// and identically to every viewer instead of each browser guessing locally.
const BUILD_NOT_STARTED_WINDOW_MS = 5 * 60 * 1000;

const GRAPHQL_BATCH_SIZE = 10;

module.exports = {
  PORT,
  ORG,
  TOKEN,
  JIRA_URL,
  JIRA_USER,
  JIRA_TOKEN,
  IMPLEMENTATION_PLAN_FIELD,
  NONPROD_TEAM_SLUG,
  PROD_TEAM_SLUG,
  NONPROD_ENVS,
  PROD_ENVS,
  ALL_ENV_LABELS,
  GH_API,
  GH_GRAPHQL_API,
  EXTRA_PROD_REPOS,
  EXTRA_NONPROD_REPOS,
  ENV_VAR_VERSION_KEY_BY_REPO,
  PROD_LABELS,
  GH_CACHE_TTL_MS,
  ROUTE_CACHE_TTL_MS,
  BUILD_NOT_STARTED_WINDOW_MS,
  GRAPHQL_BATCH_SIZE,
};
