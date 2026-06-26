# frozen_string_literal: true

module GithubPrBridge
  class PrTopicMapping < ::ActiveRecord::Base
    self.table_name = "github_pr_bridge_pr_topic_mappings"

    belongs_to :topic

    validates :github_repo, presence: true
    validates :github_pr_number, presence: true
    validates :topic_id, presence: true
    validates :github_repo, uniqueness: { scope: :github_pr_number }
  end
end
