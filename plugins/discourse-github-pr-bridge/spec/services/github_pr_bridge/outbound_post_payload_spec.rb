# frozen_string_literal: true

RSpec.describe GithubPrBridge::OutboundPostPayload do
  fab!(:user)
  fab!(:category)
  fab!(:topic) { Fabricate(:topic, category: category) }
  fab!(:post) do
    Fabricate(
      :post,
      topic: topic,
      user: user,
      post_number: 2,
      raw: "I have a question"
    )
  end

  it "builds a GitHub issue comment payload for replies in mapped pull request topics" do
    GithubPrBridge::PrTopicMapping.create!(
      github_repo: "discourse/discourse",
      github_pr_number: 123,
      topic: topic
    )

    payload = described_class.call(post)

    expect(payload).to include(
      event_type: "discourse_post_created",
      event_id: "discourse-post-#{post.id}",
      post_id: post.id,
      topic_id: topic.id,
      github_repo: "discourse/discourse",
      github_pr_number: 123,
      author_username: user.username
    )
    expect(payload[:raw]).to include("I have a question")
    expect(payload[:raw]).to include("via Discourse by @#{user.username}")
  end

  it "ignores topic OPs, unmapped topics, system posts, and already mapped comments" do
    mapping =
      GithubPrBridge::PrTopicMapping.create!(
        github_repo: "discourse/discourse",
        github_pr_number: 123,
        topic: topic
      )
    op = Fabricate(:post, topic: topic, user: user, post_number: 1)
    unmapped_topic_post = Fabricate(:post, user: user, post_number: 2)
    system_post =
      Fabricate(
        :post,
        topic: topic,
        user: Discourse.system_user,
        post_number: 3
      )

    GithubPrBridge::CommentMapping.create!(
      pr_topic_mapping: mapping,
      post: post,
      github_comment_id: 456,
      source: "github"
    )

    expect(described_class.call(op)).to be_nil
    expect(described_class.call(unmapped_topic_post)).to be_nil
    expect(described_class.call(system_post)).to be_nil
    expect(described_class.call(post)).to be_nil
  end
end
