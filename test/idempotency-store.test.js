// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { IdempotencyStore } from "../src/idempotency-store.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("SQLite stores only a key digest, route, body hash, stage, and timestamps", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());
  assert.deepEqual(store.columns(), [
    "idempotency_key_sha256",
    "route",
    "body_sha256",
    "stage",
    "created_at_ms",
    "updated_at_ms",
  ]);
  assert.equal(store.ready(), true);
});

test("completed and uncertain requests block replay without storing a response", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());

  assert.deepEqual(store.begin("default", "draft-key", "draft.add", HASH_A), {
    action: "proceed",
    stage: "forwarding",
  });
  store.mark("default", "draft-key", "draft.add", HASH_A, "completed");
  assert.equal(store.begin("default", "draft-key", "draft.add", HASH_A).action, "blocked");
  assert.equal(store.begin("default", "draft-key", "draft.add", HASH_B).action, "conflict");
  assert.deepEqual(store.get("default", "draft-key"), {
    idempotency_key_sha256: "f7fd33b02ccda6d361d7796707f2cfd496ef99439ce27ab6cb51754b4ed83ad9",
    route: "draft.add",
    body_sha256: HASH_A,
    stage: "completed",
  });
  assert.equal(JSON.stringify(store.get("default", "draft-key")).includes("draft-key"), false);

  store.begin("default", "unknown-key", "draft.add", HASH_B);
  store.mark("default", "unknown-key", "draft.add", HASH_B, "outcome_unknown");
  assert.equal(store.begin("default", "unknown-key", "draft.add", HASH_B).action, "blocked");
});

test("only a safely failed request may reuse the same key and hash", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());
  store.begin("default", "retry-key", "draft.add", HASH_A);
  store.mark("default", "retry-key", "draft.add", HASH_A, "failed_safe");
  assert.deepEqual(store.begin("default", "retry-key", "draft.add", HASH_A), {
    action: "proceed",
    stage: "forwarding",
  });
  assert.equal(store.get("default", "retry-key").stage, "forwarding");
});

test("protected outcomes fill a fixed capacity without being evicted", (t) => {
  const store = new IdempotencyStore(":memory:", {
    maxRecords: 2,
    failedSafeRetentionMs: 50,
  });
  t.after(() => store.close());
  store.begin("default", "completed-key", "draft.add", HASH_A, 0);
  store.mark("default", "completed-key", "draft.add", HASH_A, "completed", 1);
  store.begin("default", "uncertain-key", "draft.add", HASH_B, 2);
  store.mark("default", "uncertain-key", "draft.add", HASH_B, "outcome_unknown", 3);

  assert.deepEqual(store.begin("default", "new-key", "draft.add", HASH_A, 100), {
    action: "capacity",
    stage: "capacity",
  });
  assert.equal(store.size(), 2);
  assert.equal(store.hasCapacity(102), false);
  assert.equal(store.begin("default", "completed-key", "draft.add", HASH_A, 101).action, "blocked");
  assert.equal(store.get("default", "uncertain-key").stage, "outcome_unknown");
});

test("only expired failed-safe metadata is reclaimed automatically", (t) => {
  const store = new IdempotencyStore(":memory:", {
    maxRecords: 2,
    failedSafeRetentionMs: 50,
  });
  t.after(() => store.close());
  store.begin("default", "completed-key", "draft.add", HASH_A, 0);
  store.mark("default", "completed-key", "draft.add", HASH_A, "completed", 1);
  store.begin("default", "safe-failure-key", "draft.add", HASH_B, 2);
  store.mark("default", "safe-failure-key", "draft.add", HASH_B, "failed_safe", 3);

  assert.equal(store.hasCapacity(54), true);
  assert.equal(store.begin("default", "replacement-key", "draft.add", HASH_B, 55).action, "proceed");
  assert.equal(store.get("default", "safe-failure-key"), null);
  assert.equal(store.size(), 2);
  assert.equal(store.hasCapacity(56), false);
  assert.equal(store.get("default", "completed-key").stage, "completed");
});

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
  assert.notEqual(
    store.get("main", "draft-key-0001").idempotency_key_sha256,
    store.get("tech", "draft-key-0001").idempotency_key_sha256,
  );
  assert.equal(store.mark("main", "draft-key-0001", "draft.add", bodyHash, "completed"), undefined);
  // Marking main does not touch tech's independent reservation.
  assert.equal(store.get("main", "draft-key-0001").stage, "completed");
  assert.equal(store.get("tech", "draft-key-0001").stage, "forwarding");
});

test("digestVersion must be 1 or 2", () => {
  assert.throws(() => new IdempotencyStore(":memory:", { digestVersion: 3 }), TypeError);
  assert.throws(() => new IdempotencyStore(":memory:", { digestVersion: "1" }), TypeError);
});
