# frozen_string_literal: true

module GithubPrBridge
  class EventsController < ::ApplicationController
    requires_plugin GithubPrBridge::PLUGIN_NAME

    skip_before_action :check_xhr
    skip_before_action :verify_authenticity_token
    skip_before_action :redirect_to_login_if_required

    def create
      if !SiteSetting.github_pr_bridge_enabled?
        return render_json_error("bridge disabled", status: 404)
      end

      if SiteSetting.github_pr_bridge_shared_secret.blank?
        return(
          render_json_error(
            "bridge shared secret is not configured",
            status: 500
          )
        )
      end

      if !valid_signature?
        return render_json_error("invalid signature", status: 403)
      end

      payload = JSON.parse(raw_body)
      result = GithubPrBridge::EventProcessor.call(payload)

      render_json_dump(result)
    rescue JSON::ParserError
      render_json_error("invalid json", status: 400)
    rescue GithubPrBridge::EventProcessor::InvalidPayload => error
      render_json_error(error.message, status: 422)
    end

    private

    def raw_body
      @raw_body ||= request.raw_post
    end

    def valid_signature?
      timestamp = request.headers["X-GitHub-Pr-Bridge-Timestamp"].to_s
      signature = request.headers["X-GitHub-Pr-Bridge-Signature"].to_s
      return false if timestamp.blank? || signature.blank?
      return false if (Time.zone.now.to_i - timestamp.to_i).abs > 5.minutes

      expected =
        GithubPrBridge::Signature.sign(body: raw_body, timestamp: timestamp)
      return false if signature.bytesize != expected.bytesize

      ActiveSupport::SecurityUtils.secure_compare(signature, expected)
    end
  end
end
