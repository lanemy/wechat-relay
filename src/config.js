// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const SUPPORTED_NODE_MAJORS = new Set([20, 22, 24]);
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const MAX_ACCOUNTS = 16;
const MAX_ACCOUNTS_FILE_BYTES = 65_536;
const ACCOUNT_KEYS = ["appId", "appSecret", "id", "relayToken"];

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!SUPPORTED_NODE_MAJORS.has(major)) {
    throw new ConfigurationError(
      "unsupported_NODE_VERSION",
      "Node.js major version must be 20, 22, or 24.",
    );
  }
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    throw new ConfigurationError(`missing_${name}`, `${name} is required.`);
  }
  return value;
}

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = String(env[name] ?? "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `invalid_${name}`,
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function validateRelayToken(token) {
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN",
      "RELAY_TOKEN must use visible ASCII base64, base64url, hex, or equivalent token characters.",
    );
  }
  const byteLength = Buffer.byteLength(token, "utf8");
  const minimumEncodedLength = /^[0-9a-f]+$/iu.test(token) ? 64 : 43;
  if (byteLength < minimumEncodedLength || byteLength > 512) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN_length",
      "RELAY_TOKEN must encode at least 32 random bytes (43 base64/base64url characters or 64 hex characters) and be at most 512 characters.",
    );
  }
}

function assertAccountRelayToken(token) {
  try {
    validateRelayToken(token);
  } catch (error) {
    throw new ConfigurationError(
      error.code === "invalid_RELAY_TOKEN" ? "invalid_account_relay_token" : "invalid_account_relay_token_length",
      "Each relayToken must use visible ASCII token characters and encode at least 32 random bytes (43 base64/base64url characters or 64 hex characters).",
    );
  }
}

