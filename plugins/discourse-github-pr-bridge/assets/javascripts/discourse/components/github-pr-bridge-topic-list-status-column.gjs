import Component from "@glimmer/component";
import dIcon from "discourse/ui-kit/helpers/d-icon";
import { i18n } from "discourse-i18n";

export default class GithubPrBridgeTopicListStatusColumn extends Component {
  get status() {
    return this.args.topic?.github_pr_bridge_status;
  }

  get prState() {
    if (!this.status) {
      return "unknown";
    }

    if (this.status.github_pr_merged) {
      return "merged";
    }

    if (this.status.github_pr_draft) {
      return "draft";
    }

    return this.status.github_pr_state || "unknown";
  }

  get mergeIcon() {
    switch (this.prState) {
      case "merged":
        return "code-merge";
      case "closed":
        return "circle-xmark";
      case "draft":
        return "circle-dot";
      case "open":
        return "code-pull-request";
      default:
        return "circle-question";
    }
  }

  get mergeLabel() {
    return i18n(`github_pr_bridge.topic_list.merge_states.${this.prState}`);
  }

  get checksState() {
    return this.status?.github_pr_checks_state || "unknown";
  }

  get checksIcon() {
    switch (this.checksState) {
      case "success":
        return "check";
      case "failure":
      case "timed_out":
      case "action_required":
        return "xmark";
      case "pending":
      case "queued":
      case "in_progress":
        return "circle-dot";
      case "cancelled":
      case "skipped":
      case "neutral":
        return "circle-minus";
      default:
        return "circle-question";
    }
  }

  get checksLabel() {
    return i18n(`github_pr_bridge.topic_list.check_states.${this.checksState}`);
  }

  get reviewState() {
    return this.status?.github_pr_review_state || "unknown";
  }

  get reviewIcon() {
    switch (this.reviewState) {
      case "approved":
        return "check";
      case "changes_requested":
        return "xmark";
      case "commented":
        return "comment";
      case "review_required":
        return "circle-dot";
      default:
        return "circle-question";
    }
  }

  get reviewLabel() {
    return i18n(`github_pr_bridge.topic_list.review_states.${this.reviewState}`);
  }

  <template>
    <td class="github-pr-bridge-topic-list-statuses topic-list-data">
      {{#if this.status}}
        <span class="github-pr-bridge-topic-list-statuses__group">
          <a
            class="github-pr-bridge-topic-list-statuses__icon github-pr-bridge-topic-list-statuses__icon--merge"
            data-pr-state={{this.prState}}
            href={{this.status.github_pr_url}}
            target="_blank"
            rel="noopener noreferrer"
            title={{this.mergeLabel}}
            aria-label={{this.mergeLabel}}
          >
            {{dIcon this.mergeIcon}}
          </a>

          <span
            class="github-pr-bridge-topic-list-statuses__icon github-pr-bridge-topic-list-statuses__icon--checks"
            data-checks-state={{this.checksState}}
            title={{this.checksLabel}}
            aria-label={{this.checksLabel}}
          >
            {{dIcon this.checksIcon}}
          </span>

          <span
            class="github-pr-bridge-topic-list-statuses__icon github-pr-bridge-topic-list-statuses__icon--review"
            data-review-state={{this.reviewState}}
            title={{this.reviewLabel}}
            aria-label={{this.reviewLabel}}
          >
            {{dIcon this.reviewIcon}}
          </span>
        </span>
      {{/if}}
    </td>
  </template>
}
