import Component from "@glimmer/component";
import { action } from "@ember/object";
import List from "discourse/components/topic-list/list";
import DLoadMore from "discourse/ui-kit/d-load-more";
import { i18n } from "discourse-i18n";

export default class GithubPrBridgeDashboard extends Component {
  get hasTopics() {
    return this.args.model?.topics?.length > 0;
  }

  @action
  loadMore() {
    return this.args.model?.loadMore();
  }

  <template>
    <div class="github-pr-bridge-dashboard">
      <div class="github-pr-bridge-dashboard__header">
        <h1>{{i18n "github_pr_bridge.dashboard.title"}}</h1>
        <p>{{i18n "github_pr_bridge.dashboard.description"}}</p>
      </div>

      {{#if this.hasTopics}}
        <List
          @listTitle="github_pr_bridge.dashboard.aria_label"
          @topics={{@model.topics}}
          @showPosters={{true}}
          @showTopicPostBadges={{true}}
          @discoveryList={{true}}
          @focusLastVisitedTopic={{true}}
          @listContext="github-pr-bridge-dashboard"
        />

        <DLoadMore @action={{this.loadMore}} />
      {{else}}
        <p class="github-pr-bridge-dashboard__empty">
          {{i18n "github_pr_bridge.dashboard.empty"}}
        </p>
      {{/if}}
    </div>
  </template>
}
