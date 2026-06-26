# frozen_string_literal: true

module GithubPrBridge
  class CommentMapping < ::ActiveRecord::Base
    self.table_name = "github_pr_bridge_comment_mappings"

    belongs_to :pr_topic_mapping
    belongs_to :post

    validates :pr_topic_mapping_id, presence: true
    validates :post_id, presence: true, uniqueness: true
    validates :github_comment_id, presence: true, uniqueness: true
    validates :source, presence: true, inclusion: { in: %w[discourse github] }
  end
end
