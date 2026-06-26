# Discourse GitHub PR Bridge

A split bridge for mirroring GitHub pull requests into Discourse topics.

- `plugins/discourse-github-pr-bridge`: Discourse plugin that owns PR/topic mappings and signed bridge endpoints.
- `github-service`: External GitHub webhook/service process that will normalize GitHub events and sign requests into Discourse.

This repository follows the planned architecture in `/Users/pmusaraj/Projects/discourse-github-pr-bridge-plan.md`.
