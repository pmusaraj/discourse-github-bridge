import test from "node:test";
import assert from "node:assert/strict";
import { signDiscourseRequest } from "../src/signature.js";
import { normalizeGitHubWebhook } from "../src/normalize.js";

test("signs requests with the Discourse bridge HMAC shape", () => {
  assert.equal(
    signDiscourseRequest({ body: '{"ok":true}', timestamp: "1710000000", secret: "secret" }),
    "ebbb85d53a240b6568e6e3f9c851993b0a6f279362be8908dda3f9568189ebac"
  );
});

test("normalizes supported GitHub webhook payloads", () => {
  const normalized = normalizeGitHubWebhook({
    eventName: "pull_request",
    deliveryId: "delivery-1",
    payload: { action: "opened", repository: { full_name: "discourse/discourse" }, pull_request: { number: 1 } }
  });

  assert.equal(normalized.event_id, "delivery-1");
  assert.equal(normalized.event_type, "pull_request");
  assert.equal(normalized.repository.full_name, "discourse/discourse");
  assert.equal(normalized.pull_request.number, 1);
});

test("normalizes issue comments", () => {
  const normalized = normalizeGitHubWebhook({
    eventName: "issue_comment",
    deliveryId: "delivery-2",
    payload: { action: "created", repository: { full_name: "discourse/discourse" }, issue: { number: 2 }, comment: { id: 10 } }
  });

  assert.equal(normalized.event_id, "delivery-2");
  assert.equal(normalized.event_type, "issue_comment");
  assert.equal(normalized.action, "created");
  assert.equal(normalized.issue.number, 2);
  assert.equal(normalized.comment.id, 10);
});

test("rejects unsupported webhook events", () => {
  assert.throws(
    () => normalizeGitHubWebhook({ eventName: "push", deliveryId: "delivery-3", payload: {} }),
    /unsupported event/
  );
});
