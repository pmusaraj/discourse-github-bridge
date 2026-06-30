import Component from "@glimmer/component";
import { apiInitializer } from "discourse/lib/api";
import GithubPrBridgeTopicListStatus from "../components/github-pr-bridge-topic-list-status";
import GithubPrBridgeTopicListStatusColumn from "../components/github-pr-bridge-topic-list-status-column";
import GithubPrBridgeTopicListStatusColumnHeader from "../components/github-pr-bridge-topic-list-status-column-header";

export default apiInitializer((api) => {
  api.registerValueTransformer(
    "topic-list-columns",
    ({ value: columns, context }) => {
      if (context.category || (context.filter && context.filter !== "latest")) {
        return;
      }

      columns.delete("posters");
      columns.delete("views");
      columns.delete("activity");
      columns.add(
        "github-pr-bridge-statuses",
        {
          header: GithubPrBridgeTopicListStatusColumnHeader,
          item: GithubPrBridgeTopicListStatusColumn,
        },
        { after: "replies" }
      );
    }
  );

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
