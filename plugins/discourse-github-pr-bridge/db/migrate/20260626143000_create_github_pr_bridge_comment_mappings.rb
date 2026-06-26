# frozen_string_literal: true

class CreateGithubPrBridgeCommentMappings < ActiveRecord::Migration[8.0]
  def change
    create_table :github_pr_bridge_comment_mappings do |table|
      table.integer :pr_topic_mapping_id, null: false
      table.integer :post_id, null: false
      table.bigint :github_comment_id, null: false
      table.string :source, null: false
      table.timestamps null: false
    end

    add_index :github_pr_bridge_comment_mappings,
              :post_id,
              unique: true,
              name: "idx_github_pr_bridge_comments_post"
    add_index :github_pr_bridge_comment_mappings,
              :github_comment_id,
              unique: true,
              name: "idx_github_pr_bridge_comments_github_id"
    add_index :github_pr_bridge_comment_mappings,
              :pr_topic_mapping_id,
              name: "idx_github_pr_bridge_comments_pr_mapping"
  end
end
