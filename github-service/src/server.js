import crypto from "node:crypto";
import http from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeGitHubWebhook } from "./normalize.js";
import { signDiscourseRequest } from "./signature.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function createServer({ config, fetchImpl = fetch } = {}) {
  const resolvedConfig = readConfig(config);
  const processedDiscourseEventStore = createProcessedDiscourseEventStore(resolvedConfig.processedEventsPath);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "POST" && request.url === "/discourse/events") {
        return await handleDiscourseEvent({
          request,
          response,
          config: resolvedConfig,
          fetchImpl,
          processedDiscourseEventStore
        });
      }

      if (request.method !== "POST" || request.url !== "/github/webhook") {
        return sendJson(response, 404, { error: "not found" });
      }

      const body = await readBody(request);
      if (!verifyGitHubSignature({
        body,
        signatureHeader: request.headers["x-hub-signature-256"],
        secret: resolvedConfig.githubWebhookSecret
      })) {
        return sendJson(response, 403, { error: "invalid signature" });
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return sendJson(response, 400, { error: "invalid json" });
      }

      let normalized;
      try {
        normalized = normalizeGitHubWebhook({
          eventName: request.headers["x-github-event"],
          deliveryId: request.headers["x-github-delivery"],
          payload
        });
      } catch (error) {
        if (error.message.startsWith("unsupported event:")) {
          return sendJson(response, 202, { ok: true, ignored: true, reason: error.message });
        }

        return sendJson(response, 422, { error: error.message });
      }

      const discourseResponse = await forwardToDiscourse({
        event: normalized,
        config: resolvedConfig,
        fetchImpl
      });

      return sendJson(response, discourseResponse.ok ? 200 : 502, discourseResponse);
    } catch (error) {
      return sendJson(response, 500, { error: error.message });
    }
  });
}

export function verifyGitHubSignature({ body, signatureHeader, secret }) {
  if (!body || !signatureHeader || !secret) {
    return false;
  }

  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  return timingSafeStringEqual(signatureHeader, expected);
}

export function verifyDiscourseSignature({ body, timestamp, signatureHeader, secret }) {
  if (!body || !timestamp || !signatureHeader || !secret) {
    return false;
  }

  const requestTime = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(requestTime) || Math.abs(Math.floor(Date.now() / 1000) - requestTime) > 300) {
    return false;
  }

  const expected = signDiscourseRequest({ body, timestamp, secret });
  return timingSafeStringEqual(signatureHeader, expected);
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function forwardToDiscourse({ event, config, fetchImpl = fetch }) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signDiscourseRequest({
    body,
    timestamp,
    secret: config.discourseSharedSecret
  });

  const response = await fetchImpl(discourseEventsUrl(config.discourseBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-pr-bridge-timestamp": timestamp,
      "x-github-pr-bridge-signature": signature
    },
    body
  });

  const responseBody = await parseResponseBody(response);

  return {
    ok: response.ok,
    status: response.status,
    discourse: responseBody
  };
}

export function discourseEventsUrl(baseUrl) {
  return new URL("/github-pr-bridge/events.json", baseUrl).toString();
}

