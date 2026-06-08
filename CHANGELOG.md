# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-29

This release expands the MCP tool surface from 4 tools to 24, organized into eight categories. It includes one breaking change for users on Node 16 or 18.

### ⚠ Breaking changes

- **Minimum Node.js version raised from 16 to 20.** The `@modelcontextprotocol/sdk` dependency requires Node ≥ 18; we set the floor at 20 to match a current LTS line. Users on Node 16 or 18 will see `EBADENGINE` warnings on install, or hard failures with `engine-strict=true`. The previous `>=16` declaration was already incompatible with the SDK at runtime — this release makes the floor honest.

### Added

- **20 new tools** across templates, messages, diagnostics, bounces, suppressions, webhooks, and server info. See the README "Tools" section for the complete reference.
- **`diagnoseDelivery`** — composite triage tool. Answers "did my email reach X, and if not, why?" by running message search, suppression check, and bounce history in parallel for a recipient, then synthesizing a plain-English recommendation. First tool in a new "Diagnostics" category.
- **`sendBatch`** and **`sendBatchWithTemplate`** — wraps Postmark's *synchronous* batch endpoints (`/email/batch`, `/email/batchWithTemplates`). Send up to 500 distinct messages or templated recipients in a single HTTP request, with immediate per-message success/failure reporting. Note: these are Postmark's batch endpoints; Postmark's separate *asynchronous* bulk email API at `/email/bulk` (submit-and-poll, no message count cap, 50 MB payload limit, subject to approval) is a parallel capability for large-volume jobs and is tracked as a v2.1 follow-up — not a replacement for batch.
- **Template CRUD + validation** — `getTemplate`, `createTemplate`, `editTemplate`, `deleteTemplate`, `validateTemplate`. End-to-end template authoring including layout binding (pass `layoutTemplate: "<alias>"` to bind, `null` to unbind).
- **Message search and details** — `searchOutboundMessages` (with `messageStream` filter), `getMessageDetails` (full event timeline).
- **Bounce tooling** — `searchBounces`, `getBounceDump`, `activateBounce`.
- **Suppression management** — `listSuppressions`, `createSuppressions`, `deleteSuppressions` (up to 50 addresses per call).
- **Webhook lifecycle** — `listWebhooks`, `createWebhook`, `deleteWebhook`. `createWebhook` requires at least one trigger enabled.
- **`getServerInfo`** — server name, color, tracking settings, configured webhook URLs.
- **`getDeliveryStats` `stat` parameter (optional).** With no argument, returns a friendly summary (preserves v1 behavior). With `stat: "<name>"`, returns a polished per-stat breakdown. Supported values: `summary`, `overview`, `sent`, `bounces`, `spam`, `tracked`, `opens`, `openPlatforms`, `openClients`, `openReadTimes`, `clicks`, `clickBrowsers`, `clickPlatforms`, `clickLocation`.
- **Validation guards** on `editTemplate`, `createWebhook`, `createTemplate`, `validateTemplate`, and `sendEmailWithTemplate` — misuse fails fast with a clear message instead of hitting the API.
- **Smoke-test example harnesses** — `smoke-test.example.mjs` (read-only, 25 checks) and `smoke-test-mutating.example.mjs` (full lifecycles + real sends + cleanup, 23 checks). Copy to the non-example name (gitignored) and edit verified-sender addresses to use. The mutating harness includes a startup guard that refuses to run with placeholder values.

### Changed

- **`getDeliveryStats` default summary output reformatted.** Now includes bounce rate, spam rate, and tracked-of-sent percentage in addition to the v1 sent/open/click rates. All v1 fields are still present, just rendered with thousands separators and aligned columns.
- **All tools now talk to the Postmark REST API through a single raw-`fetch` client (`postmarkRequest`).** Previously the server used the official `postmark` SDK (and `getDeliveryStats` mixed in its own raw `fetch`). Transport is now unified on one hardened helper over native `fetch` that handles auth headers, a request timeout, and consistent error mapping (surfacing Postmark's `Message` / `ErrorCode`).

### Fixed

- **`getServerInfo` displayed the wrong field for "First Open Only".** Was reading `EnableSmtpApiErrorHooks` (an unrelated boolean about SMTP API error hooks); now correctly reads `PostFirstOpenOnly`.
- **`engines.node` was lying.** Declared `>=16` but the MCP SDK requires `>=18`. The package would `npm install` on Node 16 and then fail at runtime. Floor is now `>=20` and accurate.

### Removed

- **`postmark` and `node-fetch` dependencies.** The server now talks to the Postmark API through its own minimal HTTP client (`postmarkRequest`) over native `fetch` (Node 20+), which also stamps `X-Postmark-Client` / version / correlation-id headers so MCP-driven traffic is identifiable. Both runtime HTTP dependencies are dropped.

## [1.0.0] - Initial release

Initial public release of the official Postmark MCP server.

### Added

- Four MCP tools: `sendEmail`, `sendEmailWithTemplate`, `listTemplates`, `getDeliveryStats`.
- Stdio JSON-RPC transport for AI assistant consumption (Claude, Cursor, etc.).
- Configuration via `POSTMARK_SERVER_TOKEN`, `DEFAULT_SENDER_EMAIL`, `DEFAULT_MESSAGE_STREAM` environment variables.
- Automatic open and click tracking on every send.
