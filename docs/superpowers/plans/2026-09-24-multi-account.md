# Multi-Account Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve up to 16 WeChat Official Accounts from one relay process, selected by the bearer token, with the legacy single-account deployment byte-identical to today.

**Architecture:** `loadConfig()` gains two mutually exclusive profiles — legacy env credentials (synthesized as one `default` account) and an `ACCOUNTS_FILE` JSON file. `authenticate()` resolves the presented token to exactly one account. The server keeps a `Map<accountId, WechatClient>` and threads the account id into an account-namespaced idempotency digest (v2 domain; legacy stays v1).

**Tech Stack:** Zero-framework Node.js (`node:http`), ES modules, `better-sqlite3`, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-multi-account-design.md` — the plan argues from the spec; read both.

## Global Constraints

- `npm run check` (test + lint + syntax + secret-scan) must be green after every task.
- `THREAT_MODEL.md` carries a digest over every git-tracked file; **any tracked-file change invalidates it**. Verification cycle for every task: `git add -A && npm run snapshot:write && npm run check`, then commit. (Untracked files only enter the digest once staged.)
- Route table (`src/routes.js`) must not change. No new routes.
- Eslint `no-console` is an error — use the logger. AGPL SPDX header comment on every new source/test file.
- Synthetic credentials only in tests/examples. Never write a literal token ≥24 token-chars (`secret-scan` `literal-secret-field` rule is case-insensitive on the key `relayToken`); construct tokens programmatically (`"a".repeat(48)`). AppIds in committed files must not match `/\bwx[0-9a-f]{16}\b/iu`.
- Account count cap: 16. Accounts file size cap: 65,536 bytes. Account id pattern: `^[a-z0-9][a-z0-9-]{0,31}$`.
- Legacy profile must keep byte-identical behavior: same error codes, same `/v1/ready` failure path (502 bubbling), same idempotency digests (v1 domain).

---

### Task 1: Config — accounts profile and accounts.json validation

**Files:**
- Modify: `src/config.js`
- Create: `test/config-accounts.test.js`
- Modify: `test/config-auth.test.js` (two assertion spots)
- Modify: `.env.example` (add `ACCOUNTS_FILE=`)

**Interfaces:**
- Produces: `loadConfig(env)` returns frozen config now containing `profile: "legacy" | "accounts"` and `accounts: readonly [{ id, appId, appSecret, relayToken }]`. In this task the legacy top-level `appId`/`appSecret`/`relayToken` fields are **kept** (removed in Task 3) so untouched consumers stay green. New error codes: `ambiguous_account_config`, `invalid_ACCOUNTS_FILE`, `accounts_file_missing`, `accounts_file_permissions`, `accounts_file_too_large`, `invalid_accounts_json`, `invalid_accounts_shape`, `too_many_accounts`, `invalid_account_id`, `invalid_account_relay_token`, `invalid_account_relay_token_length`, `duplicate_account_id`, `duplicate_account_app_id`, `duplicate_account_relay_token`.

- [ ] **Step 1: Write the failing tests**

Create `test/config-accounts.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function tokenA() {
  return "a".repeat(48);
}

function tokenB() {
  return "b".repeat(48);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wechat-relay-accounts-"));
}

function writeAccounts(dir, entries, mode = 0o600, name = "accounts.json") {
  const filename = path.join(dir, name);
  fs.writeFileSync(filename, `${JSON.stringify(entries, null, 2)}\n`, { mode });
  fs.chmodSync(filename, mode);
  return filename;
}

function validEntries() {
  return [
    { id: "main", appId: "synthetic-app-id-main", appSecret: "synthetic-secret-main", relayToken: tokenA() },
    { id: "tech", appId: "synthetic-app-id-tech", appSecret: "synthetic-secret-tech", relayToken: tokenB() },
  ];
}

test("accounts profile loads validated accounts and omits legacy fields", () => {
  const dir = tmpDir();
  const filename = writeAccounts(dir, validEntries());
  const config = loadConfig({ ACCOUNTS_FILE: filename });
  assert.equal(config.profile, "accounts");
  assert.equal(config.accounts.length, 2);
  assert.deepEqual(config.accounts[0], {
    id: "main",
    appId: "synthetic-app-id-main",
    appSecret: "synthetic-secret-main",
    relayToken: tokenA(),
  });
  assert.equal("relayToken" in config, false);
  assert.equal("appId" in config, false);
});

test("legacy profile synthesizes a single default account", () => {
  const config = loadConfig({
    WECHAT_APP_ID: "test-app-id",
    WECHAT_APP_SECRET: "test-app-secret",
    RELAY_TOKEN: tokenA(),
  });
  assert.equal(config.profile, "legacy");
  assert.deepEqual(config.accounts, [{
    id: "default",
    appId: "test-app-id",
    appSecret: "test-app-secret",
    relayToken: tokenA(),
  }]);
});

