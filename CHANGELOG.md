# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **File attachments on all four sending tools** (`sendEmail`, `sendEmailWithTemplate`, `sendBatch`, `sendBatchWithTemplate`). Each accepts an optional `attachments` array (max 10 per message) of `{ name, content, contentType, contentId? }`, mapped to Postmark's native `Attachments` field. `contentId` allows inline `cid:` references from `htmlBody`.
- **Attachment content validation.** Before a send reaches Postmark, each attachment's base64 `content` is checked for well-formed encoding (valid alphabet, correct padding, round-trip re-encode) and, for common image types and PDF, the decoded bytes go through a full structural-integrity check (see Fixed below — not just a header check).
- **Postmark's documented size and file-type limits are now enforced locally**, with the actual numbers surfaced in each tool's description and in [README.md](README.md#attachment-limits): 10 MB total per message (body + attachments, measured after base64 encoding), 5 MB per `textBody`/`htmlBody` section, 50 MB total per batch call, and Postmark's forbidden-extension list (`vbs`, `exe`, `bin`, `bat`, and 27 others — mostly executables/scripts). A violation fails the tool call immediately with the specific limit and actual size, instead of an opaque rejection from Postmark (or, previously, no check at all).
- **`lib/attachments.js`** — attachment validation (base64/structural/size/extension checks) extracted from `index.js`, mirroring the existing `lib/log.js` pattern, so this logic is directly unit-testable with multi-megabyte inputs at millisecond speed instead of only reachable through a real MCP/stdio round-trip.

### Fixed

- **A corrupted attachment could previously go out as an apparently-successful send.** With no `Attachments` field available at all, the only way to include an image was to hand-embed it as a base64 data URI inside `htmlBody` — a plain string with no validation. Because a model reconstructs base64 as text rather than copying exact bytes, that embedding was prone to silent corruption, and Postmark had nothing to reject it on. The new attachment field plus validation above closes this off: bad data now fails the tool call before any send happens, rather than surfacing later as a broken image that an assistant might try to quietly fix with an unprompted second send.
- **A file-signature check that only inspected the first few header bytes missed a body corrupted after the header.** Found immediately by testing the fix live: a real ~68 KB PNG sent through Claude Desktop arrived with the same filename but a different size and no image rendering — an initial header-only signature check (matching the first 8 magic bytes) would have passed this silently, since the corruption from the model's own transcription landed in the middle of the file, not the start. Replaced with full structural validation per type: PNG's entire chunk stream is walked and every chunk's CRC32 is verified; JPEG/GIF require both start-of-file *and* end-of-file markers; WEBP's declared RIFF size must match the actual length; PDF must end in `%%EOF`. Verified against the real file that triggered this (chunk-CRC-valid original passes; a single corrupted byte anywhere in the body, or truncation, is now rejected).
- **Every sending tool's description now states explicitly that it sends immediately, cannot be recalled, and must not be called again to "correct" a previous send without user confirmation** — most relevant for time-sensitive content like OTP codes or expiring links, where a silent duplicate send is its own hazard. This is a prompt-level mitigation (the server can't force a client to comply) but reduces the risk in practice.

### Planned (deferred from v2.1.0)

- **`getWebhook` tool** — retrieve a single webhook's full configuration by ID (`GET /webhooks/{Id}`). Currently only `listWebhooks` is available; getting a single webhook requires filtering the list by ID.
- **`editWebhook` tool** — update an existing webhook's URL, auth, headers, or trigger settings in place (`PUT /webhooks/{Id}`). Without this, changing any property requires deleting and recreating the webhook, creating a delivery gap.
- **`createWebhook`: `postFirstOpenOnly` parameter** — when Open trigger is enabled, fire only on the first open per message rather than every open.
- **`createWebhook`: `bounceIncludeContent` / `spamIncludeContent` parameters** — include the full email body in Bounce and SpamComplaint webhook payloads.
- **CI** — add automated test gating on pull requests.
- **Async log writes** — improve log write performance under burst load when `LOG_FILE` is configured.

---

## [2.1.1] - 2026-07-13

### Fixed

- **`npx @activecampaign/postmark-mcp` didn't actually work.** The README already documented this as the recommended, primary way to run the server, but the package was missing the `bin` entry and executable shebang needed for `npx`/global installs to resolve a command. `index.js` now starts with `#!/usr/bin/env node` and `package.json` declares `"bin": { "postmark-mcp": "index.js" }`.
- **README MIT license badge pointed at the wrong package.** It resolved `https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk`, showing `@modelcontextprotocol/sdk`'s license instead of this package's. Now points at `@activecampaign/postmark-mcp`.

### Changed

- **`prepublishOnly` script (`npm test`).** Runs the unit test suite automatically before `npm publish`, so a broken build can't be published by accident. Maintainer-facing only; no effect on consumers.

---

## [2.1.0] - 2026-06-17

### Added

