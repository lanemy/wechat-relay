# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wechat-relay` is a small self-hosted relay for four WeChat Official Account draft APIs. The relay exists so the Official Account IP allowlist sees one fixed outbound IPv4 instead of changing client addresses. It is draft-only by design — no mass-send, publish, generic proxy, or WeChat client automation.

## Commands

```bash
npm ci                 # install (better-sqlite3 is native — reinstall when changing Node majors)
npm test               # run all tests (node --test)
npm run lint           # eslint
npm run syntax         # node --check on each src file
npm run secret-scan    # scans for committed secrets
npm run check          # test + lint + syntax + secret-scan (what CI runs)
npm run audit:dependencies
npm start              # node src/index.js
```

Run a single test file: `node --test test/server.test.js`
Run a single test by name: `node --test --test-name-pattern="pattern" test/server.test.js`

## Runtime invariants (do not weaken)

These are deliberate security boundaries documented in SECURITY.md, THREAT_MODEL.md, and docs/PROTOCOL.md. Changes that relax any of these will be rejected:

- **Node majors 20/22/24 only** — startup rejects others (enforced in `src/config.js`).
- **Loopback-only binding** — `HOST` must be `127.0.0.1` or `::1`; the handler also rejects non-loopback socket peers. Reverse proxy (Tailscale Serve / Caddy) is the network boundary.
- **Required env**: `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, `RELAY_TOKEN` (≥32 random bytes encoded — 43+ base64url chars or 64+ hex chars). The process refuses to start without them. `.env` is intentionally NOT auto-loaded.
- **Exact route allowlist** — only the routes in `src/routes.js` (`/v1/health`, `/v1/ready`, `/wechat/material/add_material`, `/wechat/media/uploadimg`, `/wechat/draft/add`, `/wechat/draft/get`). No generic proxying.
- **Everything is bounded** — body size, body time, upstream timeouts/response size, rate limits (per-policy: authenticated/health/preauth), connections, and upstream concurrency.
- **Idempotency fail-closed** — `/wechat/draft/add` requires `Idempotency-Key`; replays of possibly-executed requests are blocked (409), never auto-retried. SQLite stores only SHA-256 digests (domain-separated key digest, body hash), route, stage, timestamps — never raw keys, bodies, titles, or media IDs. Completed/forwarding/uncertain rows are never evicted; only expired `failed_safe` rows are reclaimed.
- **Redacted logs** — fixed allowlist of events; never secrets, bodies, tokens, or media identifiers. `no-console` is an eslint error; use the logger.
- **WeChat access_token lives only in memory** (cleared on shutdown via `clearSecrets()`).

## Architecture

Zero-framework Node.js (`node:http` only, no Express). Single runtime dependency: `better-sqlite3`. ES modules (`"type": "module"`).

Request flow: `src/index.js` (entry) → `loadConfig()` (`src/config.js`) → `createRelayService()` (`src/server.js`) which wires up:

1. `resolveRoute()` (`src/routes.js`) — strict origin-form URL parsing, route/method/query validation, upstream path mapping.
2. `authenticate()` (`src/auth.js`) — bearer-token check against `RELAY_TOKEN`.
3. Rate limiting (`src/rate-limit.js` — `FixedWindowRateLimiter` with per-policy limits + `ConcurrencyGate` for upstream slots).
4. Body handling (`src/body.js`) — size/time-bounded reads, content-type validation, per-route JSON schema validation, `Idempotency-Key` extraction.
5. `IdempotencyStore` (`src/idempotency-store.js`) — better-sqlite3, begin/mark state machine (`completed` / `failed_safe` / `outcome_unknown` / `forwarding`).
6. `WechatClient` (`src/wechat-client.js`) — in-memory access_token with single-flight refresh, retries once on invalid-token codes (40001/40014/42001), bounded response reads.

`src/errors.js` defines `HttpError` (client-facing, safe messages) vs `UpstreamError` (with `outcomeUnknown` flag that drives idempotency stage selection). `src/logger.js` emits newline-delimited JSON with an allowlisted field set.

The relay never parses or reconstructs WeChat multipart bodies — media routes are forwarded as-is; only JSON routes get per-route shape validation.

## Testing

Tests use the built-in `node:test` runner with no mocking framework — `fetch` is injectable into `WechatClient`/`createRelayService` (`fetchImpl` param), and tests use synthetic credentials and a stubbed upstream. `test/static-contract.test.js` enforces structural invariants over the source (route table, log allowlist) — update it when changing `src/routes.js` or `src/logger.js`.

## Docker deployment

`Dockerfile` (multi-stage, node:22-slim, gosu drop to `node` user), `docker-compose.yaml`, and `deploy/docker/entrypoint.sh` support Compose deployment with `network_mode: host` — mandatory because of the loopback peer check in `src/server.js`; bridge NAT gets 403 `non_loopback_peer`. Edge proxy is the operator's host-network nginx-proxy-manager (TLS/certs handled there, not Caddy). Procedure: `docs/DEPLOY_DOCKER.md`. `test/static-contract.test.js` requires `deploy/Caddyfile.example` to keep `reverse_proxy 127.0.0.1:18794` (manual route only) and forbids root-level installer scripts.

## Contributing rules (from CONTRIBUTING.md)

- Only synthetic credentials, IDs, bodies, addresses, logs, and DB fixtures in code and tests.
- Never commit populated env files, real credentials/tokens, request/response bodies, or SQLite runtime state.
- `data/` is runtime state (gitignored, eslint-ignored) — SQLite DB lives there by default (`DB_PATH=./data/idempotency.sqlite3`).