async function handleDiscourseEvent({
  request,
  response,
  config,
  fetchImpl,
  processedDiscourseEventStore
}) {
  const body = await readBody(request);
  if (!verifyDiscourseSignature({
    body,
    timestamp: request.headers["x-github-pr-bridge-timestamp"],
    signatureHeader: request.headers["x-github-pr-bridge-signature"],
    secret: config.discourseSharedSecret
  })) {
    return sendJson(response, 403, { error: "invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(response, 400, { error: "invalid json" });
  }

  if (payload.event_type !== "discourse_post_created") {
    return sendJson(response, 422, { error: "unsupported event type" });
  }

  const validationError = validateDiscoursePostPayload(payload);
  if (validationError) {
    return sendJson(response, 422, { error: validationError });
  }

  if (await processedDiscourseEventStore.has(payload.event_id)) {
    return sendJson(response, 200, { ok: true, duplicate: true });
  }
  if (!(await processedDiscourseEventStore.claim(payload.event_id))) {
    return sendJson(response, 200, { ok: true, duplicate: true, processing: true });
  }

  let githubResponse;
  try {
    githubResponse = await createGitHubIssueComment({ payload, config, fetchImpl });
    if (githubResponse.ok) {
      await processedDiscourseEventStore.markProcessed(payload.event_id);
    }
  } finally {
    await processedDiscourseEventStore.release(payload.event_id);
  }

  return sendJson(response, githubResponse.ok ? 200 : 502, githubResponse);
}

function validateDiscoursePostPayload(payload) {
  if (!payload.event_id) {
    return "missing event id";
  }
  if (!payload.github_repo || !/^[^/]+\/[^/]+$/.test(payload.github_repo)) {
    return "invalid github repo";
  }
  if (!Number.isInteger(payload.github_pr_number) || payload.github_pr_number <= 0) {
    return "invalid github pr number";
  }
  if (!payload.raw) {
    return "missing raw";
  }

  return null;
}

export async function createGitHubIssueComment({ payload, config, fetchImpl = fetch }) {
  if (!config.githubToken) {
    throw new Error("githubToken is required");
  }

  const response = await fetchImpl(githubIssueCommentsUrl({ repo: payload.github_repo, issueNumber: payload.github_pr_number }), {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${config.githubToken}`,
      "content-type": "application/json",
      "user-agent": "discourse-github-pr-bridge"
    },
    body: JSON.stringify({ body: payload.raw })
  });

  const responseBody = await parseResponseBody(response);

  return {
    ok: response.ok,
    status: response.status,
    github_comment_id: responseBody?.id,
    github: responseBody
  };
}

export function githubIssueCommentsUrl({ repo, issueNumber }) {
  return new URL(`/repos/${repo}/issues/${issueNumber}/comments`, "https://api.github.com").toString();
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createProcessedDiscourseEventStore(processedEventsPath) {
  if (processedEventsPath) {
    return new JsonlProcessedEventStore(processedEventsPath);
  }

  return new MemoryProcessedEventStore();
}

class MemoryProcessedEventStore {
  constructor() {
    this.processedEventIds = new Set();
    this.inFlightEventIds = new Set();
  }

  async has(eventId) {
    return this.processedEventIds.has(eventId);
  }

  async claim(eventId) {
    if (this.processedEventIds.has(eventId) || this.inFlightEventIds.has(eventId)) {
      return false;
    }

    this.inFlightEventIds.add(eventId);
    return true;
  }

  async markProcessed(eventId) {
    this.processedEventIds.add(eventId);
  }

  async release(eventId) {
    this.inFlightEventIds.delete(eventId);
  }
}

class JsonlProcessedEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.processedEventIds = new Set();
    this.inFlightEventIds = new Set();
    this.loaded = false;
  }

  async has(eventId) {
    await this.load();
    return this.processedEventIds.has(eventId);
  }

  async claim(eventId) {
    await this.load();
    if (this.processedEventIds.has(eventId) || this.inFlightEventIds.has(eventId)) {
      return false;
    }

    this.inFlightEventIds.add(eventId);
    return true;
  }

  async markProcessed(eventId) {
    await this.load();
    if (this.processedEventIds.has(eventId)) {
      return;
    }

    await this.append({ action: "processed", event_id: eventId, processed_at: new Date().toISOString() });
    this.processedEventIds.add(eventId);
  }

  async release(eventId) {
    this.inFlightEventIds.delete(eventId);
  }

  async load() {
    if (this.loaded) {
      return;
    }

    try {
      const data = await readFile(this.filePath, "utf8");
      for (const line of data.split("\n")) {
        if (!line.trim()) {
          continue;
        }

        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!record.event_id) {
          continue;
        }
        if (record.action === "delete") {
          this.processedEventIds.delete(record.event_id);
        } else {
          this.processedEventIds.add(record.event_id);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.loaded = true;
  }

  async append(record) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`);
  }
}

function readConfig(config = {}) {
  const resolved = {
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET,
    githubToken: config.githubToken ?? process.env.GITHUB_TOKEN,
    discourseBaseUrl: config.discourseBaseUrl ?? process.env.DISCOURSE_BASE_URL,
    discourseSharedSecret: config.discourseSharedSecret ?? process.env.DISCOURSE_SHARED_SECRET,
    processedEventsPath: config.processedEventsPath ?? process.env.PROCESSED_EVENTS_PATH
  };

  for (const [key, value] of Object.entries(resolved)) {
    if (!["githubToken", "processedEventsPath"].includes(key) && !value) {
      throw new Error(`${key} is required`);
    }
  }

  return resolved;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
