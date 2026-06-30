import Component from "@glimmer/component";
import { i18n } from "discourse-i18n";

export default class GithubPrBridgeTopicListStatus extends Component {
  get status() {
    return this.args.topic?.github_pr_bridge_status;
  }

  get prLabel() {
    return i18n("github_pr_bridge.topic_list.pr_label", {
      number: this.status.github_pr_number,
    });
  }

  get prStateLabel() {
    return i18n(`github_pr_bridge.topic_list.pr_states.${this.prState}`);
  }

  get checksState() {
    return this.status.github_pr_checks_state || "unknown";
  }

  get checksLabel() {
    if (!this.status.github_pr_checks_state) {
      return;
    }

    return i18n(`github_pr_bridge.topic_list.check_states.${this.checksState}`);
  }

  get reviewState() {
    return this.status.github_pr_review_state || "unknown";
  }

  get reviewLabel() {
    if (!this.status.github_pr_review_state) {
      return;
    }

    return i18n(`github_pr_bridge.topic_list.review_states.${this.reviewState}`);
  }

  get prState() {
    return this.status.github_pr_merged
      ? "merged"
      : this.status.github_pr_draft
        ? "draft"
        : this.status.github_pr_state || "unknown";
  }

  <template>
    {{#if this.status}}
      <span class="github-pr-bridge-topic-list-status">
        <a
          class="github-pr-bridge-topic-list-status__badge github-pr-bridge-topic-list-status__badge--pr"
          data-pr-state={{this.prState}}
          href={{this.status.github_pr_url}}
          target="_blank"
          rel="noopener noreferrer"
          title={{this.status.github_repo}}
        >
          {{this.prLabel}}
        </a>

        {{#if this.status.github_pr_recent_activity_summary}}
          <span class="github-pr-bridge-topic-list-status__activity">
            {{this.status.github_pr_recent_activity_summary}}
          </span>
        {{/if}}
      </span>
    {{/if}}
  </template>
}