test("mixing ACCOUNTS_FILE with legacy credentials fails closed", () => {
  for (const name of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"]) {
    const dir = tmpDir();
    const filename = writeAccounts(dir, validEntries());
    const env = { ACCOUNTS_FILE: filename };
    env[name] = "anything";
    assert.throws(() => loadConfig(env), { code: "ambiguous_account_config" });
  }
});

test("accounts file must exist, be a regular file, and carry no group/world bits", () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ ACCOUNTS_FILE: path.join(dir, "missing.json") }),
    { code: "accounts_file_missing" },
  );
  for (const mode of [0o640, 0o604, 0o006, 0o666]) {
    const filename = writeAccounts(tmpDir(), validEntries(), mode);
    assert.throws(() => loadConfig({ ACCOUNTS_FILE: filename }), { code: "accounts_file_permissions" });
  }
});

test("accounts file size is bounded to 65536 bytes", () => {
  const dir = tmpDir();
  const filename = path.join(dir, "big.json");
  fs.writeFileSync(filename, `[${" ".repeat(65_600)}]`, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: filename }), { code: "accounts_file_too_large" });
});

test("accounts file must be a JSON array of well-formed account objects", () => {
  const dir = tmpDir();
  const bad = (content) => {
    const filename = path.join(dir, `case-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(filename, content, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    return filename;
  };
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: bad("not-json{") }), { code: "invalid_accounts_json" });
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: bad("{}") }), { code: "invalid_accounts_shape" });
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: bad("[]") }), { code: "invalid_accounts_shape" });
  assert.throws(() => {
    loadConfig({ ACCOUNTS_FILE: bad(JSON.stringify([{ id: "main", appId: "x", appSecret: "y", relayToken: tokenA(), note: "extra" }])) });
  }, { code: "invalid_accounts_shape" });
  assert.throws(() => {
    loadConfig({ ACCOUNTS_FILE: bad(JSON.stringify([{ id: "main", appId: "", appSecret: "y", relayToken: tokenA() }])) });
  }, { code: "invalid_accounts_shape" });
});

test("account ids follow the slug pattern and the roster is capped at sixteen", () => {
  const dir = tmpDir();
  for (const id of ["Main", "-main", "main--", "a".repeat(33), "ma in"]) {
    const entries = [{ id, appId: "x", appSecret: "y", relayToken: tokenA() }];
    assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), entries) }), { code: "invalid_account_id" });
  }
  const tooMany = Array.from({ length: 17 }, (_unused, index) => ({
    id: `account-${index}`,
    appId: `synthetic-app-${index}`,
    appSecret: `synthetic-secret-${index}`,
    relayToken: `${"a".repeat(40)}${index}`.slice(0, 48),
  }));
  assert.throws(
    () => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), tooMany) }),
    { code: "too_many_accounts" },
  );
});

test("account relay tokens must meet relay-token strength rules", () => {
  const entries = [{ id: "main", appId: "x", appSecret: "y", relayToken: "short" }];
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), entries) }), {
    code: "invalid_account_relay_token_length",
  });
  const charset = [{ id: "main", appId: "x", appSecret: "y", relayToken: "密".repeat(48) }];
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), charset) }), {
    code: "invalid_account_relay_token",
  });
});

test("duplicate ids, appIds, and relay tokens are rejected", () => {
  const dupId = [
    { id: "main", appId: "app-1", appSecret: "s1", relayToken: tokenA() },
    { id: "main", appId: "app-2", appSecret: "s2", relayToken: tokenB() },
  ];
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), dupId) }), { code: "duplicate_account_id" });
  const dupAppId = [
    { id: "main", appId: "app-1", appSecret: "s1", relayToken: tokenA() },
    { id: "tech", appId: "app-1", appSecret: "s2", relayToken: tokenB() },
  ];
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), dupAppId) }), { code: "duplicate_account_app_id" });
  const dupToken = [
    { id: "main", appId: "app-1", appSecret: "s1", relayToken: tokenA() },
    { id: "tech", appId: "app-2", appSecret: "s2", relayToken: tokenA() },
  ];
  assert.throws(() => loadConfig({ ACCOUNTS_FILE: writeAccounts(tmpDir(), dupToken) }), { code: "duplicate_account_relay_token" });
});

test("accounts file paths containing null bytes are rejected", () => {
  assert.throws(
    () => loadConfig({ ACCOUNTS_FILE: `bad${"\u0000"}path` }),
    { code: "invalid_ACCOUNTS_FILE" },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config-accounts.test.js`
Expected: FAIL — `loadConfig` ignores `ACCOUNTS_FILE` and throws `missing_WECHAT_APP_ID`.

- [ ] **Step 3: Implement in `src/config.js`**

Add at the top of the file:

```js
import fs from "node:fs";
```

Add after the `LOOPBACK_HOSTS` / `SUPPORTED_NODE_MAJORS` constants:

```js
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const MAX_ACCOUNTS = 16;
const MAX_ACCOUNTS_FILE_BYTES = 65_536;
const ACCOUNT_KEYS = ["appSecret", "appId", "id", "relayToken"];
```

Add a validator that reuses `validateRelayToken`:

```js
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
```

Add the loader:

```js
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
      throw new ConfigurationError("invalid_account_id", "Account ids must match ^[a-z0-9][a-z0-9-]{0,31}$.");
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
```

In `loadConfig`, replace the three `required`/`validateRelayToken` lines with the profile branch (legacy fields kept this task):

```js
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
```

In the returned frozen object add `profile`, `accounts`, and (legacy profile only) the legacy fields:

```js
  return Object.freeze({
    profile,
    accounts,
    ...(profile === "legacy" ? { appId, appSecret, relayToken } : {}),
    host,
```

- [ ] **Step 4: Adapt the two legacy-field assertions in `test/config-auth.test.js`**

Lines 49 and 54 read `loadConfig({...}).relayToken.length`. Change both to `.accounts[0].relayToken.length`. No other change — `missing_*` tests, the executable-exits test, and `testConfig`-free assertions still pass.

- [ ] **Step 5: Add `ACCOUNTS_FILE=` to `.env.example`**

Insert after the `RELAY_TOKEN=` line:

```
# 多公众号模式(可选): 指向权限 600 的账号配置 JSON 文件;
# 设置后不得再提供 WECHAT_APP_ID / WECHAT_APP_SECRET / RELAY_TOKEN
ACCOUNTS_FILE=
```

Non-comment lines must keep matching `^[A-Z0-9_]+=$` (static-contract enforces this).

- [ ] **Step 6: Verify and commit**

```bash
git add -A && npm run snapshot:write && npm run check
git commit -m "feat: load multi-account credentials from ACCOUNTS_FILE"
```

Expected: all tests pass; secret-scan clean (`accounts.example.json` does not exist yet — nothing new scanned).

---

### Task 2: Auth — token resolves to an account

**Files:**
- Modify: `src/auth.js`
- Modify: `src/server.js` (capture the authenticate() result; set the log field variable)
- Modify: `test/config-auth.test.js` (adapt + extend the authenticator test)

**Interfaces:**
- Consumes: `config.accounts` entries `{ id, appId, appSecret, relayToken }` from Task 1.
- Produces: `createAuthenticator(accounts)` accepts an array of `{ id, relayToken }`; `authenticate(req)` returns `{ id }` for the single matching account, throws the existing 401/400 errors otherwise. Signature is final for Tasks 3–4.

- [ ] **Step 1: Update the failing tests in `test/config-auth.test.js`**

Replace the test `"authentication accepts exactly one correct credential header"` (lines 138–166) with:

```js
test("authentication accepts exactly one correct credential header", () => {
  const token = "a".repeat(48);
  const authenticate = createAuthenticator([{ id: "default", relayToken: token }]);
  assert.deepEqual(authenticate({ headers: { authorization: `Bearer ${token}` } }), { id: "default" });
  assert.deepEqual(authenticate({ headers: { "x-relay-token": token } }), { id: "default" });
  assert.throws(() => authenticate({ headers: { authorization: "Bearer wrong" } }), { statusCode: 401 });
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}`, "x-relay-token": token },
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
  for (const headers of [
    { authorization: "", "x-relay-token": token },
    { authorization: `Bearer ${token}`, "x-relay-token": "" },
  ]) {
    assert.throws(
      () => authenticate({ headers }),
      { statusCode: 400, code: "ambiguous_authentication" },
    );
  }
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}` },
      rawHeaders: ["Authorization", `Bearer ${token}`, "Authorization", "Bearer other"],
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
});

test("authentication resolves the account matching the presented token", () => {
  const accounts = [
    { id: "main", relayToken: "a".repeat(48) },
    { id: "tech", relayToken: "b".repeat(48) },
  ];
  const authenticate = createAuthenticator(accounts);
  assert.deepEqual(
    authenticate({ headers: { "x-relay-token": accounts[1].relayToken } }),
    { id: "tech" },
  );
  assert.deepEqual(
    authenticate({ headers: { authorization: `Bearer ${accounts[0].relayToken}` } }),
    { id: "main" },
  );
  assert.throws(
    () => authenticate({ headers: { authorization: `Bearer ${"c".repeat(48)}` } }),
    { statusCode: 401, code: "unauthorized" },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config-auth.test.js`
Expected: FAIL — `createAuthenticator` takes a string, `digest(undefined)` throws or returns wrong type.

- [ ] **Step 3: Implement in `src/auth.js`**

Replace `createAuthenticator` (keep `digest` and `singleHeader` unchanged):

```js
export function createAuthenticator(accounts) {
  const expected = accounts.map((account) => ({
    id: account.id,
    digest: digest(account.relayToken),
  }));

  return function authenticate(req) {
    const authorization = singleHeader(req, "authorization");
    const legacyToken = singleHeader(req, "x-relay-token");
    if (authorization.present && legacyToken.present) {
      throw new HttpError(400, "ambiguous_authentication", "Use exactly one authentication header.");
    }

    let candidate = legacyToken.value;
    if (authorization.present) {
      const match = /^Bearer ([^\s]+)$/u.exec(authorization.value);
      if (!match) {
        throw new HttpError(
          401,
          "unauthorized",
          "A valid relay bearer token is required.",
          { "WWW-Authenticate": "Bearer realm=\"wechat-relay\"" },
        );
      }
      candidate = match[1];
    }

    const candidateDigest = digest(candidate);
    const matches = candidate
      ? expected.filter((entry) => timingSafeEqual(candidateDigest, entry.digest)).map((entry) => entry.id)
      : [];
    if (matches.length !== 1) {
      throw new HttpError(
        401,
        "unauthorized",
        "A valid relay bearer token is required.",
        { "WWW-Authenticate": "Bearer realm=\"wechat-relay\"" },
      );
    }
    return { id: matches[0] };
  };
}
```

All digests are SHA-256 (32 bytes), so `timingSafeEqual` never sees mismatched lengths. Config-level uniqueness (Task 1) guarantees `matches.length` is 0 or 1 at runtime; the `!== 1` check stays fail-closed.

- [ ] **Step 4: Wire the return value in `src/server.js`**

In `createRequestHandler`: `const authenticate = createAuthenticator(config.relayToken);` → `createAuthenticator(config.accounts);`. In the handler body add `let accountId = "unresolved";` next to `let routeId = "unresolved";` and `let account = null;` beside it (Task 3 needs `account.id` outside the auth try-block). Inside the authenticate try, change `authenticate(req);` to `account = authenticate(req); accountId = account.id;`. Do **not** use `account` further in this task.

- [ ] **Step 5: Verify and commit**

```bash
git add -A && npm run snapshot:write && npm run check
git commit -m "feat: resolve the relay token to a configured account"
```

Expected: green (server still uses the single legacy client; every existing account has one entry).

---

### Task 3: Server runtime — per-account clients, ready sweep, account log field

**Files:**
- Modify: `src/config.js` (drop legacy top-level credential fields)
- Modify: `src/server.js`
- Modify: `src/logger.js` (+1 allowlist field)
- Modify: `test/helpers.js` (config shape)
- Modify: `test/logger.test.js` (allowlist assertion)
- Modify: `test/server.test.js` (two fixture field spots + new multi-account tests)
- Modify: `test/config-auth.test.js` (lines 49/54 already adapted in Task 1; no further change unless `.relayToken` remains anywhere — grep)

**Interfaces:**
- Consumes: `config.profile`, `config.accounts`, `createAuthenticator(accounts) → {id}` from Tasks 1–2; `WechatClient` constructor unchanged (reads `config.appId`/`config.appSecret`/bounds off the object it is given).
- Produces: `createRequestHandler({ config, store, clients, logger })` and `createRelayService` returns `{ server, store, clients, logger, listen, close }` — `clients` is `Map<accountId, WechatClient>`. New HTTP error: `503 account_not_ready` with message `Account '<id>' is not ready.` (accounts profile only). Log records may carry `account` (slug).

- [ ] **Step 1: Write the failing tests**

In `test/server.test.js`, add at the end:

```js
const MULTI_ACCOUNTS = [
  {
    id: "main",
    appId: "synthetic-app-id-main",
    appSecret: "synthetic-secret-main",
    relayToken: "a".repeat(48),
  },
  {
    id: "tech",
    appId: "synthetic-app-id-tech",
    appSecret: "synthetic-secret-tech",
    relayToken: "b".repeat(48),
  },
];

test("the bearer token selects the upstream account", async (t) => {
  const fixture = await withService(t, {
    config: { profile: "accounts", accounts: MULTI_ACCOUNTS.map((account) => ({ ...account })) },
  });
  const upload = await fetch(`${fixture.baseUrl}/wechat/media/uploadimg`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MULTI_ACCOUNTS[1].relayToken}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: Buffer.from("--x--\r\n"),
  });
  assert.equal(upload.status, 200);
  const tokenCall = fixture.upstreamCalls.find((call) => call.url.pathname === "/cgi-bin/token");
  assert.equal(tokenCall.url.searchParams.get("appid"), "synthetic-app-id-tech");

  // Per-account access-token cache: a second tech call reuses the cached
  // token; switching to main triggers exactly one more refresh with main's appid.
  const secondUpload = await fetch(`${fixture.baseUrl}/wechat/media/uploadimg`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MULTI_ACCOUNTS[1].relayToken}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: Buffer.from("--x--\r\n"),
  });
  assert.equal(secondUpload.status, 200);
  assert.equal(fixture.upstreamCalls.filter((call) => call.url.pathname === "/cgi-bin/token").length, 1);

  const mainUpload = await fetch(`${fixture.baseUrl}/wechat/media/uploadimg`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MULTI_ACCOUNTS[0].relayToken}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: Buffer.from("--x--\r\n"),
  });
  assert.equal(mainUpload.status, 200);
  const tokenCalls = fixture.upstreamCalls.filter((call) => call.url.pathname === "/cgi-bin/token");
  assert.equal(tokenCalls.length, 2);
  assert.equal(tokenCalls[1].url.searchParams.get("appid"), "synthetic-app-id-main");

  const unknown = await fetch(`${fixture.baseUrl}/wechat/media/uploadimg`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"c".repeat(48)}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: Buffer.from("--x--\r\n"),
  });
  assert.equal(unknown.status, 401);

  const logText = fixture.logs.join("");
  assert.ok(logText.includes("\"account\":\"tech\""));
  for (const account of MULTI_ACCOUNTS) {
    assert.ok(!logText.includes(account.appSecret), "appSecret leaked into logs");
    assert.ok(!logText.includes(account.relayToken), "relayToken leaked into logs");
  }
});

test("readiness sweeps every account and names the failing one", async (t) => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/cgi-bin/token") {
      if (parsed.searchParams.get("appid") === "synthetic-app-id-tech") {
        return jsonResponse({ errcode: 40_013, errmsg: "synthetic appid is invalid" });
      }
      return jsonResponse({ access_token: "memory-only-token", expires_in: 7_200 });
    }
    throw new Error("unexpected test URL");
  };
  const fixture = await withService(t, {
    config: { profile: "accounts", accounts: MULTI_ACCOUNTS.map((account) => ({ ...account })) },
    fetchImpl,
  });
  const ready = await fetch(`${fixture.baseUrl}/v1/ready`, {
    headers: { Authorization: `Bearer ${MULTI_ACCOUNTS[0].relayToken}` },
  });
  assert.equal(ready.status, 503);
  const payload = await ready.json();
  assert.equal(payload.error.code, "account_not_ready");
  assert.ok(payload.error.message.includes("'tech'"));
});
```

In `test/logger.test.js`, add (mirror the file's existing import of `createJsonLogger`):

```js
test("logger allowlist passes the account slug and drops foreign fields", () => {
  const lines = [];
  const logger = createJsonLogger({ write: (chunk) => { lines.push(chunk); } });
  logger.write({ event: "request.complete", account: "tech", appSecret: "synthetic-secret-main" });
  const record = JSON.parse(lines[0]);
  assert.equal(record.account, "tech");
  assert.equal("appSecret" in record, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js test/logger.test.js`
Expected: FAIL — `withService` builds a config without `accounts`; `createRelayService` still reads `config.appId`; the `account` log field is dropped by the allowlist.

- [ ] **Step 3: Update `test/helpers.js`**

```js
export function testConfig(overrides = {}) {
  const { appId = "test-app-id", appSecret = "test-app-secret", relayToken = "r".repeat(48), ...rest } = overrides;
  return {
    profile: "legacy",
    accounts: [Object.freeze({ id: "default", appId, appSecret, relayToken })],
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    maxJsonBodyBytes: 4 * 1024 * 1024,
    maxMediaBodyBytes: 20 * 1024 * 1024,
    maxUpstreamResponseBytes: 2 * 1024 * 1024,
    bodyTimeoutMs: 1_000,
    upstreamTimeoutMs: 1_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 100,
    healthRateLimitMaxRequests: 100,
    preauthRateLimitMaxRequests: 100,
    maxConcurrentUpstream: 4,
    maxConnections: 64,
    idempotencyMaxRecords: 10_000,
    idempotencyFailedSafeRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    ...rest,
  };
}

export function authHeaders(config, extra = {}) {
  return {
    Authorization: `Bearer ${config.accounts[0].relayToken}`,
    ...extra,
  };
}
```

- [ ] **Step 4: Update `src/config.js` — drop legacy credential fields**

Delete `appId`, `appSecret`, `relayToken` from the returned frozen object (keep the local variables used to build the default account). The return becomes `Object.freeze({ profile, accounts, host, port: ..., ... })`.

- [ ] **Step 5: Implement the runtime in `src/server.js`**

In `createRelayService`:

```js
  const clients = new Map(config.accounts.map((account) => [
    account.id,
    new WechatClient({ ...config, appId: account.appId, appSecret: account.appSecret }, fetchImpl),
  ]));
  const handler = createRequestHandler({ config, store, clients, logger });
```

In `close()`: replace `wechat.clearSecrets();` with `for (const client of clients.values()) client.clearSecrets();`. In the returned object replace `wechat,` with `clients,`. Grep `test/` for `service.wechat` / `.wechat` usages first — expected none; if found, switch them to `service.clients.get("default")`.

In `createRequestHandler({ config, store, clients, logger })` (drop the `wechat` param):

- Keep `let accountId = "unresolved";`.
- Ready branch — replace `await wechat.ensureReady();` with the sweep:

```js
          for (const [id, client] of clients) {
            try {
              await client.ensureReady();
            } catch (error) {
              if (config.profile === "legacy") throw error;
              throw new HttpError(503, "account_not_ready", `Account '${id}' is not ready.`);
            }
          }
```

(Legacy keeps bubbling `UpstreamError` → 502, byte-identical to today.)

- Wechat forward — replace `await wechat.forward(route, body, contentType)` with:

```js
          const upstream = await clients.get(account.id).forward(route, body, contentType);
```

- Log record — add `account: accountId,` next to `route: routeId,` in the `request.complete` write.

- [ ] **Step 6: Update `src/logger.js`**

Add `"account",` to `ALLOWED_FIELDS` (keep alphabetical order: after `"bodyBytes"` group — insert `"account",` before `"bodyBytes",`).

- [ ] **Step 7: Fix the two fixture field spots in `test/server.test.js`**

`fixture.config.relayToken` → `fixture.config.accounts[0].relayToken`; `fixture.config.appSecret` → `fixture.config.accounts[0].appSecret` (the redaction-assertion loops around lines 152–160 and 200–210).

- [ ] **Step 8: Verify and commit**

```bash
git add -A && npm run snapshot:write && npm run check
git commit -m "feat: route each account through its own WechatClient"
```

---

### Task 4: Idempotency — per-account digest namespace (v1/v2)

**Files:**
- Modify: `src/idempotency-store.js`
- Modify: `src/server.js` (store construction + call sites)
- Modify: `test/idempotency-store.test.js` (adapt all calls + new tests)
- Modify: `test/server.test.js` (cross-account test)

**Interfaces:**
- Consumes: `config.profile` from Task 1; `account.id` from Task 2.
- Produces: `new IdempotencyStore(filename, { maxRecords, failedSafeRetentionMs, digestVersion })` where `digestVersion` is 1 (legacy, default) or 2 (accounts). Methods become `begin(accountId, key, route, bodyHash, now?)`, `mark(accountId, key, route, bodyHash, stage, now?)`, `get(accountId, key)`. SQLite schema unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/idempotency-store.test.js`, add:

```js
import { createHash } from "node:crypto";

test("legacy digest domain stays byte-identical to v1", () => {
  const store = new IdempotencyStore(":memory:", { digestVersion: 1 });
  const key = "draft-key-0001";
  const bodyHash = createHash("sha256").update("body").digest("hex");
  assert.equal(store.begin("any-account", key, "draft.add", bodyHash).action, "proceed");
  const expected = createHash("sha256")
    .update("wechat-relay:idempotency-key:v1\u0000", "utf8")
    .update(key, "utf8")
    .digest("hex");
  assert.equal(store.get("any-account", key).idempotency_key_sha256, expected);
});

test("v2 digests namespace the same key per account", () => {
  const store = new IdempotencyStore(":memory:", { digestVersion: 2 });
  const bodyHash = createHash("sha256").update("body").digest("hex");
  assert.equal(store.begin("main", "draft-key-0001", "draft.add", bodyHash).action, "proceed");
  assert.equal(store.begin("tech", "draft-key-0001", "draft.add", bodyHash).action, "proceed");
  assert.equal(store.get("main", "draft-key-0001").idempotency_key_sha256 !== store.get("tech", "draft-key-0001").idempotency_key_sha256, true);
  assert.equal(store.mark("main", "draft-key-0001", "draft.add", bodyHash, "completed"), undefined);
  assert.throws(() => store.mark("tech", "draft-key-0001", "draft.add", bodyHash, "completed"), {
    message: "Idempotency stage transition lost its reservation.",
  });
});
```

And in `test/server.test.js`, add:

```js
test("idempotency keys are namespaced per account", async (t) => {
  const fixture = await withService(t, {
    config: { profile: "accounts", accounts: MULTI_ACCOUNTS.map((account) => ({ ...account })) },
  });
  const body = JSON.stringify({ articles: [{ title: "private-title", content: "private-body" }] });
  const call = (token) => fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "shared-draft-key",
    },
    body,
  });
  assert.equal((await call(MULTI_ACCOUNTS[0].relayToken)).status, 200);
  assert.equal((await call(MULTI_ACCOUNTS[1].relayToken)).status, 200);
  const replay = await call(MULTI_ACCOUNTS[0].relayToken);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "idempotency_replay_blocked");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/idempotency-store.test.js test/server.test.js`
Expected: FAIL — methods take no `accountId`; server calls don't thread it.

- [ ] **Step 3: Implement in `src/idempotency-store.js`**

Replace the digest helper:

```js
const DIGEST_DOMAIN_V1 = "wechat-relay:idempotency-key:v1\u0000";
const DIGEST_DOMAIN_V2 = "wechat-relay:idempotency-key:v2\u0000";

function idempotencyKeySha256(key, accountId, digestVersion) {
  const hash = createHash("sha256");
  hash.update(digestVersion === 2 ? DIGEST_DOMAIN_V2 : DIGEST_DOMAIN_V1, "utf8");
  if (digestVersion === 2) {
    hash.update(accountId, "utf8");
    hash.update("\u0000", "utf8");
  }
  hash.update(key, "utf8");
  return hash.digest("hex");
}
```

Constructor: read `this.digestVersion = options.digestVersion ?? 1;` (validate it is 1 or 2, else `TypeError`). Public methods:

```js
  begin(accountId, key, route, bodyHash, now = Date.now()) {
    return this.beginTransaction.immediate(
      idempotencyKeySha256(key, accountId, this.digestVersion), route, bodyHash, now,
    );
  }

  mark(accountId, key, route, bodyHash, stage, now = Date.now()) {
    if (!["completed", "failed_safe", "outcome_unknown"].includes(stage)) {
      throw new Error("Invalid idempotency stage transition.");
    }
    const result = this.updateStage.run(
      stage, now, idempotencyKeySha256(key, accountId, this.digestVersion), route, bodyHash,
    );
    if (result.changes !== 1) {
      throw new Error("Idempotency stage transition lost its reservation.");
    }
  }

  get(accountId, key) {
    return this.select.get(idempotencyKeySha256(key, accountId, this.digestVersion)) ?? null;
  }
```

The prepared statements and transactions are unchanged (digest already carries the account).

- [ ] **Step 4: Thread the account in `src/server.js`**

Store construction gains the domain version:

```js
  const store = new IdempotencyStore(config.dbPath, {
    maxRecords: config.idempotencyMaxRecords,
    failedSafeRetentionMs: config.idempotencyFailedSafeRetentionMs,
    digestVersion: config.profile === "accounts" ? 2 : 1,
  });
```

Call sites in the handler: `store.begin(account.id, idempotencyKey, route.id, hash)` and both `store.mark(account.id, idempotencyKey, route.id, hash, stage)` occurrences.

- [ ] **Step 5: Adapt every existing call in `test/idempotency-store.test.js`**

Each `store.begin(key, ...)` / `store.mark(key, ...)` / `store.get(key)` call gains `"default"` as the new first argument — e.g. `store.begin("draft-key-0001", "draft.add", hash)` becomes `store.begin("default", "draft-key-0001", "draft.add", hash)`. Constructor calls without options keep working (digestVersion defaults to 1).

- [ ] **Step 6: Verify and commit**

```bash
git add -A && npm run snapshot:write && npm run check
git commit -m "feat: namespace idempotency digests per account"
```

---

### Task 5: Repo hygiene — example file, ignore rules, compose, static contract

**Files:**
- Create: `accounts.example.json`
- Modify: `.gitignore`
- Modify: `docker-compose.yaml`
- Modify: `test/static-contract.test.js` (gitignore assertion)

**Interfaces:**
- Consumes: Task 1 validation rules (the example must be shape-correct).
- Produces: committed example that passes `secret-scan`; `accounts.json` ignored.

- [ ] **Step 1: Extend the static-contract assertion (write it failing)**

In `test/static-contract.test.js`, the gitignore loop:

```js
  for (const sensitive of [".env", ".npmrc", "*.pem", "*.key", "*.sqlite3", "*.log", "accounts.json"]) {
    assert.ok(ignored.includes(sensitive), sensitive);
  }
```

Run: `node --test test/static-contract.test.js` → FAIL.

- [ ] **Step 2: Create `accounts.example.json`**

```json
[
  {
    "id": "main",
    "appId": "replace-with-real-app-id",
    "appSecret": "replace-with-real-app-secret",
    "relayToken": "<generate-43-plus-char-base64url>"
  }
]
```

The placeholder `relayToken` starts with `<` so the case-insensitive `literal-secret-field` scan rule cannot match; the appId avoids the `wx[0-9a-f]{16}` pattern.

- [ ] **Step 3: Update `.gitignore`**

Add `accounts.json` directly under the `.env` block.

- [ ] **Step 4: Add the compose example**

In `docker-compose.yaml`, inside the service's `environment:` list append the commented pair, and under `volumes:` (create the key if absent) the commented mount — follow the file's existing comment style:

```yaml
      # 多公众号模式(可选; 设置后移除上面三个单账号变量):
      # - ACCOUNTS_FILE=/etc/wechat-relay/accounts.json
    # volumes:
    #   - ./accounts.json:/etc/wechat-relay/accounts.json:ro
```

Read the file first and place the comments so they never activate by default.

- [ ] **Step 5: Verify and commit**

```bash
git add -A && npm run secret-scan && npm run check
git commit -m "chore: accounts file example, ignore rules, compose mount"
```

---

### Task 6: Documentation + threat model + snapshot

**Files:**
- Modify: `docs/PROTOCOL.md`, `SECURITY.md`, `THREAT_MODEL.md`, `README.md`, `CLIENT_SKILL.md`, `docs/DEPLOY_DOCKER.md`

**Interfaces:**
- Consumes: final behavior of Tasks 1–5.
- Produces: operator-facing documentation matching the shipped code; regenerated `THREAT_MODEL.md` snapshot digest.

- [ ] **Step 1: `docs/PROTOCOL.md`** — in Transport/auth section add after the legacy-token bullets:

```markdown
- Multi-account deployments configure an accounts file (`ACCOUNTS_FILE`) instead of
  `WECHAT_APP_ID`/`WECHAT_APP_SECRET`/`RELAY_TOKEN`. The presented token both authenticates
  the request and selects the WeChat account it applies to; a token can never reach another
  account. Routes and paths are identical in both modes.
```

In Health and readiness: note that in multi-account mode `/v1/ready` sweeps **every** account and fails with `503 account_not_ready` naming the failing account id. In Idempotency: note the digest domain — legacy deployments hash keys under the `v1` domain; accounts-file deployments hash under a `v2` domain that includes the account id, so the same `Idempotency-Key` is independent across accounts. Recommend a fresh `DB_PATH` when adopting the accounts profile.

- [ ] **Step 2: `SECURITY.md` / `THREAT_MODEL.md`** — add to SECURITY.md a bullet: accounts file is an operator-supplied credential store (mode 600 enforced at startup, gitignored, never logged; only per-account SHA-256 token digests are compared at request time). In THREAT_MODEL.md add a short asset paragraph "Accounts file on disk" (plaintext credentials; mitigations: permission-bit enforcement, ignore rules, redacted logging, restart-only reload) and keep the existing "No generic path forwarding" line intact (static-contract asserts it).

- [ ] **Step 3: `README.md`** — add a Multi-account section: env pair vs `ACCOUNTS_FILE`, 16-account cap, token-selects-account semantics, restart to apply changes.

- [ ] **Step 4: `CLIENT_SKILL.md`** — add: when the relay is deployed in multi-account mode, use the target account's own `RELAY_TOKEN`; URLs and request shapes are unchanged.

- [ ] **Step 5: `docs/DEPLOY_DOCKER.md`** — new "Multi-account (optional)" section: create `accounts.json` (`chmod 600`, owner matches the gosu `node` user), mount read-only, set `ACCOUNTS_FILE`, remove the three single-account env values, restart, verify with `/v1/ready`.

- [ ] **Step 6: Regenerate the snapshot and run the full gate**

```bash
git add -A && npm run snapshot:write && npm run check && npm run snapshot:check
git commit -m "docs: multi-account deployment, protocol, and threat model updates"
```

- [ ] **Step 7: Final self-review**

`git diff bbe4436..HEAD --stat` — confirm: `src/routes.js` untouched; no new dependencies in `package.json`; every new source/test file carries the AGPL SPDX header; `grep -rn "console\." src/` empty.
