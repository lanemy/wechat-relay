# Multi-account support (token-selected accounts)

- **Date:** 2026-09-24
- **Status:** approved design, pre-implementation
- **Decisions locked with operator:** token-as-account-selector (URLs unchanged) · legacy single-account profile kept · credentials in an accounts file

## Problem

The relay binds exactly one WeChat Official Account per process (`WECHAT_APP_ID`/`WECHAT_APP_SECRET`, one `RELAY_TOKEN`, one in-memory access token). Operating several accounts today requires several processes. This design adds native multi-account support without changing any existing client-visible path.

## Goals

- One process serves N WeChat accounts (N ≤ 16).
- The bearer token selects the account; request paths stay byte-identical to today.
- Existing single-account deployments upgrade with zero config, URL, or DB changes.
- All existing runtime invariants (route allowlist, bounds, redacted logs, digest-only idempotency metadata, fail-closed behavior) are preserved.

## Non-goals

- Per-account rate-limit buckets or concurrency partitioning (global bounds are kept — they protect the host egress, not a per-appid quota; revisit later if needed).
- Hot reload of the accounts file (restart to change, consistent with env-based config).
- Path-prefix or header-based account selection.
- Any new WeChat routes.

## Configuration model — two mutually exclusive profiles

Selection rule: `ACCOUNTS_FILE` trimmed non-empty ⇒ **accounts profile**; otherwise ⇒ **legacy profile**.

### Legacy profile (unchanged)

`WECHAT_APP_ID` + `WECHAT_APP_SECRET` + `RELAY_TOKEN` exactly as today (same validation, same error codes). Internally represented as a single synthetic account `{ id: "default", appId, appSecret, relayToken }`.

### Accounts profile (new)

