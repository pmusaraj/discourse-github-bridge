# frozen_string_literal: true

module GithubPrBridge
  class EventProcessor
    class InvalidPayload < StandardError
    end

    SUPPORTED_EVENTS = %w[pull_request issue_comment].freeze
    MANAGED_LABEL_TAGS_FIELD = "github_pr_bridge_label_tags"
    STATUS_ACTION_CODE = "github_pr_bridge_status_changed"

    def self.call(payload)
      new(payload).call
    end

    def initialize(payload)
      @payload = payload
    end

    def call
      validate_payload!

      DistributedMutex.synchronize(
        "github_pr_bridge_event_#{event_id}",
        validity: 1.minute
      ) do
        if ProcessedEvent.exists?(event_id: event_id)
          return { ok: true, duplicate: true }
        end

        result = process_event
        ProcessedEvent.create!(event_id: event_id, event_type: event_type)
        result.merge(ok: true)
      end
    rescue ActiveRecord::RecordNotUnique
      { ok: true, duplicate: true }
    end

    private

    attr_reader :payload

    def validate_payload!
      raise InvalidPayload, "missing event id" if event_id.blank?
      raise InvalidPayload, "missing event type" if event_type.blank?
      if !SUPPORTED_EVENTS.include?(event_type)
        raise InvalidPayload, "unsupported event type"
      end
    end

    def process_event
      case event_type
      when "pull_request"
        process_pull_request
      when "issue_comment"
        process_issue_comment
      end
    end

    def process_pull_request
      pr =
        payload.fetch("pull_request") do
          raise InvalidPayload, "missing pull_request"
        end
      repo =
        payload.fetch("repository") do
          raise InvalidPayload, "missing repository"
        end
      repo_full_name =
        repo.fetch("full_name") do
          raise InvalidPayload, "missing repository full_name"
        end
      number =
        pr.fetch("number") do
          raise InvalidPayload, "missing pull_request number"
        end

      mapping =
        PrTopicMapping.find_by(
          github_repo: repo_full_name,
          github_pr_number: number
        )

      if mapping
        previous_state = mapping.github_pr_state
        new_state = pr_state(pr)
        update_topic(mapping.topic, pr, repo_full_name)
        sync_topic_labels(mapping.topic, pr)
        add_status_small_action(mapping.topic, previous_state, new_state)
        mapping.update!(
          github_pr_node_id: pr["node_id"],
          github_pr_url: pr["html_url"],
          github_pr_head_sha: pr.dig("head", "sha"),
          github_pr_state: new_state
        )
        { topic_id: mapping.topic_id, action: "updated_topic" }
      else
        topic = create_topic(pr, repo_full_name)
        sync_topic_labels(topic, pr)
        PrTopicMapping.create!(
          github_repo: repo_full_name,
          github_pr_number: number,
          github_pr_node_id: pr["node_id"],
          github_pr_url: pr["html_url"],
          github_pr_head_sha: pr.dig("head", "sha"),
          github_pr_state: pr_state(pr),
          topic: topic
        )
        { topic_id: topic.id, action: "created_topic" }
      end
    end

    def process_issue_comment
      if payload["action"] != "created"
        raise InvalidPayload, "unsupported issue_comment action"
      end

      comment =
        payload.fetch("comment") { raise InvalidPayload, "missing comment" }
      issue = payload.fetch("issue") { raise InvalidPayload, "missing issue" }
      repo =
        payload.fetch("repository") do
          raise InvalidPayload, "missing repository"
        end
      repo_full_name =
        repo.fetch("full_name") do
          raise InvalidPayload, "missing repository full_name"
        end
      number =
        issue.fetch("number") { raise InvalidPayload, "missing issue number" }
      mapping =
        PrTopicMapping.find_by(
          github_repo: repo_full_name,
          github_pr_number: number
        )
      raise InvalidPayload, "unmapped pull request" if mapping.blank?

      github_comment_id = comment["id"]
      if github_comment_id.present?
        return(
          process_issue_comment_with_github_id(
            mapping,
            comment,
            github_comment_id
          )
        )
      end

      post = create_issue_comment_post(mapping, comment)
      { topic_id: mapping.topic_id, post_id: post.id, action: "created_reply" }
    end

    def process_issue_comment_with_github_id(
      mapping,
      comment,
      github_comment_id
    )
      DistributedMutex.synchronize(
        "github_pr_bridge_comment_#{github_comment_id}",
        validity: 1.minute
      ) do
        if CommentMapping.exists?(github_comment_id: github_comment_id)
          return(
            { topic_id: mapping.topic_id, action: "skipped_mapped_comment" }
          )
        end

        post = create_issue_comment_post(mapping, comment)
        CommentMapping.create!(
          pr_topic_mapping: mapping,
          post: post,
          github_comment_id: github_comment_id,
          source: "github"
        )

        {
          topic_id: mapping.topic_id,
          post_id: post.id,
          action: "created_reply"
        }
      end
    rescue ActiveRecord::RecordNotUnique
      { topic_id: mapping.topic_id, action: "skipped_mapped_comment" }
    end

    def create_issue_comment_post(mapping, comment)
      raw = <<~MD.strip
        #{comment["body"]}

        — [#{comment.dig("user", "login") || "GitHub user"} on GitHub](#{comment["html_url"]})
      MD

      PostCreator.create!(system_user, topic_id: mapping.topic_id, raw: raw)
    end

    def create_topic(pr, repo_full_name)
      PostCreator.create!(
        system_user,
        title: topic_title(pr, repo_full_name),
        raw: topic_raw(pr, repo_full_name),
        category: category_id
      ).topic
    end

    def update_topic(topic, pr, repo_full_name)
      topic.first_post.revise(
        system_user,
        title: topic_title(pr, repo_full_name),
        raw: topic_raw(pr, repo_full_name)
      )
    end

    def add_status_small_action(topic, previous_state, new_state)
      return if previous_state.blank? || new_state.blank?
      return if previous_state == new_state

      topic.add_moderator_post(
        system_user,
        "GitHub PR status changed from #{previous_state} to #{new_state}.",
        post_type: Post.types[:small_action],
        action_code: STATUS_ACTION_CODE
      )
    end

    def sync_topic_labels(topic, pr)
      return if !SiteSetting.tagging_enabled?

      previous_label_tags = managed_label_tags(topic)
      next_label_tags = label_tag_names(pr)
      current_tags = topic.tags.pluck(:name)
      desired_tags = (current_tags - previous_label_tags + next_label_tags).uniq

      if current_tags.sort == desired_tags.sort
        if previous_label_tags.sort != next_label_tags.sort
          save_managed_label_tags(topic, next_label_tags)
        end
        return
      end

      if !DiscourseTagging.tag_topic_by_names(
           topic,
           system_user.guardian,
           desired_tags
         )
        Rails.logger.warn(
          "GitHub PR bridge could not sync labels to Discourse tags: #{topic.errors.full_messages.join(", ")}"
        )
        return
      end

      local_tags = current_tags - previous_label_tags
      actual_label_tags = topic.reload.tags.pluck(:name) - local_tags
      save_managed_label_tags(topic, actual_label_tags)
    end

    def save_managed_label_tags(topic, tag_names)
      topic.custom_fields[MANAGED_LABEL_TAGS_FIELD] = tag_names.to_json
      topic.save_custom_fields(true)
    end

    def managed_label_tags(topic)
      raw_value = topic.custom_fields[MANAGED_LABEL_TAGS_FIELD]
      return [] if raw_value.blank?

      JSON.parse(raw_value)
    rescue JSON::ParserError
      []
    end

    def label_tag_names(pr)
      label_names =
        Array(pr["labels"]).filter_map { |label| label["name"].presence }
      return [] if label_names.blank?

      DiscourseTagging.tags_for_saving(label_names, system_user.guardian) || []
    end

    def topic_title(pr, repo_full_name)
      repo_label = safe_title_part(repo_full_name)
      prefix = "[#{repo_label}] PR ##{pr["number"]}: "
      max_length = SiteSetting.max_topic_title_length
      title_length = [max_length - prefix.length, 1].max
      title = safe_title_part(pr["title"])

      truncate_bytes(
        "#{prefix}#{title.truncate(title_length, omission: "...")}",
        max_length
      )
    end

    def topic_raw(pr, repo_full_name)
      labels =
        Array(pr["labels"]).map { |label| label["name"] }.join(", ").presence ||
          "None"

      <<~MD.strip
        #{pr["body"].presence || "No pull request description provided."}

        ---

        **GitHub PR:** [#{repo_full_name}##{pr["number"]}](#{pr["html_url"]})
        **Author:** #{pr.dig("user", "login") || "Unknown"}
        **State:** #{pr_state(pr)}
        **Draft:** #{yes_no(pr["draft"])}
        **Base:** #{pr.dig("base", "ref") || "unknown"}
        **Head:** #{pr.dig("head", "ref") || "unknown"}
        **Head SHA:** #{short_sha(pr.dig("head", "sha"))}
        **Commits:** #{metadata_value(pr["commits"])}
        **Changed files:** #{metadata_value(pr["changed_files"])}
        **Diff:** +#{metadata_value(pr["additions"])} / -#{metadata_value(pr["deletions"])}
        **Labels:** #{labels}
        **Updated:** #{metadata_value(pr["updated_at"])}
      MD
    end

    def pr_state(pr)
      return "merged" if pr["merged"]

      pr["state"].to_s
    end

    def yes_no(value)
      value ? "Yes" : "No"
    end

    def safe_title_part(value)
      value.to_s.gsub(/\S{40,}/, "[long token]")
    end

    def truncate_bytes(value, max_bytes)
      return value if value.bytesize <= max_bytes

      omission = "..."
      allowed_bytes = max_bytes - omission.bytesize
      truncated = +""
      value.each_char do |character|
        break if truncated.bytesize + character.bytesize > allowed_bytes

        truncated << character
      end
      "#{truncated}#{omission}"
    end

    def short_sha(value)
      value.present? ? value.to_s[0, 12] : "unknown"
    end

    def metadata_value(value)
      value.presence || "unknown"
    end

    def category_id
      category_id = SiteSetting.github_pr_bridge_category_id.to_i
      if category_id <= 0
        raise InvalidPayload, "bridge category is not configured"
      end

      category_id
    end

    def system_user
      Discourse.system_user
    end

    def event_type
      payload["event_type"].to_s
    end

    def event_id
      payload["event_id"].to_s
    end
  end
end
