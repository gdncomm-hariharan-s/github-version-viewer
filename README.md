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
server.js           Express entrypoint — static/json middleware, mounts routes/, listen
lib/config.js        Env vars, env/branch config, shared constants
lib/github.js         GitHub REST + GraphQL client, in-memory cache (ghCache)
lib/versions.js       image.tag / Jenkinsfile version + restart-tag regex extract/replace
lib/cache.js          Route-level response cache (routeCache/cachedRoute)
lib/compare.js         Business logic: buildVersionsCompare, buildReleasePrs
lib/jira.js           Jira ADF document helpers (CRF update)
routes/*.js         One Express router per feature area, mounted via routes/index.js
public/index.html   Main comparison dashboard
public/detail.html  Per-file commit history view
public/release.html Release PR summary page
```

No build step — plain Tailwind CSS via the Play CDN, vanilla JS, no frontend framework.

## Performance

Two caches keep this app well under GitHub's rate limits:

- **`ghCache`** (`lib/github.js`) — 60s TTL cache in front of every raw GitHub REST call (`GH_CACHE_TTL_MS`).
- **`routeCache`** (`lib/cache.js`) — 60s TTL cache in front of the two expensive aggregate endpoints (`/api/versions/compare`, `/api/release-prs`), so a page full of viewers shares one upstream fetch.

The homepage's `/api/versions/compare` also fetches all repos' file content + build status via a **batched GraphQL query** (`fetchFileAndStatusBatch`) instead of one REST call per env per repo — this cut it from ~298 REST calls down to 4 REST + a handful of GraphQL requests (GraphQL has its own separate ~5000/hr point budget from REST's "core" bucket).

Measured cold-cache cost per endpoint (direct in-process instrumentation, not the noisy `/rate_limit` endpoint — see caveat below):

| Endpoint | Trigger | Cold REST calls | Cold GraphQL | Cold latency | Warm |
|---|---|---|---|---|---|
| `/api/versions/compare` | homepage load | 4 | 6 batched requests | ~9-12s | ~2ms (route cache) |
| `/api/release-prs` | release.html load | **34** (scales with # prod repos) | 0 | ~2-3s | ~2ms (route cache) |
| `/api/build-status` | pending-build poll tick | 1 | 0 | ~500-700ms | always live by design |
| `/api/deploy-options` | open/close deploy modal | **21** (10 commits × 2 calls + 1 list) | 0 | ~1.6-1.8s | ~2ms if within 60s gh-cache |
| `/api/file-history` | detail.html load | **21** (same code path) | 0 | ~1.8s | ~2ms if within 60s gh-cache |
| `/api/refresh-version` | manual per-service refresh | 2 | 0 | ~800-900ms | always live by design |

`/api/deploy`, `/api/reset`, `/api/jira/update-crf` weren't load-tested live (they write real commits/PRs) — by code inspection they cost 2 REST calls for a direct commit (non-prod) or 5 for a PR (prod).

**Known unoptimized hotspots** (candidates for the same GraphQL-batching treatment applied to `versions/compare`):
1. `release-prs` — one `fetchRecentPrs` REST call per prod repo, unbatched; scales linearly as repos grow.
2. `deploy-options` / `file-history` (`fetchFileHistory`) — fetches content *and* build status for all 10 commits in the history, even though only the newest commit's status is usually shown/used.

**Verification caveat**: GitHub's `/rate_limit` endpoint is exempt from rate limiting and always reports fresh/full values — it does *not* reflect real "core" bucket consumption. Always read `x-ratelimit-used`/`x-ratelimit-remaining` off a real request instead. Also avoid probing with a malformed endpoint (e.g. `/repos/<org>` with no repo name) — GitHub's edge appears to cache the resulting 404, freezing the rate-limit header at a stale value.

## Notes

- Access is intended to be restricted to the internal VPN/network; there is no authentication built into the app itself.
- Version edits use regex-based patching of YAML/Groovy text rather than a full YAML parser, so they only support the `image:\n  tag:` pattern and known `Jenkinsfile version` lines.
