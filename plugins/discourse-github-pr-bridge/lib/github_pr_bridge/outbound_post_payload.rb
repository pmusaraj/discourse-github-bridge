# frozen_string_literal: true

module GithubPrBridge
  class OutboundPostPayload
    def self.call(post)
      new(post).call
    end

    def initialize(post)
      @post = post
    end

    def call
      return if post.blank? || post.topic.blank?
      return if post.post_number == 1
      return if post.user_id == Discourse::SYSTEM_USER_ID
      return if CommentMapping.exists?(post_id: post.id)

      mapping = PrTopicMapping.find_by(topic_id: post.topic_id)
      return if mapping.blank?

      {
        event_type: "discourse_post_created",
        event_id: "discourse-post-#{post.id}",
        post_id: post.id,
        topic_id: post.topic_id,
        github_repo: mapping.github_repo,
        github_pr_number: mapping.github_pr_number,
        author_username: post.user&.username,
        post_url: post_url,
        raw: outbound_raw
      }
    end

    private

    attr_reader :post

    def outbound_raw
      <<~MD.strip
        #{post.raw}

        — via Discourse by @#{post.user&.username || "unknown"} (#{post_url})
      MD
    end

    def post_url
      "#{Discourse.base_url}#{post.url}"
    end
  end
end
