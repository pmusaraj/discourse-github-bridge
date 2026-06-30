import dIcon from "discourse/ui-kit/helpers/d-icon";
import { i18n } from "discourse-i18n";

const GithubPrBridgeTopicListStatusColumnHeader = <template>
  <th
    class="github-pr-bridge-topic-list-statuses topic-list-data"
    aria-label={{i18n "github_pr_bridge.topic_list.status_column_label"}}
    title={{i18n "github_pr_bridge.topic_list.status_column_label"}}
  >
    {{dIcon "circle-info"}}
  </th>
</template>;

export default GithubPrBridgeTopicListStatusColumnHeader;
