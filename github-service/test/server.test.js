import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGitHubAppJwt,
  createGitHubIssueComment,
  createServer,
  discourseEventsUrl,
  forwardToDiscourse,
  githubAppInstallationIdForRepo,
  githubAppInstallationTokenUrl,
  syncGitHubAppInstallations,
  githubIssueCommentsUrl,
  verifyGitHubSignature
} from "../src/server.js";
import { signDiscourseRequest } from "../src/signature.js";

const config = {
  githubWebhookSecret: "github-secret",
  githubToken: "github-token",
  discourseBaseUrl: "https://forum.example.com",
  discourseSharedSecret: "discourse-secret",
  processedEventsPath: "",
  retryDelayMs: 0,
  logger: captureLogger([])
};

test("verifies GitHub webhook signatures", () => {
  const body = JSON.stringify({ ok: true });
  const signatureHeader = githubSignature(body, config.githubWebhookSecret);

  assert.equal(verifyGitHubSignature({ body, signatureHeader, secret: config.githubWebhookSecret }), true);
  assert.equal(verifyGitHubSignature({ body, signatureHeader: "sha256=bad", secret: config.githubWebhookSecret }), false);
});

test("returns a deterministic GitHub App manifest", async () => {
  const server = createServer({
    config: {
      ...config,
      githubAppName: "Example PR Bridge",
      serviceBaseUrl: "https://bridge.example.com"
    },
    fetchImpl: async () => jsonResponse({ ok: true }, 200)
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/github/app/manifest`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: "Example PR Bridge",
      url: "https://forum.example.com",
      hook_attributes: {
        url: "https://bridge.example.com/github/webhook",
        active: true
      },
      redirect_url: "https://bridge.example.com/github/app/installations",
      public: false,
      default_permissions: {
        checks: "read",
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "read",
        statuses: "read"
      },
      default_events: [
        "check_run",
        "check_suite",
        "installation",
        "installation_repositories",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "push",
        "status"
      ]
    });
  });
});

test("returns a GitHub App setup URL for organization-owned apps", async () => {
  const server = createServer({
    config: {
      ...config,
      githubAppOwner: "discourse",
      serviceBaseUrl: "https://bridge.example.com"
    },
    fetchImpl: async () => jsonResponse({ ok: true }, 200)
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/github/app/setup`);
    const setup = await response.json();
    const createUrl = new URL(setup.create_url);
    const manifest = JSON.parse(createUrl.searchParams.get("manifest"));

    assert.equal(response.status, 200);
    assert.equal(createUrl.origin + createUrl.pathname, "https://github.com/organizations/discourse/settings/apps/new");
    assert.equal(manifest.name, "Discourse GitHub PR Bridge");
    assert.equal(manifest.hook_attributes.url, "https://bridge.example.com/github/webhook");
    assert.deepEqual(setup.manifest, manifest);
  });
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

test("forwards valid check_run webhooks to Discourse", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ ok: true, action: "created_check_action" }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "discourse/discourse" },
      check_run: {
        name: "Lint",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 123 }]
      }
    });

    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "check_run", deliveryId: "delivery-check-run" }),
      body
    });

    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.length, 1);

    assert.deepEqual(JSON.parse(forwardedRequests[0].options.body), {
      event_id: "delivery-check-run",
      event_type: "check_run",
      action: "completed",
      repository: { full_name: "discourse/discourse" },
      check_run: {
        name: "Lint",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 123 }]
      }
    });
  });
});

test("forwards valid pull_request_review webhooks to Discourse", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ ok: true, action: "created_review_action" }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      action: "submitted",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 },
      review: { id: 456, state: "approved" }
    });

    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({
        body,
        eventName: "pull_request_review",
        deliveryId: "delivery-review"
      }),
      body
    });

    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.length, 1);

    assert.deepEqual(JSON.parse(forwardedRequests[0].options.body), {
      event_id: "delivery-review",
      event_type: "pull_request_review",
      action: "submitted",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 },
      review: { id: 456, state: "approved" }
    });
  });
});

