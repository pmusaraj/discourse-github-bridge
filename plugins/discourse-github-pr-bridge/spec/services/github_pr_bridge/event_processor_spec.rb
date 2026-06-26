# frozen_string_literal: true

RSpec.describe GithubPrBridge::EventProcessor do
  fab!(:category)

  before { SiteSetting.github_pr_bridge_category_id = category.id }

  it "creates and updates a topic for a pull request" do
    opened_payload =
      pull_request_payload(event_id: "delivery-1", title: "Add feature")

    result = described_class.call(opened_payload)

    expect(result[:action]).to eq("created_topic")
    topic = Topic.find(result[:topic_id])
    expect(topic.title).to eq("[discourse/discourse] PR #123: Add feature")
    expect(topic.first_post.raw).to include(
      "**GitHub PR:** [discourse/discourse#123]"
    )

    updated_payload =
      pull_request_payload(event_id: "delivery-2", title: "Add better feature")
    updated_result = described_class.call(updated_payload)

    expect(updated_result[:action]).to eq("updated_topic")
    expect(updated_result[:topic_id]).to eq(topic.id)
    expect(topic.reload.title).to eq(
      "[discourse/discourse] PR #123: Add better feature"
    )
    expect(GithubPrBridge::PrTopicMapping.count).to eq(1)
  end

  it "deduplicates replayed events" do
    payload = pull_request_payload(event_id: "delivery-1", title: "Add feature")

    described_class.call(payload)
    result = described_class.call(payload)

    expect(result).to eq(ok: true, duplicate: true)
    expect(GithubPrBridge::PrTopicMapping.count).to eq(1)
  end

  it "creates a reply for a GitHub issue comment on a mapped pull request" do
    created_topic =
      described_class.call(
        pull_request_payload(event_id: "delivery-1", title: "Add feature")
      )

    result = described_class.call(issue_comment_payload)

    expect(result[:action]).to eq("created_reply")
    expect(result[:topic_id]).to eq(created_topic[:topic_id])
    expect(Post.find(result[:post_id]).raw).to include("Looks good")
    expect(
      GithubPrBridge::CommentMapping.find_by(github_comment_id: 987).post_id
    ).to eq(result[:post_id])
  end

  it "skips issue comments that already map to a Discourse post" do
    described_class.call(
      pull_request_payload(event_id: "delivery-1", title: "Add feature")
    )
    described_class.call(issue_comment_payload)

    result =
      described_class.call(
        issue_comment_payload.merge("event_id" => "delivery-4")
      )

    expect(result[:action]).to eq("skipped_mapped_comment")
  end

  def pull_request_payload(event_id:, title:)
    {
      "event_id" => event_id,
      "event_type" => "pull_request",
      "repository" => {
        "full_name" => "discourse/discourse"
      },
      "pull_request" => {
        "number" => 123,
        "node_id" => "PR_kwDO123",
        "html_url" => "https://github.com/discourse/discourse/pull/123",
        "title" => title,
        "body" => "This adds a feature.",
        "state" => "open",
        "merged" => false,
        "user" => {
          "login" => "octocat"
        },
        "base" => {
          "ref" => "main"
        },
        "head" => {
          "ref" => "feature",
          "sha" => "abc123"
        },
        "labels" => [{ "name" => "feature" }]
      }
    }
  end

  def issue_comment_payload
    {
      "event_id" => "delivery-3",
      "event_type" => "issue_comment",
      "action" => "created",
      "repository" => {
        "full_name" => "discourse/discourse"
      },
      "issue" => {
        "number" => 123
      },
      "comment" => {
        "id" => 987,
        "body" => "Looks good",
        "html_url" =>
          "https://github.com/discourse/discourse/pull/123#issuecomment-1",
        "user" => {
          "login" => "reviewer"
        }
      }
    }
  end
end
