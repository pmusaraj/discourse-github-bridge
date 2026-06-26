import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, discourseEventsUrl, verifyGitHubSignature } from "../src/server.js";
import { signDiscourseRequest } from "../src/signature.js";

const config = {
  githubWebhookSecret: "github-secret",
  discourseBaseUrl: "https://forum.example.com",
  discourseSharedSecret: "discourse-secret"
};

test("verifies GitHub webhook signatures", () => {
  const body = JSON.stringify({ ok: true });
  const signatureHeader = githubSignature(body, config.githubWebhookSecret);

  assert.equal(verifyGitHubSignature({ body, signatureHeader, secret: config.githubWebhookSecret }), true);
  assert.equal(verifyGitHubSignature({ body, signatureHeader: "sha256=bad", secret: config.githubWebhookSecret }), false);
});

test("forwards valid pull_request webhooks to Discourse", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ ok: true, action: "created_topic" }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 }
    });

    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "pull_request", deliveryId: "delivery-1" }),
      body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      status: 200,
      discourse: { ok: true, action: "created_topic" }
    });

    assert.equal(forwardedRequests.length, 1);
    assert.equal(forwardedRequests[0].url, discourseEventsUrl(config.discourseBaseUrl));

    const forwardedBody = forwardedRequests[0].options.body;
    assert.deepEqual(JSON.parse(forwardedBody), {
      event_id: "delivery-1",
      event_type: "pull_request",
      action: "opened",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 }
    });

    const timestamp = forwardedRequests[0].options.headers["x-github-pr-bridge-timestamp"];
    const signature = forwardedRequests[0].options.headers["x-github-pr-bridge-signature"];
    assert.equal(signature, signDiscourseRequest({ body: forwardedBody, timestamp, secret: config.discourseSharedSecret }));
  });
});

test("rejects invalid GitHub signatures without forwarding", async () => {
  let forwarded = false;
  const server = createServer({
    config,
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ ok: true }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({ action: "opened" });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": "sha256=bad"
      },
      body
    });

    assert.equal(response.status, 403);
    assert.equal(forwarded, false);
  });
});

test("ignores unsupported GitHub events without forwarding", async () => {
  let forwarded = false;
  const server = createServer({
    config,
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ ok: true }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "push", deliveryId: "delivery-1" }),
      body
    });

    assert.equal(response.status, 202);
    assert.equal((await response.json()).ignored, true);
    assert.equal(forwarded, false);
  });
});

test("returns a gateway error when Discourse rejects the forwarded event", async () => {
  const server = createServer({
    config,
    fetchImpl: async () => jsonResponse({ errors: ["invalid signature"] }, 403)
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 }
    });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "pull_request", deliveryId: "delivery-1" }),
      body
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      status: 403,
      discourse: { errors: ["invalid signature"] }
    });
  });
});

function githubHeaders({ body, eventName, deliveryId }) {
  return {
    "content-type": "application/json",
    "x-github-event": eventName,
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": githubSignature(body, config.githubWebhookSecret)
  };
}

function githubSignature(body, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function withListeningServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
