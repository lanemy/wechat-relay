// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function tokenA() {
  return "g".repeat(48);
}

function tokenB() {
  return "h".repeat(48);
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