function loadAccountsFile(filename) {
  if (filename.includes("\u0000")) {
    throw new ConfigurationError("invalid_ACCOUNTS_FILE", "ACCOUNTS_FILE contains a null byte.");
  }
  const resolved = path.resolve(filename);
  let stat = null;
  try {
    stat = fs.statSync(resolved, { throwIfNoEntry: false });
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) {
    throw new ConfigurationError("accounts_file_missing", "ACCOUNTS_FILE must reference an existing regular file.");
  }
  if (stat.mode & 0o077) {
    throw new ConfigurationError(
      "accounts_file_permissions",
      "The accounts file must not be readable or writable by group or others (chmod 600).",
    );
  }
  if (stat.size > MAX_ACCOUNTS_FILE_BYTES) {
    throw new ConfigurationError("accounts_file_too_large", "The accounts file must be at most 65536 bytes.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new ConfigurationError("invalid_accounts_json", "ACCOUNTS_FILE must contain valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigurationError(
      "invalid_accounts_shape",
      "The accounts file must be a JSON array with at least one account.",
    );
  }
  if (parsed.length > MAX_ACCOUNTS) {
    throw new ConfigurationError("too_many_accounts", "The accounts file supports at most 16 accounts.");
  }
  const seenIds = new Set();
  const seenAppIds = new Set();
  const seenTokens = new Set();
  return parsed.map((entry) => {
    const wellFormed = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(ACCOUNT_KEYS);
    if (!wellFormed) {
      throw new ConfigurationError(
        "invalid_accounts_shape",
        "Each account must be an object with exactly the keys id, appId, appSecret, and relayToken.",
      );
    }
    if (typeof entry.id !== "string" || !ACCOUNT_ID_PATTERN.test(entry.id)) {
      throw new ConfigurationError(
        "invalid_account_id",
        "Account ids must be 1-32 lowercase letters, digits, or hyphens, and must start and end with a letter or digit.",
      );
    }
    for (const key of ["appId", "appSecret"]) {
      if (typeof entry[key] !== "string" || !entry[key] || entry[key].length > 256) {
        throw new ConfigurationError(
          "invalid_accounts_shape",
          `${key} must be a non-empty string of at most 256 characters.`,
        );
      }
    }
    assertAccountRelayToken(entry.relayToken);
    if (seenIds.has(entry.id)) {
      throw new ConfigurationError("duplicate_account_id", "Account ids must be unique.");
    }
    if (seenAppIds.has(entry.appId)) {
      throw new ConfigurationError("duplicate_account_app_id", "Account appIds must be unique.");
    }
    if (seenTokens.has(entry.relayToken)) {
      throw new ConfigurationError("duplicate_account_relay_token", "Account relay tokens must be unique.");
    }
    seenIds.add(entry.id);
    seenAppIds.add(entry.appId);
    seenTokens.add(entry.relayToken);
    return Object.freeze({
      id: entry.id,
      appId: entry.appId,
      appSecret: entry.appSecret,
      relayToken: entry.relayToken,
    });
  });
}

export function loadConfig(env = process.env) {
  assertSupportedNodeVersion();
  const accountsFile = String(env.ACCOUNTS_FILE ?? "").trim();
  let profile = "legacy";
  let accounts;
  let appId;
  let appSecret;
  let relayToken;
  if (accountsFile) {
    for (const name of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"]) {
      if (String(env[name] ?? "").trim()) {
        throw new ConfigurationError(
          "ambiguous_account_config",
          "ACCOUNTS_FILE cannot be combined with WECHAT_APP_ID, WECHAT_APP_SECRET, or RELAY_TOKEN.",
        );
      }
    }
    profile = "accounts";
    accounts = loadAccountsFile(accountsFile);
  } else {
    appId = required(env, "WECHAT_APP_ID");
    appSecret = required(env, "WECHAT_APP_SECRET");
    relayToken = required(env, "RELAY_TOKEN");
    validateRelayToken(relayToken);
    accounts = [Object.freeze({ id: "default", appId, appSecret, relayToken })];
  }

  const host = String(env.HOST ?? "").trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigurationError(
      "non_loopback_HOST",
      "HOST must be 127.0.0.1 or ::1. Put a private or TLS reverse proxy in front.",
    );
  }

  const dbPathValue = String(env.DB_PATH ?? "").trim() || "./data/idempotency.sqlite3";
  if (dbPathValue.includes("\u0000")) {
    throw new ConfigurationError("invalid_DB_PATH", "DB_PATH contains a null byte.");
  }

  return Object.freeze({
    profile,
    accounts,
    host,
    port: boundedInteger(env, "PORT", 18_794, 1_024, 65_535),
    dbPath: dbPathValue === ":memory:" ? dbPathValue : path.resolve(dbPathValue),
    maxJsonBodyBytes: boundedInteger(env, "MAX_JSON_BODY_BYTES", 4 * 1024 * 1024, 1_024, 8 * 1024 * 1024),
    maxMediaBodyBytes: boundedInteger(env, "MAX_MEDIA_BODY_BYTES", 20 * 1024 * 1024, 1_024, 32 * 1024 * 1024),
    maxUpstreamResponseBytes: boundedInteger(
      env,
      "MAX_UPSTREAM_RESPONSE_BYTES",
      2 * 1024 * 1024,
      1_024,
      8 * 1024 * 1024,
    ),
    bodyTimeoutMs: boundedInteger(env, "BODY_TIMEOUT_MS", 15_000, 1_000, 60_000),
    upstreamTimeoutMs: boundedInteger(env, "UPSTREAM_TIMEOUT_MS", 25_000, 1_000, 120_000),
    rateLimitWindowMs: boundedInteger(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    rateLimitMaxRequests: boundedInteger(env, "RATE_LIMIT_MAX_REQUESTS", 60, 1, 10_000),
    healthRateLimitMaxRequests: boundedInteger(
      env,
      "HEALTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    preauthRateLimitMaxRequests: boundedInteger(
      env,
      "PREAUTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    maxConcurrentUpstream: boundedInteger(env, "MAX_CONCURRENT_UPSTREAM", 4, 1, 32),
    maxConnections: boundedInteger(env, "MAX_CONNECTIONS", 64, 4, 512),
    idempotencyMaxRecords: boundedInteger(
      env,
      "IDEMPOTENCY_MAX_RECORDS",
      10_000,
      100,
      100_000,
    ),
    idempotencyFailedSafeRetentionMs: boundedInteger(
      env,
      "IDEMPOTENCY_FAILED_SAFE_RETENTION_MS",
      7 * 24 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
    ),
  });
}

export function isLoopbackAddress(address) {
  const normalized = String(address ?? "").toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}
