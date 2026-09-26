# wechat-relay

`wechat-relay` is a small, public, self-hosted relay for four WeChat Official Account draft APIs and six read-only article-statistics APIs. It exists for one narrow deployment problem: the Official Account allowlist sees the relay server's fixed outbound IPv4 instead of a changing client address.

Commercial use is permitted, but users must comply with
`AGPL-3.0-or-later`. For commercial deployment, customization, training, or
technical support, contact the repository maintainer.

> 商业使用：允许，但必须遵守 AGPL-3.0-or-later。
>
> 商业部署、定制、培训与技术支持：可联系维护者。

The relay creates or reads drafts only through the four documented compatibility routes, and pulls published-article statistics through six additional read-only datacube routes. It does not automate the WeChat client, open the Official Account web console, mass-send, publish, or provide a generic WeChat API proxy.

## Security model

- The Node process refuses to start unless `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `RELAY_TOKEN` are all present — or, in multi-account mode, an `ACCOUNTS_FILE` is configured instead (see below).
- `RELAY_TOKEN` must encode at least 32 cryptographically random bytes (at least 43 base64/base64url characters or 64 hex characters). Do not invent a memorable password.
- The process binds only to `127.0.0.1` or `::1`. A reverse proxy (Tailscale Serve, Caddy, or the operator's nginx-proxy-manager on the Docker route) is the network boundary.
- `/v1/health` is public and returns only `{"ok":true}`. `/v1/ready` is authenticated and checks SQLite plus WeChat credential/IP readiness.
- Request paths, methods, query parameters, content types, body sizes, body time, total upstream-operation time (including token refresh/retry), response size, rate, total connections, and concurrent admitted requests are bounded.
- WeChat `access_token` values live only in process memory.
- SQLite stores only a domain-separated SHA-256 idempotency-key digest, route, SHA-256 body hash, stage, and timestamps. It never stores the caller's raw key, article text, images, response bodies, titles, or media identifiers.
- Idempotency metadata is capped at 10,000 rows by default. Only expired `failed_safe` rows are reclaimed automatically; protected completed, forwarding, and uncertain outcomes are never evicted to make room.
- Logs use a fixed allowlist and never include secrets, authentication headers, request/response bodies, titles, access tokens, or media identifiers.
- The statistics routes are read-only: they reject `Idempotency-Key`, never touch SQLite, and fail closed on date windows that are not calendar-valid, exceed the route's span limit, or name a Beijing day whose data is not final.

Read [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), and [docs/PROTOCOL.md](docs/PROTOCOL.md) before deployment.

## Multi-account mode

The relay supports two mutually exclusive configuration profiles:

1. **Single account (default):** set `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `RELAY_TOKEN`.
2. **Multi-account:** set `ACCOUNTS_FILE` to a JSON file listing 1–16 accounts, each with exactly `id`, `appId`, `appSecret`, and `relayToken`. Combining `ACCOUNTS_FILE` with any of the three single-account variables is rejected at startup.

See [accounts.example.json](accounts.example.json) for the file shape. Account ids match `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`; ids, app ids, and tokens must be unique; every relay token must encode at least 32 random bytes. The file must be mode 600 (no group/world bits) and at most 64 KiB, and the default `accounts.json` filename is gitignored (exclude custom filenames yourself).

The presented bearer token both authenticates the request and selects the WeChat account it applies to; a token can never reach another account. Routes and paths are identical in both modes, and `/v1/ready` sweeps every account. Changes to the accounts file apply only after a restart — there is no hot reload.

When moving an existing deployment from single-account to multi-account, prefer a fresh `DB_PATH`: idempotency key digests are namespaced per profile, so legacy rows never match the accounts-profile domain and protected rows are never evicted (see [docs/PROTOCOL.md](docs/PROTOCOL.md)).

## Runtime requirements

- Node.js 20.x, 22.x, or 24.x. Startup rejects other majors; install dependencies afresh when changing Node majors because `better-sqlite3` is native.
- Ubuntu 24.04 for the documented production setup
- A user-supplied server with a stable outbound IPv4 already accepted by the WeChat Official Account allowlist

The recommended region is Hong Kong when it provides the appropriate stable IPv4 and acceptable connectivity. The operator remains responsible for the server, fixed IPv4, DNS, firewall, Tailscale ACLs, and WeChat allowlist.

## Local development

```bash
npm ci
npm run check   # test + lint + syntax + secret-scan (the full CI gate)
npm start
```

The service intentionally does not auto-load `.env`. Export variables explicitly or provide them through systemd.

The empty [.env.example](.env.example) is a key list, not a working configuration. Never commit a populated environment file.

## Production deployment

Use the manual Ubuntu 24.04 guide: [docs/DEPLOY_UBUNTU_24_04.md](docs/DEPLOY_UBUNTU_24_04.md).

It documents two supported routes:

1. **Tailscale Serve** — preferred for tailnet-only access. Do not enable Funnel.
2. **A domain with Caddy** — for an operator-owned domain on a fixed IPv4, with TLS and a restrictive firewall.

### Docker Compose

A Docker Compose deployment is also available for servers that already run a host-network reverse proxy (for example, nginx-proxy-manager managing domains and certificates). See [docs/DEPLOY_DOCKER.md](docs/DEPLOY_DOCKER.md) (中文). The container binds to the host's `127.0.0.1:18794` via `network_mode: host`; TLS termination and public exposure stay with the operator's proxy.

There is deliberately no one-command installer. Credential creation, network exposure, WeChat allowlisting, and service activation remain explicit operator decisions.

## Related repository

- [Ailu](https://github.com/mcncarl/ailu) is the public Obsidian client that
  uses this relay for explicit, draft-only WeChat Official Account uploads.
  Ailu and this service are installed and configured separately.

## License

Copyright 2026 wechat-relay contributors.

Licensed under the GNU Affero General Public License, version 3 or any later version (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).
The project copyright and modification notice is preserved in [NOTICE.md](NOTICE.md).
