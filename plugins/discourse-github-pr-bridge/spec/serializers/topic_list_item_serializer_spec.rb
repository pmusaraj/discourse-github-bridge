# frozen_string_literal: true

RSpec.describe TopicListItemSerializer do
  fab!(:category)
  fab!(:topic) { Fabricate(:topic, category: category) }

  before { SiteSetting.github_pr_bridge_enabled = true }

  it "includes GitHub PR bridge status for mapped topics only" do
    normal_json =
      described_class.new(topic, scope: Guardian.new, root: false).as_json
    expect(normal_json[:github_pr_bridge_status]).to be_nil

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
      topic: topic
    )

    bridge_json =
      described_class.new(topic, scope: Guardian.new, root: false).as_json
    expect(bridge_json[:github_pr_bridge_status]).to eq(
      github_repo: "discourse/discourse",
      github_pr_number: 123,
      github_pr_url: "https://github.com/discourse/discourse/pull/123",
      github_pr_state: "open",
      github_pr_draft: false,
      github_pr_merged: false,
      github_pr_review_state: "approved",
      github_pr_checks_state: "success",
      github_pr_recent_activity_at: "2026-06-29T12:00:00.000Z",
      github_pr_recent_activity_summary: "checks passed"
    )
  end
end
