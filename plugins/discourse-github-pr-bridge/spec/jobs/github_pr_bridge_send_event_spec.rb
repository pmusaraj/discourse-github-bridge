# frozen_string_literal: true

RSpec.describe Jobs::GithubPrBridgeSendEvent do
  fab!(:topic)
  fab!(:post) { Fabricate(:post, topic: topic, post_number: 2) }

  before do
    SiteSetting.github_pr_bridge_enabled = true
    SiteSetting.github_pr_bridge_service_url =
      "http://bridge.example/discourse/events"
    SiteSetting.github_pr_bridge_shared_secret = "secret"
  end

  it "sends payloads enqueued with string keys and records the GitHub comment mapping" do
    mapping =
      GithubPrBridge::PrTopicMapping.create!(
        github_repo: "discourse/discourse",
        github_pr_number: 123,
        topic: topic
      )
    payload = {
      "event_type" => "discourse_post_created",
      "event_id" => "discourse-post-#{post.id}",
      "post_id" => post.id,
      "topic_id" => topic.id,
      "github_repo" => "discourse/discourse",
      "github_pr_number" => 123,
      "raw" => "Hello from Discourse"
    }
    result =
      Excon::Response.new(status: 201, body: { github_comment_id: 789 }.to_json)

    GithubPrBridge::HttpClient
      .expects(:post_event)
      .with(payload)
      .returns(result)

    described_class.new.execute("payload" => payload)

    comment_mapping = GithubPrBridge::CommentMapping.find_by!(post_id: post.id)
    expect(comment_mapping.pr_topic_mapping).to eq(mapping)
    expect(comment_mapping.github_comment_id).to eq(789)
    expect(comment_mapping.source).to eq("discourse")
  end
end
