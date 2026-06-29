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
require_relative "lib/github_pr_bridge/http_client"
require_relative "lib/github_pr_bridge/outbound_post_payload"
require_relative "lib/github_pr_bridge/event_processor"

after_initialize do
  require_relative "app/models/github_pr_bridge/pr_topic_mapping"
  require_relative "app/models/github_pr_bridge/processed_event"
  require_relative "app/models/github_pr_bridge/comment_mapping"
  require_relative "app/jobs/regular/github_pr_bridge_send_event"
  require_relative "app/controllers/github_pr_bridge/events_controller"

  Discourse::Application.routes.append do
    post "/github-pr-bridge/events" => "github_pr_bridge/events#create"
  end

  add_to_serializer(
    :topic_list_item,
    :github_pr_bridge_status,
    include_condition: -> do
      GithubPrBridge::PrTopicMapping.exists?(topic_id: object.id)
    end
  ) do
    GithubPrBridge::PrTopicMapping.find_by(topic_id: object.id)&.status_payload
  end

  on(:post_created) do |post|
    next if !SiteSetting.github_pr_bridge_enabled?

    payload = GithubPrBridge::OutboundPostPayload.call(post)
    if payload.present?
      Jobs.enqueue(:github_pr_bridge_send_event, payload: payload)
    end
  end
end
