# frozen_string_literal: true

require "openssl"

module GithubPrBridge
  class Signature
    def self.sign(
      body:,
      timestamp:,
      secret: SiteSetting.github_pr_bridge_shared_secret
    )
      OpenSSL::HMAC.hexdigest("SHA256", secret, "#{timestamp}.#{body}")
    end
  end
end
