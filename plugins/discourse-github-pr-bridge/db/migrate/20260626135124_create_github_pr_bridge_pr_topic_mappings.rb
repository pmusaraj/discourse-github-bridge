# frozen_string_literal: true

class CreateGithubPrBridgePrTopicMappings < ActiveRecord::Migration[8.0]
  def change
    create_table :github_pr_bridge_pr_topic_mappings do |table|
      table.string :github_repo, null: false
      table.integer :github_pr_number, null: false
      table.string :github_pr_node_id
      table.string :github_pr_url
      table.string :github_pr_head_sha
      table.string :github_pr_state
      table.integer :topic_id, null: false
      table.timestamps null: false
    end

    add_index :github_pr_bridge_pr_topic_mappings,
              %i[github_repo github_pr_number],
              unique: true,
              name: "idx_github_pr_bridge_mappings_repo_pr"
    add_index :github_pr_bridge_pr_topic_mappings, :topic_id
  end
end
