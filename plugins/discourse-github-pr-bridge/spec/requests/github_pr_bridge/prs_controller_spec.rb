# frozen_string_literal: true

RSpec.describe GithubPrBridge::PrsController do
  fab!(:category)
  fab!(:bridge_topic) do
    Fabricate(:topic, category: category, bumped_at: 1.hour.ago)
  end
  fab!(:normal_topic) do
    Fabricate(:topic, category: category, bumped_at: 5.minutes.ago)
  end

  before do
    SiteSetting.github_pr_bridge_enabled = true
    SiteSetting.github_pr_bridge_category_id = category.id

    GithubPrBridge::PrTopicMapping.create!(
      github_repo: "discourse/discourse",
      github_pr_number: 123,
      github_pr_node_id: "PR_kwDO123",
      github_pr_url: "https://github.com/discourse/discourse/pull/123",
      github_pr_head_sha: "abc123",
      github_pr_state: "open",
      github_pr_draft: false,
      github_pr_merged: false,
      github_pr_review_state: "approved",
      github_pr_checks_state: "success",
      github_pr_recent_activity_at: Time.zone.parse("2026-06-29 12:00:00 UTC"),
      github_pr_recent_activity_summary: "checks passed",
      topic: bridge_topic
    )
  end

  describe "#index" do
    it "returns only GitHub PR bridge topics" do
      get "/github-pr-bridge/prs.json"

      expect(response.status).to eq(200)
      topic_ids =
        response
          .parsed_body
          .dig("topic_list", "topics")
          .map { |topic| topic["id"] }

      expect(topic_ids).to include(bridge_topic.id)
      expect(topic_ids).not_to include(normal_topic.id)
    end

    it "includes topic-list PR status metadata" do
      get "/github-pr-bridge/prs.json"

      bridge_json =
        response
          .parsed_body
          .dig("topic_list", "topics")
          .find { |topic| topic["id"] == bridge_topic.id }

      expect(bridge_json["github_pr_bridge_status"]).to include(
        "github_repo" => "discourse/discourse",
        "github_pr_number" => 123,
        "github_pr_checks_state" => "success",
        "github_pr_review_state" => "approved"
      )
    end

    it "serves the dashboard shell at the public route" do
      get "/github-prs"

      expect(response.status).to eq(200)
    end

    it "is disabled when the bridge is disabled" do
      SiteSetting.github_pr_bridge_enabled = false

      get "/github-pr-bridge/prs.json"

      expect(response.status).to eq(404)
    end
  end
end
