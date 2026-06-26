import crypto from "node:crypto";
import http from "node:http";
import { normalizeGitHubWebhook } from "./normalize.js";
import { signDiscourseRequest } from "./signature.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function createServer({ config, fetchImpl = fetch } = {}) {
  const resolvedConfig = readConfig(config);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { ok: true });
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
  const actualBuffer = Buffer.from(signatureHeader);
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

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = await response.text();
  }

  return {
    ok: response.ok,
    status: response.status,
    discourse: responseBody
  };
}

export function discourseEventsUrl(baseUrl) {
  return new URL("/github-pr-bridge/events.json", baseUrl).toString();
}

function readConfig(config = {}) {
  const resolved = {
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET,
    discourseBaseUrl: config.discourseBaseUrl ?? process.env.DISCOURSE_BASE_URL,
    discourseSharedSecret: config.discourseSharedSecret ?? process.env.DISCOURSE_SHARED_SECRET
  };

  for (const [key, value] of Object.entries(resolved)) {
    if (!value) {
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
