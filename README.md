# Discourse GitHub PR Bridge

A split bridge for mirroring GitHub pull requests into Discourse topics.

- `plugins/discourse-github-pr-bridge`: Discourse plugin that owns PR/topic mappings and signed bridge endpoints.
- `github-service`: External GitHub webhook/service process that normalizes GitHub events and signs requests into Discourse.

This repository follows the planned architecture in `/Users/pmusaraj/Projects/discourse-github-pr-bridge-plan.md`.

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

Run locally:

```sh
cd github-service
npm start
```
