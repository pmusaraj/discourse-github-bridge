# frozen_string_literal: true

class AddTopicListStatusFieldsToGithubPrBridgePrTopicMappings < ActiveRecord::Migration[
  8.0
]
  def change
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_draft,
               :boolean,
               default: false,
               null: false
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_merged,
               :boolean,
               default: false,
               null: false
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_review_state,
               :string
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_checks_state,
               :string
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_recent_activity_at,
               :datetime
    add_column :github_pr_bridge_pr_topic_mappings,
               :github_pr_recent_activity_summary,
               :string
  end
end
