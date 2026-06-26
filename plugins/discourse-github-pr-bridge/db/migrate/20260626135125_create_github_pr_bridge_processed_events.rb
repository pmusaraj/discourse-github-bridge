# frozen_string_literal: true

class CreateGithubPrBridgeProcessedEvents < ActiveRecord::Migration[8.0]
  def change
    create_table :github_pr_bridge_processed_events do |table|
      table.string :event_id, null: false
      table.string :event_type, null: false
      table.timestamps null: false
    end

    add_index :github_pr_bridge_processed_events,
              :event_id,
              unique: true,
              name: "idx_github_pr_bridge_events_event_id"
  end
end
