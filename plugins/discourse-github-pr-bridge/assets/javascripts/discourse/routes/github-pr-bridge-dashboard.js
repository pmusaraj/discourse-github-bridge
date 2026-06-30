import { service } from "@ember/service";
import { setTopicList } from "discourse/lib/topic-list-tracker";
import DiscourseRoute from "discourse/routes/discourse";
import { i18n } from "discourse-i18n";

export default class GithubPrBridgeDashboardRoute extends DiscourseRoute {
  @service store;

  queryParams = {
    page: { refreshModel: true },
  };

  async model(params = {}) {
    const list = await this.store.findFiltered("topicList", {
      filter: "github-pr-bridge/prs",
      params,
    });

    setTopicList(list);
    return list;
  }

  titleToken() {
    return i18n("github_pr_bridge.dashboard.title");
  }
}