test("forwards valid push webhooks to Discourse", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ ok: true, action: "created_push_actions" }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      ref: "refs/heads/feature",
      before: "abc123",
      after: "def456",
      repository: { full_name: "discourse/discourse" },
      commits: [{ id: "def456" }]
    });

    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "push", deliveryId: "delivery-push" }),
      body
    });

    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.length, 1);

    assert.deepEqual(JSON.parse(forwardedRequests[0].options.body), {
      event_id: "delivery-push",
      event_type: "push",
      repository: { full_name: "discourse/discourse" },
      push: {
        ref: "refs/heads/feature",
        before: "abc123",
        after: "def456",
        repository: { full_name: "discourse/discourse" },
        commits: [{ id: "def456" }]
      }
    });
  });
});

test("forwards valid status webhooks to Discourse", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ ok: true, action: "created_commit_status_actions" }, 200);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      sha: "abc123",
      state: "failure",
      context: "ci/build",
      repository: { full_name: "discourse/discourse" }
    });

    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "status", deliveryId: "delivery-status" }),
      body
    });

    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.length, 1);

    assert.deepEqual(JSON.parse(forwardedRequests[0].options.body), {
      event_id: "delivery-status",
      event_type: "status",
      repository: { full_name: "discourse/discourse" },
      status: {
        sha: "abc123",
        state: "failure",
        context: "ci/build",
        repository: { full_name: "discourse/discourse" }
      }
    });
  });
});

test("retries transient Discourse forwarding failures and logs attempts", async () => {
  const logs = [];
  const retryConfig = {
    ...config,
    logger: captureLogger(logs),
    retryDelayMs: 0
  };
  let attempts = 0;

  const result = await forwardToDiscourse({
    event: { event_id: "delivery-retry", event_type: "pull_request" },
    config: retryConfig,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: "temporary" }, 503);
      }

      return jsonResponse({ ok: true, action: "updated_topic" }, 200);
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    discourse: { ok: true, action: "updated_topic" }
  });
  assert.deepEqual(logs.map((log) => [log.level, log.message]), [
    ["warn", "discourse_forward_retry"]
  ]);
});

test("does not retry GitHub comment creation after ambiguous network errors", async () => {
  let attempts = 0;

  await assert.rejects(
    () => createGitHubIssueComment({
      payload: discoursePostPayload(),
      config,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("network unavailable");
      }
    }),
    /network unavailable/
  );

  assert.equal(attempts, 1);
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
      headers: githubHeaders({
        body,
        eventName: "deployment_status",
        deliveryId: "delivery-1"
      }),
      body
    });

    assert.equal(response.status, 202);
    assert.equal((await response.json()).ignored, true);
    assert.equal(forwarded, false);
  });
});

