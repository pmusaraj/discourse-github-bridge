# frozen_string_literal: true

# Idempotently seeds a small, varied set of GitHub PR bridge topics for visually
# smoke-testing Discourse topic lists. Run from a Discourse checkout with:
#   LOAD_PLUGINS=1 bin/rails runner /path/to/seed-pr-list-smoke.rb

repo = ENV.fetch("GITHUB_PR_BRIDGE_SMOKE_REPO", "discourse/pr-list-smoke")
category_name = ENV.fetch("GITHUB_PR_BRIDGE_SMOKE_CATEGORY", "GitHub PR Smoke")
actor = Discourse.system_user || User.where(admin: true).first || User.first
raise "no user available to create smoke topics" if actor.blank?

SiteSetting.github_pr_bridge_enabled = true if SiteSetting.respond_to?(:github_pr_bridge_enabled=)
SiteSetting.tagging_enabled = true if SiteSetting.respond_to?(:tagging_enabled=)

category = Category.find_by(name: category_name)
category ||= Category.create!(
  name: category_name,
  color: "0088CC",
  text_color: "FFFFFF",
  user: actor
)

def smoke_pr_url(repo, number)
  "https://github.com/#{repo}/pull/#{number}"
end

fixtures = [
  {
    number: 101,
    title: "[PR smoke] Add compact status badges",
    state: "open",
    draft: false,
    merged: false,
    checks: "success",
    review: "approved",
    activity: "checks passing",
    minutes_ago: 12,
    labels: %w[frontend ui ready]
  },
  {
    number: 102,
    title: "[PR smoke] Harden webhook retry handling",
    state: "open",
    draft: false,
    merged: false,
    checks: "failure",
    review: "changes_requested",
    activity: "review changes requested",
    minutes_ago: 34,
    labels: %w[backend bug needs-work]
  },
  {
    number: 103,
    title: "[PR smoke] Draft recent activity feed",
    state: "open",
    draft: true,
    merged: false,
    checks: "pending",
    review: "commented",
    activity: "new GitHub comment",
    minutes_ago: 71,
    labels: %w[draft activity]
  },
  {
    number: 104,
    title: "[PR smoke] Ship list serializer metadata",
    state: "closed",
    draft: false,
    merged: true,
    checks: "success",
    review: "approved",
    activity: "PR merged",
    minutes_ago: 140,
    labels: %w[merged serializer]
  }
]

fixtures.each do |fixture|
  title = fixture.fetch(:title)
  topic = Topic.find_by(title: title)

  raw = <<~MD
    Smoke fixture for GitHub PR bridge topic-list verification.

    **GitHub PR:** #{smoke_pr_url(repo, fixture.fetch(:number))}
    **State:** #{fixture.fetch(:draft) ? "draft" : fixture.fetch(:merged) ? "merged" : fixture.fetch(:state)}
    **Checks:** #{fixture.fetch(:checks)}
    **Review:** #{fixture.fetch(:review)}
    **Recent activity:** #{fixture.fetch(:activity)}

    This topic is safe to delete and can be recreated by `scripts/seed-pr-list-smoke.rb`.
  MD

  if topic.blank?
    post = PostCreator.create!(
      actor,
      title: title,
      raw: raw,
      category: category.id,
      skip_validations: true
    )
    topic = post.topic
  else
    topic.update!(category: category)
    first_post = topic.first_post
    first_post&.update!(raw: raw, cooked: nil)
    first_post&.rebake!
  end

  DiscourseTagging.tag_topic_by_names(topic, actor.guardian, fixture.fetch(:labels))

  GithubPrBridge::PrTopicMapping.find_or_initialize_by(
    github_repo: repo,
    github_pr_number: fixture.fetch(:number)
  ).tap do |mapping|
    mapping.assign_attributes(
      github_pr_node_id: "SMOKE_PR_#{fixture.fetch(:number)}",
      github_pr_url: smoke_pr_url(repo, fixture.fetch(:number)),
      github_pr_head_sha: "smoke#{fixture.fetch(:number)}",
      github_pr_state: fixture.fetch(:state),
      github_pr_draft: fixture.fetch(:draft),
      github_pr_merged: fixture.fetch(:merged),
      github_pr_checks_state: fixture.fetch(:checks),
      github_pr_review_state: fixture.fetch(:review),
      github_pr_recent_activity_at: fixture.fetch(:minutes_ago).minutes.ago,
      github_pr_recent_activity_summary: fixture.fetch(:activity),
      topic: topic
    )
    mapping.save!
  end
end

puts "Seeded #{fixtures.size} GitHub PR bridge smoke topics in #{category_name.inspect} for #{repo}."
puts GithubPrBridge::PrTopicMapping.where(github_repo: repo).order(:github_pr_number).map(&:status_payload)
