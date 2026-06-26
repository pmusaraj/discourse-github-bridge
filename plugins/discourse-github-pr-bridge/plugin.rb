# frozen_string_literal: true

# name: discourse-github-pr-bridge
# about: Mirrors GitHub pull requests into Discourse topics.
# version: 0.1
# authors: Penar Musaraj

enabled_site_setting :github_pr_bridge_enabled

module ::GithubPrBridge
  PLUGIN_NAME = "discourse-github-pr-bridge"
end

require_relative "lib/github_pr_bridge/signature"
require_relative "lib/github_pr_bridge/event_processor"

after_initialize do
  require_relative "app/models/github_pr_bridge/pr_topic_mapping"
  require_relative "app/models/github_pr_bridge/processed_event"
  require_relative "app/controllers/github_pr_bridge/events_controller"

  Discourse::Application.routes.append do
    post "/github-pr-bridge/events" => "github_pr_bridge/events#create"
  end
end