Env: `ACCOUNTS_FILE=<path>` (relative paths resolve against cwd, like `DB_PATH`). If `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, or `RELAY_TOKEN` is also set non-empty ⇒ `ConfigurationError("ambiguous_account_config")`.

#### accounts.json shape

```json
[
  {
    "id": "main",
    "appId": "synthetic-example-app-id",
    "appSecret": "synthetic-example-secret",
    "relayToken": "<43-plus-char-base64url>"
  }
]
```

#### Validation (all fail-fast at startup, in order)

| # | Rule | Error code |
|---|---|---|
| 1 | `ACCOUNTS_FILE` contains no NUL byte | `invalid_ACCOUNTS_FILE` |
| 2 | Path exists and is a regular file | `accounts_file_missing` |
| 3 | Mode has **no group/world permission bits** (mode & 0o077 === 0) | `accounts_file_permissions` |
| 4 | File size ≤ 65,536 bytes | `accounts_file_too_large` |
| 5 | Parses as JSON | `invalid_accounts_json` |
| 6 | Is an array of 1–16 plain objects | `invalid_accounts_shape` / `too_many_accounts` |
| 7 | Each object has exactly the keys `id`, `appId`, `appSecret`, `relayToken`, all non-empty strings ≤ 256 chars | `invalid_accounts_shape` |
| 8 | `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` | `invalid_account_id` |
| 9 | Each `relayToken` passes the existing `validateRelayToken` rules (charset + ≥32-byte entropy encoding) | `invalid_account_relay_token` / `invalid_account_relay_token_length` |
| 10 | `id` values unique · `appId` values unique · `relayToken` values unique | `duplicate_account_id` / `duplicate_account_app_id` / `duplicate_account_relay_token` |

Duplicate tokens are a routing ambiguity, not a warning — startup refuses.

### Resulting config object

`loadConfig()` additionally returns (frozen):

- `profile: "legacy" | "accounts"`
- `accounts: readonly [{ id, appId, appSecret, relayToken }]` (legacy ⇒ the single `default` entry)

Everything else in the config object is unchanged; downstream code reads `config.accounts` instead of `config.appId`/`config.appSecret`/`config.relayToken`.

## Authentication = account resolution

`createAuthenticator(accounts)` precomputes one SHA-256 digest per account `relayToken`. `authenticate(req)`:

- Dual auth headers (`Authorization` + `X-Relay-Token`) ⇒ `400 ambiguous_authentication` (unchanged).
- Malformed bearer ⇒ `401 unauthorized` (unchanged message + `WWW-Authenticate`).
- Candidate token digest is compared with `timingSafeEqual` against every account digest; config-level uniqueness guarantees exactly one match. Exactly one ⇒ returns `{ id }`; zero ⇒ `401 unauthorized` (unchanged).

A valid token therefore both authenticates and scopes the request to exactly its account — there is no way to address another account with it.

## Request-flow changes (`src/server.js`)

- `Map<accountId, WechatClient>` built from `config.accounts` (each client keeps its own access token, single-flight refresh, and invalid-token retry; `clearSecrets()` iterates all).
- `authenticate()` result feeds every wechat-route call: `clients.get(account.id).forward(...)`.
- Route resolution, body handling, rate limiting, concurrency gate: **unchanged and still global**.
- `/v1/ready`:
  - Legacy: byte-identical behavior.
  - Accounts: sequentially `ensureReady()` on **every** account inside one concurrency acquire. Any failure ⇒ `503 account_not_ready`, message `Account '<id>' is not ready.` (slug is charset-regex-bounded, safe to interpolate). All pass ⇒ `{"ready":true}`.

## Idempotency namespacing (digest domain split)

Same `Idempotency-Key` on different accounts must not interfere; within one account semantics are unchanged.

- Legacy profile: digest domain stays **v1** — `sha256("wechat-relay:idempotency-key:v1\0" + key)` — byte-identical to today, so existing DBs keep working with zero migration.
- Accounts profile: domain **v2** — `sha256("wechat-relay:idempotency-key:v2\0" + accountId + "\0" + key)`.

Implementation: `IdempotencyStore` methods (`begin`/`mark`/`get`) gain an `accountId` parameter; the constructor takes a domain-version option selected from `config.profile`. The SQLite schema is unchanged — the account id is never persisted in the clear, only inside the domain-separated digest (consistent with the digest-only metadata policy; `route` column semantics unchanged).

## Logging

`ALLOWED_FIELDS` in `src/logger.js` gains `"account"`. `request.complete` records the account slug for authenticated wechat routes (`"default"`/unresolved for health). Slugs are operator-chosen labels, not AppIDs — same redaction class as `route`. `test/static-contract.test.js` allowlist assertion updated in lockstep.

## Deployment & repo hygiene

- `.gitignore`: add `accounts.json`.
- New `accounts.example.json` committed at repo root: synthetic values only. **Secret-scan constraints:** the `literal-secret-field` rule is case-insensitive and matches `"relayToken": "<24+ token chars>"`, so the example must use `"<placeholder>"`-style values; AppIDs must not match `wx[0-9a-f]{16}` (the `wechat-app-id` rule). `npm run secret-scan` must stay clean.
- `docker-compose.yaml` example: read-only bind mount `./accounts.json:/etc/wechat-relay/accounts.json:ro` + `ACCOUNTS_FILE` env; `docs/DEPLOY_DOCKER.md` gains a multi-account section (file ownership under gosu `node` user, 0600).
- `.env.example` untouched.

## Documentation updates

- `docs/PROTOCOL.md`: auth section (bearer token ⇄ account mapping; per-account tokens in accounts profile), `/v1/ready` semantics, idempotency digest wording (v1/v2 domains).
- `SECURITY.md` / `THREAT_MODEL.md`: new asset — plaintext credentials file on disk; mitigations (0600 enforced at load, gitignored, never logged, example file synthetic-only); token⇒single-account scoping as a new property.
- `README.md`, `CLIENT_SKILL.md`: how a client picks an account (use that account's token; base URL and paths unchanged).

## Testing

- **config:** both profiles valid; mixing rejected; every validation row above has a case (bad permissions, oversize, bad JSON, wrong shape, bad id, weak token, all three duplicate kinds, >16 accounts).
- **auth:** token selects the right account; unknown token 401; dual-header 400.
- **server:** same `Idempotency-Key` + same body to two accounts ⇒ both `proceed` (namespace works); same key+body same account ⇒ `409 idempotency_replay_blocked`; `/v1/ready` with one failing account ⇒ 503 naming it; access-token refresh/invalid-code retry isolated per account (one account's token expiry does not touch another's).
- **static-contract:** log allowlist + new field; route table must remain unchanged.
- **secret-scan:** example file passes; `npm run check` green.

## Migration notes

- Existing single-account deployments: nothing to do — behavior and DB digests are byte-identical.
- Adopting multi-account: switch env to `ACCOUNTS_FILE` and use a **fresh `DB_PATH`** (v1 rows never match v2 digests and protected rows are never evicted, so stale rows would be permanent dead capacity). Reconcile any in-flight uncertain drafts before switching.

## Resolved micro-decisions

1. Rate-limit and concurrency bounds stay global (minimal change; protects host egress).
2. Account count cap: 16.
3. Accounts file permission bits enforced (fail closed).
