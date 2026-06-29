import Component from "@glimmer/component";
import { apiInitializer } from "discourse/lib/api";
import GithubPrBridgeTopicListStatus from "../components/github-pr-bridge-topic-list-status";

export default apiInitializer((api) => {
  api.renderInOutlet(
    "topic-list-topic-cell-link-bottom-line__before",
    class extends Component {
      static shouldRender(args) {
        return Boolean(args.topic?.github_pr_bridge_status);
      }

      <template>
        <GithubPrBridgeTopicListStatus @topic={{@topic}} />
      </template>
    }
  );
});