- **Structured JSON logging to stderr.** Every tool invocation emits a log line with `{ timestamp, tool, clientName, clientVersion, sanitizedArgs, status, durationMs }`. Optional `LOG_FILE` env var additionally appends logs to a file for persistence and support escalation.
- **Email address masking in logs.** PII-reduced by default — the mailbox is partially masked (first and last characters retained, middle replaced with length-proportional asterisks — e.g. `alice@example.com` → `a***e@example.com`), domain logged in full. This is pseudonymization, not full anonymization: the domain and first/last initials are preserved. Set `LOG_EMAIL_FULL=true` to disable masking. Implemented in `lib/log.js`, which also sanitizes body content and API keys from logged arguments.
- **MCP client identity capture.** The `initialize` handshake captures the connecting client's name and version from the MCP protocol and attaches them to every log entry and outbound request header (`X-Postmark-MCP-Client: <name>/<version>`).
- **`AGENT_LABEL` env var and `X-Agent-Label` request header.** Allows operators to tag their MCP server instance with a label that is sent on every Postmark API request, enabling traffic attribution in server logs or API usage reports.
- **MCP tool annotations.** All 24 tools are annotated with `readOnlyHint`, `destructiveHint`, and `idempotentHint` so MCP clients can display risk indicators and gate destructive actions appropriately.
- **Tool descriptions.** All 24 `server.tool()` registrations now include a concise description string, improving tool discovery and LLM decision-making.
- **`sendEmail` multi-recipient support.** The `to` field now accepts either a single address string or an array of up to 50 addresses. Added optional `cc`, `bcc`, and `replyTo` fields.
- **`sendEmailWithTemplate` improvements.** Added `cc`, `bcc`, and `replyTo` fields. Added a mutual-exclusivity guard: supplying both `templateId` and `templateAlias` now fails fast with a descriptive error rather than sending an ambiguous request.
- **Webhook URL allowlist (`WEBHOOK_URL_ALLOWLIST`).** Set this env var to a comma-separated list of HTTPS URL prefixes; `createWebhook` will reject any URL that does not match. When unset, any valid HTTPS URL is accepted.
- **Actionable startup error messages.** Missing or invalid configuration now produces messages that name the env var, explain the consequence, and link to the relevant Postmark documentation page.
- **`npx`-based client configuration snippet in README.** Covers Cursor, Claude Desktop, and Windsurf — no local clone required.
- **Automated test suite (52 tests across 3 tiers).**
  - *Tier 1 — Unit* (`npm test`): 34 tests for `maskEmail`, `sanitizeArgs`, and `writeLog` in `lib/log.js`.
  - *Tier 2 — Offline MCP validation* (`npm run test:offline`): 11 tests covering webhook HTTPS enforcement, allowlist behavior, and tool annotation correctness — no Postmark account required.
  - *Tier 3 — E2E env var wiring* (`npm run test:e2e`): 7 tests verifying `LOG_FILE`, `LOG_EMAIL_FULL`, and MCP client identity capture end-to-end.
- **`POSTMARK_SKIP_VERIFY` env var.** Bypasses the startup `/server` connectivity check; intended for test environments and offline use.

### Changed

- **`X-Postmark-Client` correlation-id header replaced.** The `v2.0.0` request header `X-Postmark-Client: <version> / <uuid>` (per-request correlation UUID) has been replaced by two purpose-specific headers: `X-Postmark-MCP-Client: <name>/<version>` (MCP client identity from the `initialize` handshake) and `X-Agent-Label: <value>` (operator-supplied instance tag via `AGENT_LABEL`). If you built tooling to parse the old `X-Postmark-Client` header format, update accordingly.
- **`createWebhook` now requires HTTPS.** The `url` input is validated to start with `https://`; HTTP webhook URLs are rejected at the Zod schema level before any API call is made.
- **`listTemplates` response includes a truncation notice** when exactly 100 templates are returned, since the Postmark API caps this endpoint at 100 results with no pagination.
- **`searchBounces` and `searchOutboundMessages` document the 10,000 pagination cap.** The `offset` field description now notes that `count + offset` cannot exceed 10,000, matching Postmark API behavior.
- **`deleteTemplate` documentation notes Layout template constraints.** Layout templates that are referenced by other templates cannot be deleted until dependents are unbound or reassigned.
- **Logging extracted to `lib/log.js`.** A `createLogger` factory is exported, making the logging utilities independently testable and reusable.
- **Dependencies pinned to exact versions** (`@modelcontextprotocol/sdk@1.29.0`, `dotenv@16.6.1`, `zod@3.25.76`) to reduce supply chain risk.
- **`package-lock.json` is now committed.** Removed from `.gitignore` so `npm ci` installs a reproducible, audited dependency tree.
- **`npm run smoke` and `npm run smoke:mutating` scripts.** `smoke:mutating` is a new script for the mutating harness. Both now include a `pre` hook that detects the missing local file and prints the exact `cp` command to run rather than letting Node throw a cryptic "module not found" error.

## [2.0.0] - 2026-06-12

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
