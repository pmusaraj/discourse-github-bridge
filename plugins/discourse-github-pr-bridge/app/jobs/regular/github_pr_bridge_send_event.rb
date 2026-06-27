# frozen_string_literal: true

require "json"

module Jobs
  class GithubPrBridgeSendEvent < ::Jobs::Base
    sidekiq_options retry: 3

    def execute(args)
      payload = args[:payload] || args["payload"]

      return if !SiteSetting.github_pr_bridge_enabled?
      return if payload.blank?
      return if SiteSetting.github_pr_bridge_service_url.blank?
      return if SiteSetting.github_pr_bridge_shared_secret.blank?

      result = GithubPrBridge::HttpClient.post_event(payload)

      if result.status < 200 || result.status >= 300
        Rails.logger.warn(
          "GitHub PR bridge event failed with HTTP #{result.status}"
        )
        return
      end

      record_comment_correlation(payload, result)
    end

    private

    def record_comment_correlation(payload, result)
      if payload[:event_type].to_s != "discourse_post_created" &&
           payload["event_type"].to_s != "discourse_post_created"
        return
      end

      github_comment_id = JSON.parse(result.body)["github_comment_id"]
      return if github_comment_id.blank?

      mapping =
        GithubPrBridge::PrTopicMapping.find_by(
          github_repo: payload[:github_repo] || payload["github_repo"],
          github_pr_number:
            payload[:github_pr_number] || payload["github_pr_number"]
        )
      return if mapping.blank?

      GithubPrBridge::CommentMapping.find_or_create_by!(
        post_id: payload[:post_id] || payload["post_id"]
      ) do |comment_mapping|
        comment_mapping.pr_topic_mapping = mapping
        comment_mapping.github_comment_id = github_comment_id
        comment_mapping.source = "discourse"
      end
    rescue JSON::ParserError
      Rails.logger.warn("GitHub PR bridge event response had invalid JSON")
    end
  end
end
