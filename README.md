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

## GitHub service

The service exposes:

- `GET /health`
- `POST /github/webhook` for GitHub-originated webhooks
- `POST /discourse/events` for signed Discourse-originated events that should call GitHub

Required environment variables:

- `GITHUB_WEBHOOK_SECRET`: GitHub webhook secret used to verify `X-Hub-Signature-256`.
- `GITHUB_TOKEN`: GitHub token used to create PR issue comments for Discourse replies.
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
