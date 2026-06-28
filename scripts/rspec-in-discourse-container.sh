#!/usr/bin/env bash
set -euo pipefail

container="${DISCOURSE_CONTAINER:-discourse-docker-web-1}"
plugin_path="/var/www/discourse/plugins/discourse-github-pr-bridge"

if ! docker exec "${container}" sh -lc 'timeout 2 bash -lc "</dev/tcp/127.0.0.1/6379"' >/dev/null 2>&1; then
  docker exec -d "${container}" sh -lc \
    'exec socat TCP-LISTEN:6379,fork,reuseaddr,bind=127.0.0.1 TCP:${DISCOURSE_REDIS_HOST:-redis}:${DISCOURSE_REDIS_PORT:-6379}'
fi

docker exec -u discourse "${container}" sh -lc \
  "cd /var/www/discourse && RAILS_ENV=test LOAD_PLUGINS=1 bin/rake db:migrate >/dev/null"

spec_args=("$@")
if [[ ${#spec_args[@]} -eq 0 ]]; then
  spec_args=("${plugin_path}/spec")
fi
printf -v quoted_spec_args " %q" "${spec_args[@]}"

docker exec -u discourse "${container}" sh -lc \
  "cd /var/www/discourse && RAILS_ENV=test LOAD_PLUGINS=1 bin/rspec${quoted_spec_args}"
