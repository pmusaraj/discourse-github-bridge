import Component from "@glimmer/component";
import { i18n } from "discourse-i18n";

export default class GithubPrBridgeTopicListStatus extends Component {
  get status() {
    return this.args.topic?.github_pr_bridge_status;
  }

  get prLabel() {
    return i18n("github_pr_bridge.topic_list.pr_label", {
      number: this.status.github_pr_number,
      state: this.prStateLabel,
    });
  }

  get prStateLabel() {
    const state = this.status.github_pr_merged
      ? "merged"
      : this.status.github_pr_draft
        ? "draft"
        : this.status.github_pr_state;

    return i18n(`github_pr_bridge.topic_list.pr_states.${state || "unknown"}`);
  }

  get checksLabel() {
    if (!this.status.github_pr_checks_state) {
      return;
    }

    return i18n(
      `github_pr_bridge.topic_list.check_states.${this.status.github_pr_checks_state}`
    );
  }

  get reviewLabel() {
    if (!this.status.github_pr_review_state) {
      return;
    }

    return i18n(
      `github_pr_bridge.topic_list.review_states.${this.status.github_pr_review_state}`
    );
  }

  <template>
    {{#if this.status}}
      <span class="github-pr-bridge-topic-list-status">
        <a
          class="github-pr-bridge-topic-list-status__badge github-pr-bridge-topic-list-status__badge--pr"
          href={{this.status.github_pr_url}}
          target="_blank"
          rel="noopener noreferrer"
        >
          {{this.prLabel}}
        </a>

        {{#if this.checksLabel}}
          <span
            class="github-pr-bridge-topic-list-status__badge github-pr-bridge-topic-list-status__badge--checks"
          >
            {{this.checksLabel}}
          </span>
        {{/if}}

        {{#if this.reviewLabel}}
          <span
            class="github-pr-bridge-topic-list-status__badge github-pr-bridge-topic-list-status__badge--review"
          >
            {{this.reviewLabel}}
          </span>
        {{/if}}

        {{#if this.status.github_pr_recent_activity_summary}}
          <span class="github-pr-bridge-topic-list-status__activity">
            {{this.status.github_pr_recent_activity_summary}}
          </span>
        {{/if}}
      </span>
    {{/if}}
  </template>
}
