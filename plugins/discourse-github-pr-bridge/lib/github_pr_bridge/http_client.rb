# frozen_string_literal: true

module GithubPrBridge
  class HttpClient
    def self.post_event(payload)
      body = payload.to_json
      timestamp = Time.now.to_i.to_s
      signature =
        GithubPrBridge::Signature.sign(body: body, timestamp: timestamp)

      Excon.post(
        SiteSetting.github_pr_bridge_service_url,
        body: body,
        connect_timeout: 2,
        read_timeout: 5,
        write_timeout: 5,
        headers: {
          "Accept" => "application/json",
          "Content-Type" => "application/json",
          "X-GitHub-Pr-Bridge-Timestamp" => timestamp,
          "X-GitHub-Pr-Bridge-Signature" => signature
        }
      )
    end
  end
end
