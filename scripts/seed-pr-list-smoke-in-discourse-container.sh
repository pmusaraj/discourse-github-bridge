#!/usr/bin/env bash
set -euo pipefail

container="${DISCOURSE_CONTAINER:-discourse-docker-web-1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="${repo_root}/scripts/seed-pr-list-smoke.rb"
container_script="/tmp/discourse-github-pr-bridge-seed-pr-list-smoke.rb"

docker cp "${script_path}" "${container}:${container_script}"
docker exec "${container}" chmod 0644 "${container_script}"
docker exec -u discourse "${container}" sh -lc \
  "cd /var/www/discourse && RAILS_ENV=development LOAD_PLUGINS=1 bin/rails runner ${container_script}"
