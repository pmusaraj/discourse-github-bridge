import { render } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "discourse/tests/helpers/component-test";
import GithubPrBridgeTopicListStatus from "discourse/plugins/discourse-github-pr-bridge/discourse/components/github-pr-bridge-topic-list-status";

module("Component | GithubPrBridgeTopicListStatus", function (hooks) {
  setupRenderingTest(hooks);

  test("renders compact PR status badges and recent activity", async function (assert) {
    this.set("topic", {
      github_pr_bridge_status: {
        github_pr_number: 123,
        github_pr_url: "https://github.com/discourse/discourse/pull/123",
        github_pr_state: "open",
        github_pr_draft: false,
        github_pr_merged: false,
        github_pr_checks_state: "success",
        github_pr_review_state: "approved",
        github_pr_recent_activity_summary: "checks success",
      },
    });

    await render(
      <template>
        <GithubPrBridgeTopicListStatus @topic={{this.topic}} />
      </template>
    );

    assert
      .dom(".github-pr-bridge-topic-list-status__badge--pr")
      .hasText("PR #123 open");
    assert
      .dom(".github-pr-bridge-topic-list-status__badge--pr")
      .hasAttribute("href", "https://github.com/discourse/discourse/pull/123");
    assert
      .dom(".github-pr-bridge-topic-list-status__badge--checks")
      .hasText("checks passing");
    assert
      .dom(".github-pr-bridge-topic-list-status__badge--review")
      .hasText("approved");
    assert
      .dom(".github-pr-bridge-topic-list-status__activity")
      .hasText("checks success");
  });

  test("does not render when topic has no bridge status", async function (assert) {
    this.set("topic", {});

    await render(
      <template>
        <GithubPrBridgeTopicListStatus @topic={{this.topic}} />
      </template>
    );

    assert.dom(".github-pr-bridge-topic-list-status").doesNotExist();
  });
});
