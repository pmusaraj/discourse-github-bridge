import crypto from "node:crypto";
import http from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeGitHubWebhook } from "./normalize.js";
import { signDiscourseRequest } from "./signature.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_APP_TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

export function createServer({ config, fetchImpl = fetch } = {}) {
  const resolvedConfig = readConfig(config);
  const processedDiscourseEventStore = createProcessedDiscourseEventStore(resolvedConfig.processedEventsPath);
  const githubAppInstallationStore = new GitHubAppInstallationStore(resolvedConfig);
  const startupInstallationSync = shouldSyncGitHubAppInstallationsOnStart(resolvedConfig)
    ? syncGitHubAppInstallations({ config: resolvedConfig, fetchImpl }).catch((error) => {
      resolvedConfig.logger.warn("github_app_installation_sync_failed", { error: safeErrorName(error) });
      return null;
    })
    : Promise.resolve(null);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "GET" && request.url === "/github/app/setup") {
        return sendJson(response, 200, githubAppSetupPayload({ config: resolvedConfig, request }));
      }

      if (request.method === "GET" && request.url === "/github/app/manifest") {
        return sendJson(response, 200, githubAppManifest({ config: resolvedConfig, request }));
      }

      if (request.method === "GET" && request.url === "/github/app/installations") {
        await startupInstallationSync;
        return sendJson(response, 200, {
          repositories: await githubAppInstallationStore.repositories()
        });
      }

      if (request.method === "POST" && request.url === "/github/app/installations/sync") {
        if (!verifyAdminSecret({
          secretHeader: request.headers["x-github-pr-bridge-admin-secret"],
          secret: resolvedConfig.discourseSharedSecret
        })) {
          return sendJson(response, 403, { error: "invalid admin secret" });
        }

        const result = await syncGitHubAppInstallations({ config: resolvedConfig, fetchImpl });
        return sendJson(response, 200, result);
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

      const eventName = request.headers["x-github-event"];
      if (["installation", "installation_repositories"].includes(eventName)) {
        const result = await handleGitHubAppInstallationEvent({
          eventName,
          payload,
          githubAppInstallationStore
        });
        return sendJson(response, 200, result);
      }

      let normalized;
      try {
        normalized = normalizeGitHubWebhook({
          eventName,
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

function verifyAdminSecret({ secretHeader, secret }) {
  return Boolean(secretHeader && secret) && timingSafeStringEqual(secretHeader, secret);
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

  const response = await fetchWithRetry({
    config,
    operation: () => fetchImpl(discourseEventsUrl(config.discourseBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-pr-bridge-timestamp": timestamp,
        "x-github-pr-bridge-signature": signature
      },
      body
    }),
    retryMessage: "discourse_forward_retry",
    context: {
      direction: "github_to_discourse",
      event_id: event.event_id,
      event_type: event.event_type
    }
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

export function githubAppSetupPayload({ config, request }) {
  const manifest = githubAppManifest({ config, request });
  const createBaseUrl = config.githubAppOwner
    ? `https://github.com/organizations/${encodeURIComponent(config.githubAppOwner)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const createUrl = new URL(createBaseUrl);
  createUrl.searchParams.set("manifest", JSON.stringify(manifest));

  return {
    create_url: createUrl.toString(),
    manifest
  };
}

export function githubAppManifest({ config, request }) {
  const serviceBaseUrl = servicePublicBaseUrl({ config, request });

  return {
    name: config.githubAppName,
    url: config.discourseBaseUrl,
    hook_attributes: {
      url: new URL("/github/webhook", serviceBaseUrl).toString(),
      active: true
    },
    redirect_url: new URL("/github/app/installations", serviceBaseUrl).toString(),
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
  };
}

function servicePublicBaseUrl({ config, request }) {
  if (config.serviceBaseUrl) {
    return config.serviceBaseUrl;
  }

  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

async function handleGitHubAppInstallationEvent({ eventName, payload, githubAppInstallationStore }) {
  const installationId = payload.installation?.id;
  if (!installationId) {
    return { ok: false, error: "missing installation id" };
  }

  if (eventName === "installation") {
    if (payload.action === "deleted") {
      const removed = await githubAppInstallationStore.removeInstallationRepositories({
        installationId,
        repositories: repositoriesFromPayload(payload.repositories)
      });
      return { ok: true, action: "removed_installation_repositories", installation_id: installationId, repositories: removed };
    }

    const upserted = await githubAppInstallationStore.upsertRepositories({
      installationId,
      repositories: repositoriesFromPayload(payload.repositories)
    });
    return { ok: true, action: "upserted_installation_repositories", installation_id: installationId, repositories: upserted };
  }

  const removed = await githubAppInstallationStore.removeRepositories(repositoriesFromPayload(payload.repositories_removed));
  const upserted = await githubAppInstallationStore.upsertRepositories({
    installationId,
    repositories: repositoriesFromPayload(payload.repositories_added)
  });

  return {
    ok: true,
    action: "updated_installation_repositories",
    installation_id: installationId,
    repositories_added: upserted,
    repositories_removed: removed
  };
}

function repositoriesFromPayload(repositories = []) {
  return repositories.map((repository) => repository.full_name).filter(Boolean);
}

class GitHubAppInstallationStore {
  constructor(config) {
    this.config = config;
  }

  async repositories() {
    return await this.load();
  }

  async upsertRepositories({ installationId, repositories }) {
    if (!repositories.length) {
      return [];
    }

    const data = await this.load();
    for (const repo of repositories) {
      data[repo.toLowerCase()] = installationId;
    }
    await this.save(data);
    return repositories;
  }

  async removeRepositories(repositories) {
    if (!repositories.length) {
      return [];
    }

    const data = await this.load();
    for (const repo of repositories) {
      delete data[repo.toLowerCase()];
    }
    await this.save(data);
    return repositories;
  }

  async removeInstallationRepositories({ installationId, repositories }) {
    const data = await this.load();
    const explicitRepositories = repositories.map((repo) => repo.toLowerCase());
    const repositoriesToRemove = explicitRepositories.length ? explicitRepositories : Object.entries(data)
      .filter(([, storedInstallationId]) => String(storedInstallationId) === String(installationId))
      .map(([repo]) => repo);

    for (const repo of repositoriesToRemove) {
      delete data[repo];
    }
    await this.save(data);
    return repositoriesToRemove;
  }

  async replaceRepositories(data) {
    const normalized = normalizeInstallationMap(data);
    await this.save(normalized);
    return normalized;
  }

  async load() {
    if (this.config.githubAppInstallationsCache) {
      return this.config.githubAppInstallationsCache;
    }

    if (this.config.githubAppInstallations) {
      this.config.githubAppInstallationsCache = normalizeInstallationMap(this.config.githubAppInstallations);
      return this.config.githubAppInstallationsCache;
    }

    if (!this.config.githubAppInstallationsPath) {
      this.config.githubAppInstallationsCache = {};
      return this.config.githubAppInstallationsCache;
    }

    try {
      const data = JSON.parse(await readFile(this.config.githubAppInstallationsPath, "utf8"));
      this.config.githubAppInstallationsCache = normalizeInstallationMap(data);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.config.githubAppInstallationsCache = {};
    }

    return this.config.githubAppInstallationsCache;
  }

  async save(data) {
    if (!this.config.githubAppInstallationsPath) {
      this.config.githubAppInstallations = data;
      this.config.githubAppInstallationsCache = data;
      return;
    }

    await mkdir(dirname(this.config.githubAppInstallationsPath), { recursive: true });
    await writeFile(
      this.config.githubAppInstallationsPath,
      `${JSON.stringify({ repositories: data }, null, 2)}\n`
    );
    this.config.githubAppInstallationsCache = data;
  }
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

export async function syncGitHubAppInstallations({ config, fetchImpl = fetch }) {
  const store = new GitHubAppInstallationStore(config);
  const installations = await fetchGitHubAppInstallations({ config, fetchImpl });
  const repositories = {};

  for (const installation of installations) {
    const installationId = installation.id;
    if (!installationId) {
      continue;
    }

    const token = await createGitHubAppInstallationToken({ installationId, config, fetchImpl });
    const installationRepositories = await fetchGitHubInstallationRepositories({ token, fetchImpl });
    for (const repository of installationRepositories) {
      if (repository.full_name) {
        repositories[repository.full_name.toLowerCase()] = installationId;
      }
    }
  }

  const normalized = await store.replaceRepositories(repositories);
  return {
    ok: true,
    action: "synced_installation_repositories",
    installations: installations.length,
    repositories: normalized
  };
}

function shouldSyncGitHubAppInstallationsOnStart(config) {
  return config.githubAppSyncOnStart !== false
    && !config.githubToken
    && Boolean(config.githubAppId)
    && Boolean(config.githubAppPrivateKey || config.githubAppPrivateKeyPath)
    && Boolean(config.githubAppInstallationsPath || config.githubAppInstallations);
}

async function fetchGitHubAppInstallations({ config, fetchImpl }) {
  const jwt = await createGitHubAppJwt(config);
  const installations = [];
  let url = githubAppInstallationsUrl();

  while (url) {
    const response = await fetchImpl(url, {
      headers: githubAppApiHeaders(`Bearer ${jwt}`)
    });
    const responseBody = await parseResponseBody(response);

    if (!response.ok) {
      const message = typeof responseBody === "string" ? responseBody : responseBody?.message;
      throw new Error(`GitHub App installations request failed: ${response.status}${message ? ` ${message}` : ""}`);
    }

    if (!Array.isArray(responseBody)) {
      throw new Error("GitHub App installations response must be an array");
    }

    installations.push(...responseBody);
    url = nextPageUrl(response.headers.get("link"));
  }

  return installations;
}

async function createGitHubAppInstallationToken({ installationId, config, fetchImpl }) {
  const jwt = await createGitHubAppJwt(config);
  const response = await fetchImpl(githubAppInstallationTokenUrl({ installationId }), {
    method: "POST",
    headers: githubAppApiHeaders(`Bearer ${jwt}`)
  });
  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    const message = typeof responseBody === "string" ? responseBody : responseBody?.message;
    throw new Error(`GitHub App installation token request failed: ${response.status}${message ? ` ${message}` : ""}`);
  }

  if (!responseBody?.token) {
    throw new Error("GitHub App installation token response missing token");
  }

  return responseBody.token;
}

async function fetchGitHubInstallationRepositories({ token, fetchImpl }) {
  const repositories = [];
  let url = githubInstallationRepositoriesUrl();

  while (url) {
    const response = await fetchImpl(url, {
      headers: githubAppApiHeaders(`Bearer ${token}`)
    });
    const responseBody = await parseResponseBody(response);

    if (!response.ok) {
      const message = typeof responseBody === "string" ? responseBody : responseBody?.message;
      throw new Error(`GitHub installation repositories request failed: ${response.status}${message ? ` ${message}` : ""}`);
    }

    repositories.push(...(responseBody?.repositories ?? []));
    url = nextPageUrl(response.headers.get("link"));
  }

  return repositories;
}

function githubAppInstallationsUrl() {
  return new URL("/app/installations?per_page=100", GITHUB_API_BASE_URL).toString();
}

function githubInstallationRepositoriesUrl() {
  return new URL("/installation/repositories?per_page=100", GITHUB_API_BASE_URL).toString();
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  for (const link of linkHeader.split(",")) {
    const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") {
      return match[1];
    }
  }

  return null;
}

function githubAppApiHeaders(authorization) {
  return {
    "accept": "application/vnd.github+json",
    "authorization": authorization,
    "user-agent": "discourse-github-pr-bridge",
    "x-github-api-version": "2022-11-28"
  };
}

export async function createGitHubIssueComment({ payload, config, fetchImpl = fetch }) {
  const authorization = await resolveGitHubAuthorizationHeader({
    repo: payload.github_repo,
    config,
    fetchImpl
  });

  const response = await fetchImpl(githubIssueCommentsUrl({ repo: payload.github_repo, issueNumber: payload.github_pr_number }), {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": authorization,
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
  return new URL(`/repos/${repo}/issues/${issueNumber}/comments`, GITHUB_API_BASE_URL).toString();
}

export function githubAppInstallationTokenUrl({ installationId }) {
  return new URL(`/app/installations/${installationId}/access_tokens`, GITHUB_API_BASE_URL).toString();
}

export async function resolveGitHubAuthorizationHeader({ repo, config, fetchImpl = fetch }) {
  if (config.githubToken) {
    return `Bearer ${config.githubToken}`;
  }

  const token = await createGitHubInstallationAccessToken({ repo, config, fetchImpl });
  return `Bearer ${token}`;
}

export async function createGitHubInstallationAccessToken({ repo, config, fetchImpl = fetch }) {
  const installationId = await githubAppInstallationIdForRepo({ repo, config });
  if (!installationId) {
    throw new Error(`missing GitHub App installation for ${repo}`);
  }

  const cacheKey = String(installationId);
  const cached = config.githubAppTokenCache?.get(cacheKey);
  if (cached && cached.expiresAtMs - GITHUB_APP_TOKEN_CACHE_SKEW_MS > Date.now()) {
    return cached.token;
  }

  const jwt = await createGitHubAppJwt(config);
  const response = await fetchImpl(githubAppInstallationTokenUrl({ installationId }), {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "discourse-github-pr-bridge"
    },
    body: JSON.stringify({ repositories: [repo.split("/")[1]] })
  });
  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    const message = typeof responseBody === "string" ? responseBody : responseBody?.message;
    throw new Error(`GitHub App installation token request failed: ${response.status}${message ? ` ${message}` : ""}`);
  }
  if (!responseBody?.token) {
    throw new Error("GitHub App installation token response missing token");
  }

  const expiresAtMs = responseBody.expires_at ? Date.parse(responseBody.expires_at) : Date.now() + 50 * 60 * 1000;
  config.githubAppTokenCache?.set(cacheKey, { token: responseBody.token, expiresAtMs });
  return responseBody.token;
}

export async function githubAppInstallationIdForRepo({ repo, config }) {
  const installations = await githubAppInstallations(config);
  return installations[repo.toLowerCase()];
}

async function githubAppInstallations(config) {
  if (config.githubAppInstallations) {
    return normalizeInstallationMap(config.githubAppInstallations);
  }

  if (!config.githubAppInstallationsPath) {
    return {};
  }

  if (config.githubAppInstallationsCache) {
    return config.githubAppInstallationsCache;
  }

  const data = JSON.parse(await readFile(config.githubAppInstallationsPath, "utf8"));
  config.githubAppInstallationsCache = normalizeInstallationMap(data);
  return config.githubAppInstallationsCache;
}

function normalizeInstallationMap(data) {
  const source = data.repositories ?? data;
  return Object.fromEntries(
    Object.entries(source).map(([repo, installationId]) => [repo.toLowerCase(), installationId])
  );
}

export async function createGitHubAppJwt(config) {
  if (!config.githubAppId) {
    throw new Error("githubToken or GitHub App credentials are required");
  }

  const privateKey = await githubAppPrivateKey(config);
  if (!privateKey) {
    throw new Error("githubToken or GitHub App credentials are required");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(config.githubAppId)
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function githubAppPrivateKey(config) {
  if (config.githubAppPrivateKey) {
    return normalizePrivateKey(config.githubAppPrivateKey);
  }

  if (config.githubAppPrivateKeyPath) {
    return normalizePrivateKey(await readFile(config.githubAppPrivateKeyPath, "utf8"));
  }

  return null;
}

function normalizePrivateKey(privateKey) {
  return privateKey.replace(/\\n/g, "\n");
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
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

async function fetchWithRetry({ config, operation, retryMessage, context = {} }) {
  const maxAttempts = Math.max(1, config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await operation();
      if (!shouldRetryResponse(response) || attempt === maxAttempts) {
        return response;
      }

      logRetry(config, retryMessage, { ...context, attempt, max_attempts: maxAttempts, status: response.status });
      await cancelResponseBody(response);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }

      logRetry(config, retryMessage, { ...context, attempt, max_attempts: maxAttempts, error: safeErrorName(error) });
    }

    await sleep(retryDelayMs(config, attempt));
  }

  throw lastError;
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation failures; the retry attempt should still proceed.
  }
}

function safeErrorName(error) {
  return error?.name || "Error";
}

function shouldRetryResponse(response) {
  return RETRYABLE_STATUSES.has(response.status);
}

function logRetry(config, message, fields) {
  (config.logger ?? createJsonLogger()).warn(message, fields);
}

function retryDelayMs(config, attempt) {
  const baseDelay = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  return baseDelay * 2 ** (attempt - 1);
}

function sleep(delayMs) {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

function numberConfig(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanConfig(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function createJsonLogger() {
  return {
    info: (message, fields = {}) => writeJsonLog("info", message, fields),
    warn: (message, fields = {}) => writeJsonLog("warn", message, fields),
    error: (message, fields = {}) => writeJsonLog("error", message, fields)
  };
}

function writeJsonLog(level, message, fields) {
  const record = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields
  };
  const output = JSON.stringify(record);
  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }
}

function readConfig(config = {}) {
  const resolved = {
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET,
    githubToken: config.githubToken ?? process.env.GITHUB_TOKEN,
    githubAppId: config.githubAppId ?? process.env.GITHUB_APP_ID,
    githubAppPrivateKey: config.githubAppPrivateKey ?? process.env.GITHUB_APP_PRIVATE_KEY,
    githubAppPrivateKeyPath: config.githubAppPrivateKeyPath ?? process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    githubAppInstallations: config.githubAppInstallations,
    githubAppInstallationsPath: config.githubAppInstallationsPath ?? process.env.GITHUB_APP_INSTALLATIONS_PATH,
    githubAppSyncOnStart: booleanConfig(config.githubAppSyncOnStart ?? process.env.GITHUB_APP_SYNC_ON_START, true),
    githubAppTokenCache: config.githubAppTokenCache ?? new Map(),
    githubAppName: config.githubAppName ?? process.env.GITHUB_APP_NAME ?? "Discourse GitHub PR Bridge",
    githubAppOwner: config.githubAppOwner ?? process.env.GITHUB_APP_OWNER,
    serviceBaseUrl: config.serviceBaseUrl ?? process.env.SERVICE_BASE_URL,
    discourseBaseUrl: config.discourseBaseUrl ?? process.env.DISCOURSE_BASE_URL,
    discourseSharedSecret: config.discourseSharedSecret ?? process.env.DISCOURSE_SHARED_SECRET,
    processedEventsPath: config.processedEventsPath ?? process.env.PROCESSED_EVENTS_PATH,
    retryAttempts: numberConfig(config.retryAttempts ?? process.env.RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS),
    retryDelayMs: numberConfig(config.retryDelayMs ?? process.env.RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    logger: config.logger ?? createJsonLogger()
  };

  for (const [key, value] of Object.entries(resolved)) {
    if (!["githubToken", "githubAppId", "githubAppPrivateKey", "githubAppPrivateKeyPath", "githubAppInstallations", "githubAppInstallationsPath", "githubAppSyncOnStart", "githubAppTokenCache", "githubAppName", "githubAppOwner", "serviceBaseUrl", "processedEventsPath", "retryAttempts", "retryDelayMs", "logger"].includes(key) && !value) {
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
