# GitHub Version Viewer

Internal tool for comparing deployed versions of GDN digital-products services across environments, viewing release history, summarizing open release PRs, and deploying new versions — all from one dashboard, backed by the GitHub API.

## Features

- **Version comparison** — reads `image.tag` from each repo's `deployment/<env>/values.yaml` (or `Jenkinsfile` for repos that don't use a values file) across `qa2`, `canary-qa2`, `preprod`, `canary-preprod`, `prod`, `canary-prod`. Repos are pulled from the `dgp-deployment-nonprod` and `dgp-deployment` GitHub teams, plus a small list of extra repos that aren't tagged into either team.
- **Service filter** — multi-select checkbox filter (with search) to narrow the table to specific services. Selection is saved to `localStorage` and reflected in the URL as `?services=svc-a,svc-b` so filtered views are shareable/bookmarkable.
- **Version history** — click any version pill to see the commit history (author, date, message) for that file.
- **Release PR summary** (`release.html`) — lists today's open, non-automated release PRs per service (static / canary / non-canary), tagged with the matching Jira CRF ticket, with copy-to-clipboard for individual PR links and a combined formatted list.
- **Deploy from the UI** — per-row **Deploy** button opens a modal (environment dropdown limited to envs the service actually has, version textbox with autocomplete from past versions). Commits directly for `qa2`/`preprod` environments; opens a branch + PR for `prod` environments. A "Default deploy env" dropdown lets you skip picking the environment every time.
- **Bulk promote preprod → prod** — lists every service where `preprod` differs from `prod`, lets you drop rows you don't want, asks for confirmation, then bulk-creates PRs and reports the results.

## Requirements

- Node.js 18+
- A GitHub token with `read:org` and `repo` scopes (e.g. from `gh auth token` after `gh auth login`)

## Setup

```bash
npm install
cp .env.example .env   # then fill in GITHUB_TOKEN
npm start
```

Open `http://localhost:3000`.

## Configuration (`.env`)

| Variable       | Description                                  |
|----------------|-----------------------------------------------|
| `GITHUB_TOKEN` | GitHub token used for all API calls           |
| `GITHUB_ORG`   | GitHub org to read teams/repos from (`gdncomm`) |
| `PORT`         | Port to serve the app on (default `3000`)     |

## Project layout

```
server.js          Express backend — GitHub API integration, version/PR endpoints, deploy/promote logic
public/index.html   Main comparison dashboard
public/detail.html  Per-file commit history view
public/release.html Release PR summary page
```

No build step — plain Tailwind CSS via the Play CDN, vanilla JS, no frontend framework.

## Notes

- Access is intended to be restricted to the internal VPN/network; there is no authentication built into the app itself.
- Version edits use regex-based patching of YAML/Groovy text rather than a full YAML parser, so they only support the `image:\n  tag:` pattern and known `Jenkinsfile version` lines.
