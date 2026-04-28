# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Official Postmark MCP (Model Context Protocol) server that enables AI assistants (Claude, Cursor, etc.) to interact with the Postmark email API. Published as `@activecampaign/postmark-mcp` on NPM.

## Commands

- **Run server:** `npm start` (runs `node index.js`)
- **Debug with MCP Inspector:** `npm run inspector` (launches `@modelcontextprotocol/inspector`)
- **Smoke test (read-only, 23 checks):** `npm run smoke` — runs [smoke-test.mjs](smoke-test.mjs). Spawns the server over stdio and exercises every read-only tool against the live Postmark account configured in `.env`. Does not send mail or mutate state.
- **Smoke test (mutating, 14 checks):** `node smoke-test-mutating.mjs` — runs full create→edit→delete lifecycles for templates, webhooks, and suppressions, plus two real email sends between the user's verified addresses. Cleans up after itself. Edit the `SENDER` and `RECIPIENT` constants at the top before running on a different account.
- **No linter is configured.**

## Architecture

This is a single-file MCP server (`index.js`) using ES modules (`"type": "module"`). The structure within `index.js`:

1. **Module-level formatting helpers** — `fmtInt`, `fmtPct`, `fmtPlatformUsage`, `fmtTopBreakdown`, `fmtDeliverySummary`, `fmtStatResponse`. Used by `getDeliveryStats` to render polished per-stat output. Keep these pure / dependency-free.
2. **`initializeServices()`** — Validates required env vars, creates a `postmark.ServerClient`, verifies connectivity via `getServer()`, and instantiates `McpServer` from `@modelcontextprotocol/sdk`
3. **`registerTools(server, postmarkClient)`** — Registers all 21 MCP tools with Zod schemas for input validation. Each tool wraps a Postmark SDK call and returns formatted text responses
4. **`main()`** — Orchestrates initialization, tool registration, and connects to `StdioServerTransport`

Communication uses stdio transport (stdin/stdout), not HTTP. All `console.error` calls are diagnostic logging (stdout is reserved for MCP protocol).

## MCP Tools Registered

The server exposes 22 tools across these categories:
- **Email:** sendEmail, sendEmailWithTemplate
- **Templates:** listTemplates, getTemplate, createTemplate, editTemplate, deleteTemplate, validateTemplate
- **Messages:** searchOutboundMessages, getMessageDetails
- **Diagnostics:** diagnoseDelivery
- **Bounces:** searchBounces, getBounceDump, activateBounce
- **Suppressions:** listSuppressions, createSuppressions, deleteSuppressions
- **Stats & Server:** getDeliveryStats, getServerInfo
- **Webhooks:** listWebhooks, createWebhook, deleteWebhook

`diagnoseDelivery` is a **composite tool** — it does not mirror a single Postmark endpoint. Instead it runs `getOutboundMessages` (or `getOutboundMessageDetails`), `getSuppressions`, and `getBounces` in parallel for the given recipient, then synthesizes a plain-English recommendation. When adding new diagnostic tools, follow the same pattern: parallelize independent lookups via `Promise.all`, swallow individual failures with `.catch(() => fallback)` so one 404 doesn't sink the whole diagnosis, and end with a `Recommended action` block that interprets the data.

`getDeliveryStats` is unified: with no arguments it returns a friendly headline summary; with `stat: "<name>"` it returns a polished per-stat breakdown. Supported `stat` values: `summary`, `overview`, `sent`, `bounces`, `spam`, `tracked`, `opens`, `openPlatforms`, `openClients`, `openReadTimes`, `clicks`, `clickBrowsers`, `clickPlatforms`, `clickLocation`. Each value maps to a specific `postmarkClient.get*` method in the `fetchers` object inside the tool — when adding a new stat, add both the enum value and the fetcher entry.

## Environment Variables

Required (set in `.env` for local dev, or in MCP client config for production):
- `POSTMARK_SERVER_TOKEN` — Postmark server API token
- `DEFAULT_SENDER_EMAIL` — Fallback sender address
- `DEFAULT_MESSAGE_STREAM` — Message stream ID (typically `outbound`)

## Key Patterns

- All emails are auto-configured with `TrackOpens: true` and `TrackLinks: "HtmlAndText"`
- All tools use the `postmark` npm client (no raw `fetch` — the SDK handles auth, retries, and error mapping consistently)
- Tool handlers follow a consistent pattern: log start, call API, log result, return `{ content: [{ type: "text", text }] }`
- Postmark API field names are PascalCase (`From`, `To`, `Subject`, `EmailAddress`); query-string filters on list endpoints are typically lowercase (`fromdate`, `todate`, `messagestream`). The SDK accepts both since Postmark's API is case-insensitive on query params, but match the convention you see in nearby code
- Numeric IDs use `z.number().int()`; date strings use `.regex(/^\d{4}-\d{2}-\d{2}$/)` for YYYY-MM-DD validation
- Tools that mutate state include lightweight validation guards before hitting the API:
  - `editTemplate` requires at least one updated field (otherwise the call would be a wasted no-op)
  - `createWebhook` requires at least one trigger enabled (otherwise the webhook is dead-on-arrival)
  - `createTemplate` requires at least one of `htmlBody` / `textBody`
  - `validateTemplate` requires at least one of `subject` / `htmlBody` / `textBody`
  - `sendEmailWithTemplate` requires exactly one of `templateId` / `templateAlias`

## Gotchas

- The Postmark suppressions list endpoint (`/message-streams/{stream}/suppressions/dump`) is **eventually consistent** — a suppression created milliseconds earlier may not appear in the next `listSuppressions` call. Don't write tests that assume strict read-your-writes for this endpoint.
- `getServer()` returns `PostFirstOpenOnly` for the "first open only" tracking setting. `EnableSmtpApiErrorHooks` is a different (unrelated) flag — don't conflate them in `getServerInfo`'s output.
- `getOutboundOverview` includes `Opens` / `UniqueOpens` despite the field naming — the response is broader than the endpoint name suggests, which is why `getDeliveryStats` can use it for both `summary` and `overview` modes.
- Several SDK methods don't exist with intuitive names. Use the correct ones: `getEmailOpenClientUsage` (not `getEmailClientUsage`), `getEmailOpenPlatformUsage` (not `getEmailPlatformUsage`), `getClickLocation` (not `getClickLocationUsage`).
