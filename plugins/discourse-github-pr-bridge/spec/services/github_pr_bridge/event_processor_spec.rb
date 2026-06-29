# frozen_string_literal: true

RSpec.describe GithubPrBridge::EventProcessor do
  fab!(:category)

  before do
    SiteSetting.github_pr_bridge_category_id = category.id
    SiteSetting.tagging_enabled = true
    SiteSetting.create_tag_allowed_groups = Group::AUTO_GROUPS[:trust_level_0]
    SiteSetting.tag_topic_allowed_groups = Group::AUTO_GROUPS[:trust_level_0]
  end

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
    expect(topic.first_post.raw).to include("**Draft:** No")
    expect(topic.first_post.raw).to include("**Changed files:** 4")
    expect(topic.first_post.raw).to include("**Diff:** +10 / -2")
    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    expect(mapping.github_pr_state).to eq("open")
    expect(mapping.github_pr_draft).to eq(false)
    expect(mapping.github_pr_merged).to eq(false)
    expect(mapping.github_pr_recent_activity_summary).to eq("PR opened")

    updated_payload =
      pull_request_payload(event_id: "delivery-2", title: "Add better feature")
    updated_result = described_class.call(updated_payload)

    expect(updated_result[:action]).to eq("updated_topic")
    expect(updated_result[:topic_id]).to eq(topic.id)
    expect(topic.reload.title).to eq(
      "[discourse/discourse] PR #123: Add better feature"
    )
    expect(GithubPrBridge::PrTopicMapping.count).to eq(1)
    expect(topic.posts.where(post_type: Post.types[:small_action]).count).to eq(
      0
    )
  end

  it "truncates long pull request titles to fit Discourse topic limits" do
    long_title = "A" * 400

    result =
      described_class.call(
        pull_request_payload(event_id: "delivery-long-title", title: long_title)
      )
    topic = Topic.find(result[:topic_id])

    expect(topic.title.length).to be <= SiteSetting.max_topic_title_length
    expect(topic.title.bytesize).to be <= SiteSetting.max_topic_title_length
    expect(topic.title.scan(/\S+/).map(&:length).max).to be <= 80
    expect(topic.title).to include("[long token]")
    expect(topic.title).to start_with("[discourse/discourse] PR #123: ")
  end

  it "records PR state changes as small action posts" do
    described_class.call(
      pull_request_payload(event_id: "delivery-1", title: "Add feature")
    )

    result =
      described_class.call(
        pull_request_payload(
          event_id: "delivery-2",
          title: "Add feature",
          pr_attrs: {
            "state" => "closed"
          }
        )
      )

    topic = Topic.find(result[:topic_id])
    small_action = topic.posts.where(post_type: Post.types[:small_action]).last
    expect(small_action.raw).to eq(
      "GitHub PR status changed from open to closed."
    )
    expect(small_action.action_code).to eq("github_pr_bridge_status_changed")
  end

  it "records GitHub check run state as small action posts" do
    created_topic =
      described_class.call(
        pull_request_payload(event_id: "delivery-1", title: "Add feature")
      )

    result = described_class.call(check_run_payload)

    expect(result[:action]).to eq("created_check_action")
    expect(result[:topic_id]).to eq(created_topic[:topic_id])

    topic = Topic.find(result[:topic_id])
    small_action = topic.posts.where(post_type: Post.types[:small_action]).last
    expect(small_action.raw).to eq(
      "GitHub check \"Lint\" completed: success. https://github.com/discourse/discourse/actions/runs/1"
    )
    expect(small_action.action_code).to eq("github_pr_bridge_check_changed")

    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    expect(mapping.github_pr_checks_state).to eq("success")
    expect(mapping.github_pr_recent_activity_summary).to eq("checks success")
  end

  it "records GitHub review state as small action posts" do
    created_topic =
      described_class.call(
        pull_request_payload(event_id: "delivery-1", title: "Add feature")
      )

    result = described_class.call(pull_request_review_payload)

    expect(result[:action]).to eq("created_review_action")
    expect(result[:topic_id]).to eq(created_topic[:topic_id])

    topic = Topic.find(result[:topic_id])
    small_action = topic.posts.where(post_type: Post.types[:small_action]).last
    expect(small_action.raw).to eq(
      "GitHub review approved by reviewer. https://github.com/discourse/discourse/pull/123#pullrequestreview-1"
    )
    expect(small_action.action_code).to eq("github_pr_bridge_review_changed")

    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    expect(mapping.github_pr_review_state).to eq("approved")
    expect(mapping.github_pr_recent_activity_summary).to eq(
      "approved by reviewer"
    )
  end

  it "records GitHub push head SHA changes as small action posts" do
    created_topic =
      described_class.call(
        pull_request_payload(event_id: "delivery-1", title: "Add feature")
      )

    result = described_class.call(push_payload)

    expect(result[:action]).to eq("created_push_actions")
    expect(result[:topic_count]).to eq(1)

    topic = Topic.find(created_topic[:topic_id])
    small_action = topic.posts.where(post_type: Post.types[:small_action]).last
    expect(small_action.raw).to eq(
      "GitHub pushed 2 commits to feature (def456). https://github.com/discourse/discourse/compare/abc123...def456"
    )
    expect(small_action.action_code).to eq("github_pr_bridge_push_changed")

    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    expect(mapping.github_pr_head_sha).to eq("def456")
    expect(mapping.github_pr_recent_activity_summary).to eq("2 commits pushed")
  end

  it "skips push events that are not normal branch updates" do
    described_class.call(
      pull_request_payload(event_id: "delivery-1", title: "Add feature")
    )

    result =
      described_class.call(
        push_payload(
          event_id: "delivery-push-delete",
          push_attrs: {
            "deleted" => true,
            "after" => "0" * 40
          }
        )
      )

    expect(result[:action]).to eq("skipped_non_branch_push")
    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    expect(mapping.github_pr_head_sha).to eq("abc123")
  end

  it "syncs GitHub labels to Discourse tags while preserving local tags" do
    described_class.call(
      pull_request_payload(
        event_id: "delivery-1",
        title: "Add feature",
        labels: ["Feature Request", "needs review"]
      )
    )
    mapping = GithubPrBridge::PrTopicMapping.find_by(github_pr_number: 123)
    topic = mapping.topic
    local_tag = Tag.create!(name: "local-only")
    topic.tags << local_tag

    described_class.call(
      pull_request_payload(
        event_id: "delivery-2",
        title: "Add feature",
        labels: ["bug fix"]
      )
    )

    expect(topic.reload.tags.pluck(:name)).to contain_exactly(
      "bug-fix",
      "local-only"
    )

    described_class.call(
      pull_request_payload(
        event_id: "delivery-3",
        title: "Add feature",
        labels: []
      )
    )

    expect(topic.reload.tags.pluck(:name)).to contain_exactly("local-only")
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

  def pull_request_payload(event_id:, title:, pr_attrs: {}, labels: ["feature"])
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
        "draft" => false,
        "commits" => 3,
        "changed_files" => 4,
        "additions" => 10,
        "deletions" => 2,
        "updated_at" => "2026-06-27T21:00:00Z",
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
        "labels" => labels.map { |name| { "name" => name } }
      }.merge(pr_attrs)
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

  def check_run_payload
    {
      "event_id" => "delivery-check-run-1",
      "event_type" => "check_run",
      "action" => "completed",
      "repository" => {
        "full_name" => "discourse/discourse"
      },
      "check_run" => {
        "name" => "Lint",
        "status" => "completed",
        "conclusion" => "success",
        "html_url" => "https://github.com/discourse/discourse/actions/runs/1",
        "completed_at" => "2026-06-29T12:30:00Z",
        "pull_requests" => [{ "number" => 123 }]
      }
    }
  end

  def pull_request_review_payload
    {
      "event_id" => "delivery-review-1",
      "event_type" => "pull_request_review",
      "action" => "submitted",
      "repository" => {
        "full_name" => "discourse/discourse"
      },
      "pull_request" => {
        "number" => 123
      },
      "review" => {
        "state" => "approved",
        "html_url" =>
          "https://github.com/discourse/discourse/pull/123#pullrequestreview-1",
        "submitted_at" => "2026-06-29T12:45:00Z",
        "user" => {
          "login" => "reviewer"
        }
      }
    }
  end

  def push_payload(event_id: "delivery-push-1", push_attrs: {})
    {
      "event_id" => event_id,
      "event_type" => "push",
      "repository" => {
        "full_name" => "discourse/discourse"
      },
      "push" => {
        "ref" => "refs/heads/feature",
        "before" => "abc123",
        "after" => "def456",
        "compare" =>
          "https://github.com/discourse/discourse/compare/abc123...def456",
        "commits" => [{ "id" => "c1" }, { "id" => "c2" }],
        "head_commit" => {
          "id" => "def456",
          "timestamp" => "2026-06-29T13:00:00Z",
          "url" => "https://github.com/discourse/discourse/commit/def456"
        }
      }.merge(push_attrs)
    }
  end
end
