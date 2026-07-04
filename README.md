# Discourse GitHub PR Bridge

A split bridge for mirroring GitHub pull requests into Discourse topics.

- `plugins/discourse-github-pr-bridge`: Discourse plugin that owns PR/topic mappings and signed bridge endpoints.
- `github-service`: External GitHub webhook/service process that normalizes GitHub events and signs requests into Discourse.

## Testing

When testing against the local Discourse Docker container, run:

```sh
scripts/rspec-in-discourse-container.sh
```

The helper starts a localhost Redis forwarder inside the web container when needed, migrates the test database, and then runs the plugin RSpec suite. Pass a spec path to run a focused file:

```sh
scripts/rspec-in-discourse-container.sh plugins/discourse-github-pr-bridge/spec/services/github_pr_bridge/event_processor_spec.rb
```

## Local PR-list smoke fixtures

To seed deterministic local topics for checking `/latest` or the smoke category topic
list, run:

```sh
scripts/seed-pr-list-smoke-in-discourse-container.sh
```

The smoke data uses the synthetic `discourse/pr-list-smoke` repo and creates four
PR topics covering passing/approved, failing/changes-requested, draft/pending,
and merged states with labels and recent-activity summaries. Re-running the
script updates the same topics and mappings idempotently.

## PR dashboard

The plugin adds `/github-prs`, a filtered dashboard route that lists only topics
with GitHub PR bridge mappings. The compact PR status column and PR metadata line
are scoped to this dashboard route so normal Discourse topic lists remain
unchanged.

## GitHub App installation flow

Manual repository webhooks are useful for local development, but production
multi-repository use should use a GitHub App:

1. Create a GitHub App with the manifest/setup endpoint or fill the app fields
   manually from `GET /github/app/manifest`.
2. Configure the app webhook URL to the public bridge-service
   `/github/webhook` URL and use the same `GITHUB_WEBHOOK_SECRET` configured in
   the service.
3. Grant repository permissions: checks read, contents read, issues write,
   metadata read, pull requests write, and commit statuses read.
4. Subscribe to events: check run, check suite, installation, installation
   repositories, issue comment, pull request, pull request review, push, and
   status.
5. Install the app on the selected repositories.
6. Configure the service with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or
   `GITHUB_APP_PRIVATE_KEY_PATH`, and `GITHUB_APP_INSTALLATIONS_PATH`.
7. Verify captured or synced installations with
   `GET /github/app/installations`.

The service records installation IDs and selected repositories in durable
storage keyed by GitHub owner/repo full name, then uses installation access
tokens for GitHub API calls instead of a single user-scoped `GITHUB_TOKEN`.
Reverse-sync comments use the issues comments API for PR conversations; the app
needs pull request write permission in addition to issues write permission to
avoid GitHub `Resource not accessible by integration` responses on PR comments.
Mirrored PR topics stay in the single configured Discourse category and include
the repository in the topic title prefix, e.g. `[owner/repo] PR #123: Title`.
The plugin mapping model remains keyed by `github_repo` + `github_pr_number`.

If the app is installed but `GET /github/app/installations` does not show the
repo, run a manual reconciliation:

```sh
curl -X POST \
  -H "x-github-pr-bridge-admin-secret: $DISCOURSE_SHARED_SECRET" \
  "$SERVICE_BASE_URL/github/app/installations/sync"
```

The service also attempts this reconciliation on startup when GitHub App
credentials and `GITHUB_APP_INSTALLATIONS_PATH` are configured. Set
`GITHUB_APP_SYNC_ON_START=false` to disable startup sync.

## GitHub service

The service exposes:

- `GET /health`
- `GET /github/app/setup` to return a GitHub App creation URL plus manifest
- `GET /github/app/manifest` to inspect the manifest JSON directly
- `GET /github/app/installations` to inspect captured GitHub App repository mappings
- `POST /github/app/installations/sync` to reconcile installation mappings from GitHub
  using the `x-github-pr-bridge-admin-secret` header
- `POST /github/webhook` for GitHub-originated webhooks, including GitHub App
  `installation` and `installation_repositories` events
- `POST /discourse/events` for signed Discourse-originated events that should call GitHub

Required environment variables:

- `GITHUB_WEBHOOK_SECRET`: GitHub webhook secret used to verify `X-Hub-Signature-256`.
- `GITHUB_TOKEN`: optional GitHub token used to create PR issue comments for Discourse replies.
  If omitted, configure GitHub App credentials below.
- `GITHUB_APP_ID`: optional GitHub App ID used when `GITHUB_TOKEN` is not set.
- `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`: optional GitHub App private key.
  `GITHUB_APP_PRIVATE_KEY` may contain escaped `\n` sequences.
- `GITHUB_APP_INSTALLATIONS_PATH`: optional JSON file populated from GitHub App
  `installation` and `installation_repositories` webhooks or reconciliation sync.
  It maps repositories to GitHub App installation IDs, for example
  `{ "repositories": { "owner/repo": 12345 } }`. Repository keys are
  case-insensitive.
- `GITHUB_APP_SYNC_ON_START`: optional, defaults to `true`. When GitHub App
  credentials and `GITHUB_APP_INSTALLATIONS_PATH` are configured, reconcile
  installed repositories from GitHub on service startup.
- `GITHUB_APP_NAME`: optional display name for the generated GitHub App manifest.
- `GITHUB_APP_OWNER`: optional GitHub organization login for the setup URL. If omitted,
  the setup URL creates a user-owned app.
- `SERVICE_BASE_URL`: optional public base URL for this service. The manifest uses it
  for the webhook URL; if omitted, the service derives it from forwarded request headers.
- `DISCOURSE_BASE_URL`: Base URL for the Discourse site, for example `https://forum.example.com`.
- `DISCOURSE_SHARED_SECRET`: Shared secret that matches the Discourse `github_pr_bridge_shared_secret` site setting.
- `PORT`: optional, defaults to `3000`.
- `PROCESSED_EVENTS_PATH`: optional JSONL path for durable Discourse-originated event idempotency. If omitted, duplicate protection is in-memory only and resets when the service restarts.
- `RETRY_ATTEMPTS`: optional total attempt count for transient Discourse forwarding failures, defaults to `3`.
- `RETRY_DELAY_MS`: optional initial retry delay in milliseconds, defaults to `500` and uses exponential backoff. GitHub comment creation is not retried because the GitHub API call is not idempotent.

Run locally:

```sh
cd github-service
npm start
```