test("captures GitHub App installation repository mappings from webhooks", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-"));
  const installationsPath = join(tempDir, "installations.json");
  const installConfig = { ...config, githubAppInstallationsPath: installationsPath };
  let forwarded = false;
  const server = createServer({
    config: installConfig,
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ ok: true }, 200);
    }
  });

  try {
    await withListeningServer(server, async (baseUrl) => {
      const body = JSON.stringify({
        action: "created",
        installation: { id: 98765 },
        repositories: [{ full_name: "Discourse/Discourse" }, { full_name: "discourse/discourse-ai" }]
      });
      const response = await fetch(`${baseUrl}/github/webhook`, {
        method: "POST",
        headers: githubHeaders({ body, eventName: "installation", deliveryId: "delivery-installation" }),
        body
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        action: "upserted_installation_repositories",
        installation_id: 98765,
        repositories: ["Discourse/Discourse", "discourse/discourse-ai"]
      });
      assert.equal(forwarded, false);
      assert.deepEqual(JSON.parse(await readInstallationsFile(installationsPath)), {
        repositories: {
          "discourse/discourse": 98765,
          "discourse/discourse-ai": 98765
        }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("captures GitHub App repository add and remove webhooks", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-"));
  const installationsPath = join(tempDir, "installations.json");
  await writeFile(installationsPath, JSON.stringify({ repositories: { "discourse/discourse": 98765 } }));
  const server = createServer({
    config: { ...config, githubAppInstallationsPath: installationsPath },
    fetchImpl: async () => jsonResponse({ ok: true }, 200)
  });

  try {
    await withListeningServer(server, async (baseUrl) => {
      const body = JSON.stringify({
        action: "added",
        installation: { id: 98765 },
        repositories_added: [{ full_name: "discourse/discourse-ai" }],
        repositories_removed: [{ full_name: "discourse/discourse" }]
      });
      const response = await fetch(`${baseUrl}/github/webhook`, {
        method: "POST",
        headers: githubHeaders({ body, eventName: "installation_repositories", deliveryId: "delivery-installation-repos" }),
        body
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        action: "updated_installation_repositories",
        installation_id: 98765,
        repositories_added: ["discourse/discourse-ai"],
        repositories_removed: ["discourse/discourse"]
      });
      assert.deepEqual(JSON.parse(await readInstallationsFile(installationsPath)), {
        repositories: { "discourse/discourse-ai": 98765 }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("removes all repositories for deleted GitHub App installations", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-"));
  const installationsPath = join(tempDir, "installations.json");
  await writeFile(installationsPath, JSON.stringify({
    repositories: {
      "discourse/discourse": 98765,
      "discourse/discourse-ai": 98765,
      "other/repo": 22222
    }
  }));
  const server = createServer({
    config: { ...config, githubAppInstallationsPath: installationsPath },
    fetchImpl: async () => jsonResponse({ ok: true }, 200)
  });

  try {
    await withListeningServer(server, async (baseUrl) => {
      const body = JSON.stringify({ action: "deleted", installation: { id: 98765 } });
      const response = await fetch(`${baseUrl}/github/webhook`, {
        method: "POST",
        headers: githubHeaders({ body, eventName: "installation", deliveryId: "delivery-installation-deleted" }),
        body
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        action: "removed_installation_repositories",
        installation_id: 98765,
        repositories: ["discourse/discourse", "discourse/discourse-ai"]
      });
      assert.deepEqual(JSON.parse(await readInstallationsFile(installationsPath)), {
        repositories: { "other/repo": 22222 }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposes captured GitHub App installation mappings", async () => {
  const server = createServer({
    config: { ...config, githubAppInstallations: { "Discourse/Discourse": 98765 } },
    fetchImpl: async () => jsonResponse({ ok: true }, 200)
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/github/app/installations`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      repositories: { "discourse/discourse": 98765 }
    });
  });
});

test("syncs GitHub App installations from GitHub into durable storage", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-sync-"));
  const installationsPath = join(tempDir, "installations.json");
  const requests = [];
  const appConfig = {
    ...config,
    githubToken: "",
    githubAppId: "12345",
    githubAppPrivateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
    githubAppInstallationsPath: installationsPath
  };

  try {
    const result = await syncGitHubAppInstallations({
      config: appConfig,
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        if (url === "https://api.github.com/app/installations?per_page=100") {
          return new Response(JSON.stringify([{ id: 98765 }]), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "link": "<https://api.github.com/app/installations?per_page=100&page=2>; rel=\"next\""
            }
          });
        }
        if (url === "https://api.github.com/app/installations?per_page=100&page=2") {
          return jsonResponse([{ id: 22222 }], 200);
        }
        if (url === githubAppInstallationTokenUrl({ installationId: 98765 })) {
          return jsonResponse({ token: "installation-token-98765", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
        }
        if (url === githubAppInstallationTokenUrl({ installationId: 22222 })) {
          return jsonResponse({ token: "installation-token-22222", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
        }
        if (url === "https://api.github.com/installation/repositories?per_page=100") {
          const token = options.headers.authorization.replace("Bearer ", "");
          if (token === "installation-token-98765") {
            return new Response(JSON.stringify({
              repositories: [{ full_name: "Discourse/Discourse" }]
            }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "link": "<https://api.github.com/installation/repositories?per_page=100&page=2>; rel=\"next\""
              }
            });
          }
          return jsonResponse({ repositories: [{ full_name: "other/repo" }] }, 200);
        }
        if (url === "https://api.github.com/installation/repositories?per_page=100&page=2") {
          return jsonResponse({ repositories: [{ full_name: "discourse/discourse-ai" }] }, 200);
        }
        throw new Error(`unexpected request: ${url}`);
      }
    });

    assert.deepEqual(result, {
      ok: true,
      action: "synced_installation_repositories",
      installations: 2,
      repositories: {
        "discourse/discourse": 98765,
        "discourse/discourse-ai": 98765,
        "other/repo": 22222
      }
    });
    assert.deepEqual(JSON.parse(await readInstallationsFile(installationsPath)), {
      repositories: {
        "discourse/discourse": 98765,
        "discourse/discourse-ai": 98765,
        "other/repo": 22222
      }
    });
    assert.equal(requests.filter((request) => request.url.includes("/access_tokens")).length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("protects and runs the manual GitHub App installation sync endpoint", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-sync-endpoint-"));
  const installationsPath = join(tempDir, "installations.json");
  const server = createServer({
    config: {
      ...config,
      githubToken: "",
      githubAppId: "12345",
      githubAppPrivateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
      githubAppInstallationsPath: installationsPath,
      githubAppSyncOnStart: false
    },
    fetchImpl: async (url, options = {}) => {
      if (url === "https://api.github.com/app/installations?per_page=100") {
        return jsonResponse([{ id: 98765 }], 200);
      }
      if (url === githubAppInstallationTokenUrl({ installationId: 98765 })) {
        return jsonResponse({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      if (url === "https://api.github.com/installation/repositories?per_page=100") {
        assert.equal(options.headers.authorization, "Bearer installation-token");
        return jsonResponse({ repositories: [{ full_name: "discourse/discourse" }] }, 200);
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });

  try {
    await withListeningServer(server, async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/github/app/installations/sync`, { method: "POST" });
      assert.equal(unauthorized.status, 403);

      const response = await fetch(`${baseUrl}/github/app/installations/sync`, {
        method: "POST",
        headers: { "x-github-pr-bridge-admin-secret": config.discourseSharedSecret }
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        action: "synced_installation_repositories",
        installations: 1,
        repositories: { "discourse/discourse": 98765 }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

test("returns text bodies when Discourse rejects with non-JSON", async () => {
  const server = createServer({
    config,
    fetchImpl: async () => new Response("upstream unavailable", { status: 503 })
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "discourse/discourse" },
      pull_request: { number: 123 }
    });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: githubHeaders({ body, eventName: "pull_request", deliveryId: "delivery-text" }),
      body
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      status: 503,
      discourse: "upstream unavailable"
    });
  });
});

test("creates GitHub issue comments for signed Discourse events", async () => {
  const forwardedRequests = [];
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return jsonResponse({ id: 456, html_url: "https://github.example/comment/456" }, 201);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify(discoursePostPayload());
    const response = await fetch(`${baseUrl}/discourse/events`, {
      method: "POST",
      headers: discourseHeaders(body),
      body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      status: 201,
      github_comment_id: 456,
      github: { id: 456, html_url: "https://github.example/comment/456" }
    });
    assert.equal(forwardedRequests.length, 1);
    assert.equal(
      forwardedRequests[0].url,
      githubIssueCommentsUrl({ repo: "discourse/discourse", issueNumber: 123 })
    );
    assert.equal(forwardedRequests[0].options.headers.authorization, "Bearer github-token");
    assert.deepEqual(JSON.parse(forwardedRequests[0].options.body), { body: "Discourse reply" });

    const duplicateResponse = await fetch(`${baseUrl}/discourse/events`, {
      method: "POST",
      headers: discourseHeaders(body),
      body
    });

    assert.equal(duplicateResponse.status, 200);
    assert.deepEqual(await duplicateResponse.json(), { ok: true, duplicate: true });
    assert.equal(forwardedRequests.length, 1);
  });
});

test("creates GitHub issue comments with GitHub App installation tokens", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appConfig = {
    ...config,
    githubToken: "",
    githubAppId: "12345",
    githubAppPrivateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
    githubAppInstallations: { "discourse/discourse": 98765 },
    githubAppTokenCache: new Map()
  };
  const forwardedRequests = [];

  const result = await createGitHubIssueComment({
    payload: discoursePostPayload(),
    config: appConfig,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      if (url === githubAppInstallationTokenUrl({ installationId: 98765 })) {
        return jsonResponse({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }

      return jsonResponse({ id: 456 }, 201);
    }
  });

  assert.deepEqual(result, {
    ok: true,
    status: 201,
    github_comment_id: 456,
    github: { id: 456 }
  });
  assert.equal(forwardedRequests.length, 2);
  assert.equal(forwardedRequests[0].url, githubAppInstallationTokenUrl({ installationId: 98765 }));
  assert.match(forwardedRequests[0].options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(forwardedRequests[1].url, githubIssueCommentsUrl({ repo: "discourse/discourse", issueNumber: 123 }));
  assert.equal(forwardedRequests[1].options.headers.authorization, "Bearer installation-token");
});

test("caches GitHub App installation tokens between comment creations", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appConfig = {
    ...config,
    githubToken: "",
    githubAppId: "12345",
    githubAppPrivateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
    githubAppInstallations: { "discourse/discourse": 98765 },
    githubAppTokenCache: new Map()
  };
  let tokenRequests = 0;

  for (let i = 0; i < 2; i += 1) {
    await createGitHubIssueComment({
      payload: { ...discoursePostPayload(), event_id: `discourse-post-${i}` },
      config: appConfig,
      fetchImpl: async (url) => {
        if (url === githubAppInstallationTokenUrl({ installationId: 98765 })) {
          tokenRequests += 1;
          return jsonResponse({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
        }

        return jsonResponse({ id: 456 }, 201);
      }
    });
  }

  assert.equal(tokenRequests, 1);
});

test("loads GitHub App installation IDs from durable JSON storage", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-installations-"));
  const installationsPath = join(tempDir, "installations.json");

  try {
    await writeFile(installationsPath, JSON.stringify({ repositories: { "Discourse/Discourse": 98765 } }));
    assert.equal(
      await githubAppInstallationIdForRepo({
        repo: "discourse/discourse",
        config: { githubAppInstallationsPath: installationsPath }
      }),
      98765
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("creates RS256 GitHub App JWTs", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = await createGitHubAppJwt({
    githubAppId: "12345",
    githubAppPrivateKey: privateKey.export({ type: "pkcs1", format: "pem" })
  });
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

  assert.equal(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")).alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url")
    ),
    true
  );
});

test("deduplicates signed Discourse events across service restarts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-"));
  const processedEventsPath = join(tempDir, "processed-events.jsonl");
  const persistentConfig = { ...config, processedEventsPath };

  try {
    const firstForwardedRequests = [];
    const firstServer = createServer({
      config: persistentConfig,
      fetchImpl: async (url, options) => {
        firstForwardedRequests.push({ url, options });
        return jsonResponse({ id: 456 }, 201);
      }
    });

    const body = JSON.stringify(discoursePostPayload());
    await withListeningServer(firstServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 200);
      assert.equal(firstForwardedRequests.length, 1);
    });

    const secondForwardedRequests = [];
    const secondServer = createServer({
      config: persistentConfig,
      fetchImpl: async (url, options) => {
        secondForwardedRequests.push({ url, options });
        return jsonResponse({ id: 789 }, 201);
      }
    });

    await withListeningServer(secondServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, duplicate: true });
      assert.equal(secondForwardedRequests.length, 0);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("allows failed signed Discourse events to be retried after restart", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-"));
  const processedEventsPath = join(tempDir, "processed-events.jsonl");
  const persistentConfig = { ...config, processedEventsPath };

  try {
    const body = JSON.stringify(discoursePostPayload());
    const firstServer = createServer({
      config: persistentConfig,
      fetchImpl: async () => jsonResponse({ message: "temporary failure" }, 503)
    });

    await withListeningServer(firstServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 502);
    });

    const forwardedRequests = [];
    const secondServer = createServer({
      config: persistentConfig,
      fetchImpl: async (url, options) => {
        forwardedRequests.push({ url, options });
        return jsonResponse({ id: 789 }, 201);
      }
    });

    await withListeningServer(secondServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 200);
      assert.equal(forwardedRequests.length, 1);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("allows errored signed Discourse events to be retried after restart", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "github-pr-bridge-"));
  const processedEventsPath = join(tempDir, "processed-events.jsonl");
  const persistentConfig = { ...config, processedEventsPath };

  try {
    const body = JSON.stringify(discoursePostPayload());
    const firstServer = createServer({
      config: persistentConfig,
      fetchImpl: async () => {
        throw new Error("network unavailable");
      }
    });

    await withListeningServer(firstServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 500);
    });

    const forwardedRequests = [];
    const secondServer = createServer({
      config: persistentConfig,
      fetchImpl: async (url, options) => {
        forwardedRequests.push({ url, options });
        return jsonResponse({ id: 789 }, 201);
      }
    });

    await withListeningServer(secondServer, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discourse/events`, {
        method: "POST",
        headers: discourseHeaders(body),
        body
      });

      assert.equal(response.status, 200);
      assert.equal(forwardedRequests.length, 1);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deduplicates concurrent signed Discourse events while the first request is in flight", async () => {
  const forwardedRequests = [];
  let resolveGitHub;
  const githubResponse = new Promise((resolve) => {
    resolveGitHub = resolve;
  });
  const server = createServer({
    config,
    fetchImpl: async (url, options) => {
      forwardedRequests.push({ url, options });
      return githubResponse;
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const body = JSON.stringify(discoursePostPayload());
    const requestOptions = {
      method: "POST",
      headers: discourseHeaders(body),
      body
    };
    const firstRequest = fetch(`${baseUrl}/discourse/events`, requestOptions);

    while (forwardedRequests.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const secondResponse = await fetch(`${baseUrl}/discourse/events`, requestOptions);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), { ok: true, duplicate: true, processing: true });
    assert.equal(forwardedRequests.length, 1);

    resolveGitHub(jsonResponse({ id: 456 }, 201));
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.status, 200);
    assert.equal(forwardedRequests.length, 1);
  });
});

test("rejects unsigned Discourse events without forwarding to GitHub", async () => {
  let forwarded = false;
  const server = createServer({
    config,
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ id: 456 }, 201);
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discourse/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(discoursePostPayload())
    });

    assert.equal(response.status, 403);
    assert.equal(forwarded, false);
  });
});

function captureLogger(logs) {
  return {
    info: (message, fields = {}) => logs.push({ level: "info", message, ...fields }),
    warn: (message, fields = {}) => logs.push({ level: "warn", message, ...fields }),
    error: (message, fields = {}) => logs.push({ level: "error", message, ...fields })
  };
}

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

function discourseHeaders(body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  return {
    "content-type": "application/json",
    "x-github-pr-bridge-timestamp": timestamp,
    "x-github-pr-bridge-signature": signDiscourseRequest({
      body,
      timestamp,
      secret: config.discourseSharedSecret
    })
  };
}

function discoursePostPayload() {
  return {
    event_type: "discourse_post_created",
    event_id: "discourse-post-1",
    post_id: 1,
    topic_id: 2,
    github_repo: "discourse/discourse",
    github_pr_number: 123,
    author_username: "penar",
    post_url: "https://forum.example.com/t/topic/2/2",
    raw: "Discourse reply"
  };
}

async function readInstallationsFile(path) {
  return await readFile(path, "utf8");
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
