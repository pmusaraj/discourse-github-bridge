# frozen_string_literal: true

module GithubPrBridge
  class ProcessedEvent < ::ActiveRecord::Base
    self.table_name = "github_pr_bridge_processed_events"

    validates :event_id, presence: true, uniqueness: true
    validates :event_type, presence: true
  end
end
