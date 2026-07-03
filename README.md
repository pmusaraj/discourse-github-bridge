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

## GitHub App installation flow plan

Manual repository webhooks are useful for local development, but production
multi-repository use should move to a GitHub App:

1. Use the external service's GitHub App manifest/setup endpoints to create the
   app with the right permissions and webhook events.
2. Store installation IDs and selected repositories in service-side durable
   storage, keyed by GitHub owner/repo full name.
3. Use installation access tokens for GitHub API calls instead of a single
   user-scoped `GITHUB_TOKEN`.
4. Keep all mirrored PR topics in the single configured Discourse category.
5. Preserve the repository in the topic title prefix, e.g.
   `[owner/repo] PR #123: Title`. Optional repo tags can be added later for
   filtering, but the title prefix is enough for the first multi-repo pass.
6. Forward the same normalized event shape to Discourse so the plugin mapping
   model remains keyed by `github_repo` + `github_pr_number`.

## GitHub service

The service exposes:

- `GET /health`
- `GET /github/app/setup` to return a GitHub App creation URL plus manifest
- `GET /github/app/manifest` to inspect the manifest JSON directly
- `GET /github/app/installations` to inspect captured GitHub App repository mappings
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
  `installation` and `installation_repositories` webhooks. It maps repositories to
  GitHub App installation IDs, for example `{ "repositories": { "owner/repo": 12345 } }`.
  Repository keys are case-insensitive.
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

This is an edit
