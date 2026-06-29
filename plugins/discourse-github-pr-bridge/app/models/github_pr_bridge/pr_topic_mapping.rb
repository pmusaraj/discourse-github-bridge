# frozen_string_literal: true

module GithubPrBridge
  class PrTopicMapping < ::ActiveRecord::Base
    self.table_name = "github_pr_bridge_pr_topic_mappings"

    belongs_to :topic

    validates :github_repo, presence: true
    validates :github_pr_number, presence: true
    validates :topic_id, presence: true
    validates :github_repo, uniqueness: { scope: :github_pr_number }

    def status_payload
      {
        github_repo: github_repo,
        github_pr_number: github_pr_number,
        github_pr_url: github_pr_url,
        github_pr_state: github_pr_state,
        github_pr_draft: github_pr_draft,
        github_pr_merged: github_pr_merged,
        github_pr_review_state: github_pr_review_state,
        github_pr_checks_state: github_pr_checks_state,
        github_pr_recent_activity_at: github_pr_recent_activity_at&.iso8601(3),
        github_pr_recent_activity_summary: github_pr_recent_activity_summary
      }
    end
  end
end
