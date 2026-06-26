# frozen_string_literal: true

RSpec.describe GithubPrBridge::EventsController do
  fab!(:category)

  describe "#create" do
    before do
      SiteSetting.github_pr_bridge_enabled = true
      SiteSetting.github_pr_bridge_shared_secret = "secret"
      SiteSetting.github_pr_bridge_category_id = category.id
    end

    it "rejects unsigned requests" do
      post "/github-pr-bridge/events.json", params: pull_request_payload.to_json

      expect(response.status).to eq(403)
    end

    it "accepts valid signed requests when login is required" do
      SiteSetting.login_required = true
      body = pull_request_payload.to_json

      post "/github-pr-bridge/events.json",
           params: body,
           headers: signed_headers(body)

      expect(response.status).to eq(200)
      expect(response.parsed_body["action"]).to eq("created_topic")
    end

    it "rejects stale signed requests" do
      body = pull_request_payload.to_json
      timestamp = 10.minutes.ago.to_i.to_s
      headers = {
        "X-GitHub-Pr-Bridge-Timestamp" => timestamp,
        "X-GitHub-Pr-Bridge-Signature" =>
          GithubPrBridge::Signature.sign(body: body, timestamp: timestamp)
      }

      post "/github-pr-bridge/events.json", params: body, headers: headers

      expect(response.status).to eq(403)
    end
  end

  def signed_headers(body)
    timestamp = Time.zone.now.to_i.to_s

    {
      "X-GitHub-Pr-Bridge-Timestamp" => timestamp,
      "X-GitHub-Pr-Bridge-Signature" =>
        GithubPrBridge::Signature.sign(body: body, timestamp: timestamp)
    }
  end

  def pull_request_payload
    {
      event_id: "delivery-1",
      event_type: "pull_request",
      repository: {
        full_name: "discourse/discourse"
      },
      pull_request: {
        number: 123,
        html_url: "https://github.com/discourse/discourse/pull/123",
        title: "Add feature",
        body: "This adds a feature.",
        state: "open",
        merged: false,
        user: {
          login: "octocat"
        },
        base: {
          ref: "main"
        },
        head: {
          ref: "feature",
          sha: "abc123"
        },
        labels: []
      }
    }
  end
end
