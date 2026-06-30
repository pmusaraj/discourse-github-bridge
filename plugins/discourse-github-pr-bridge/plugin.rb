# frozen_string_literal: true

# name: discourse-github-pr-bridge
# about: Mirrors GitHub pull requests into Discourse topics.
# version: 0.1
# authors: Penar Musaraj

enabled_site_setting :github_pr_bridge_enabled
register_asset "stylesheets/common/github-pr-bridge-topic-list-status.scss"

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
  require_relative "app/controllers/github_pr_bridge/prs_controller"

  TopicQuery.add_custom_filter(:github_pr_bridge) do |results, topic_query|
    if topic_query.options[:github_pr_bridge].to_s == "true"
      results.joins(
        "INNER JOIN github_pr_bridge_pr_topic_mappings " \
          "ON github_pr_bridge_pr_topic_mappings.topic_id = topics.id"
      )
    else
      results
    end
  end

  Discourse::Application.routes.append do
    post "/github-pr-bridge/events" => "github_pr_bridge/events#create"
    get "/github-pr-bridge/prs" => "github_pr_bridge/prs#index"
    get "/github-prs" => "github_pr_bridge/prs#index"
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
