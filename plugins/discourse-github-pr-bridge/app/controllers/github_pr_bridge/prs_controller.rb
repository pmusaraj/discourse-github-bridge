# frozen_string_literal: true

module GithubPrBridge
  class PrsController < ::ApplicationController
    requires_plugin GithubPrBridge::PLUGIN_NAME

    include TopicListResponder
    include TopicQueryParams

    skip_before_action :check_xhr

    def index
      if !SiteSetting.github_pr_bridge_enabled?
        return render_json_error("bridge disabled", status: 404)
      end

      list_opts = build_topic_list_options
      list_opts[:github_pr_bridge] = true
      list_opts[:no_definitions] = true

      list = TopicQuery.new(current_user, list_opts).list_latest
      list.more_topics_url = more_prs_url(list_opts) if list.topics.size >=
        list.per_page

      respond_with_list(list)
    end

    private

    def more_prs_url(list_opts)
      next_page = list_opts[:page].to_i + 1
      query =
        Rack::Utils.build_query(
          list_opts.except(:github_pr_bridge, :no_definitions).merge(
            page: next_page
          )
        )
      "/github-pr-bridge/prs#{query.present? ? "?#{query}" : ""}"
    end
  end
end
