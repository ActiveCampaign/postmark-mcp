# Official Postmark MCP Server&nbsp;&nbsp;&nbsp;[![NPM Version](https://img.shields.io/npm/v/@activecampaign/postmark-mcp.svg)](https://www.npmjs.com/package/@activecampaign/postmark-mcp)&nbsp;&nbsp;![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk)

Send emails with Postmark using Claude and other MCP-compatible AI assistants.

## Features
- Exposes a Model Context Protocol (MCP) server backed by your [Postmark account](https://account.postmarkapp.com/sign_up)
- 24 tools spanning email sending (single + batch), templates (CRUD + validation), message search, delivery diagnostics, bounces, suppressions, stats, server info, and webhooks
- Simple configuration via environment variables
- Comprehensive error handling and graceful shutdown
- Secure logging practices (no sensitive data exposure)
- Automatic open/click tracking on every send

## Useful Docs
- [📒 API Documentation](https://postmarkapp.com/developer)
- [🔎 API Explorer](https://postmarkapp.com/api-explorer)
- [📖 Engineering Articles](https://postmarkapp.com/blog/topics/engineering)

## Feedback
We'd love to hear from you! Please share your feedback and suggestions using our [feedback form](https://forms.gle/zVdZLAJPM81Vo2Wh8).

Follow us on X - [@postmarkapp](https://x.com/postmarkapp)

---

# Setup

## Requirements
- Node.js v20 or higher
- A [Postmark account](https://account.postmarkapp.com/sign_up) and server token

## Installation (Local Development)
**Clone the repository:**
```sh
git clone https://github.com/ActiveCampaign/postmark-mcp
cd postmark-mcp
```

**Install dependencies:**
```sh
npm install
# or
yarn
# or
bun install
```

## Configuration (Local Development)

Create your own environment file from the example

```sh
cp .env.example .env
```

Edit your `.env` to contain your Postmark credentials and settings.

**Important:** This is intended for local development purposes only. Secrets should never be stored in version control and `.env` type files should be added to `.gitignore`.

| Variable                  | Description                                      | Required   |
|---------------------------|--------------------------------------------------|------------|
| POSTMARK_SERVER_TOKEN     | Your Postmark server API token                   | Yes        |
| DEFAULT_SENDER_EMAIL      | Default sender email address                     | Yes        |
| DEFAULT_MESSAGE_STREAM    | Postmark message stream (e.g., 'outbound')       | Yes        |

**Run the server:**

```sh
npm start
# or
yarn start
# or
bun start
```

**Smoke test (requires valid `.env`):**

```sh
npm run smoke
```

Spawns the server over stdio and exercises every read-only tool against your Postmark account, plus the validation paths for `editTemplate` and `createWebhook`. Does not send mail or mutate state.

## Cursor Quick Install
<div>
  <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=Postmark&config=eyJjb21tYW5kIjoibm9kZSIsImFyZ3MiOlsiaW5kZXguanMiXSwiZW52Ijp7IlBPU1RNQVJLX1NFUlZFUl9UT0tFTiI6IiIsIkRFRkFVTFRfU0VOREVSX0VNQUlMIjoiIiwiREVGQVVMVF9NRVNTQUdFX1NUUkVBTSI6Im91dGJvdW5kIn19">
    <img src="https://img.shields.io/badge/Add_Postmark_MCP_Server-to_Cursor-00A4DB?style=for-the-badge&logo=cursor&logoColor=white" alt="Add Postmark MCP Server to Cursor" />
  </a>
</div>
<br />

After installing the MCP, update your configuration to set:
- `POSTMARK_SERVER_TOKEN`
- `DEFAULT_SENDER_EMAIL`
- `DEFAULT_MESSAGE_STREAM` (default: `outbound`)

## Claude and Cursor MCP Configuration Example
```json
{
  "mcpServers": {
    "postmark": {
      "command": "node",
      "args": ["path/to/postmark-mcp/index.js"],
      "env": {
        "POSTMARK_SERVER_TOKEN": "your-postmark-server-token",
        "DEFAULT_SENDER_EMAIL": "your-sender-email@example.com",
        "DEFAULT_MESSAGE_STREAM": "your-message-stream"
      }
    }
  }
}
```

## Tools
This section provides a complete reference for the Postmark MCP server tools including example prompts and payloads. The server registers **24 tools** organized into eight categories.

### Table of Contents
- [Email](#email)
  - [sendEmail](#sendemail)
  - [sendEmailWithTemplate](#sendemailwithtemplate)
  - [sendBatch](#sendbatch)
  - [sendBatchWithTemplate](#sendbatchwithtemplate)
- [Templates](#templates)
  - [listTemplates](#listtemplates)
  - [getTemplate](#gettemplate)
  - [createTemplate](#createtemplate)
  - [editTemplate](#edittemplate)
  - [deleteTemplate](#deletetemplate)
  - [validateTemplate](#validatetemplate)
- [Messages](#messages)
  - [searchOutboundMessages](#searchoutboundmessages)
  - [getMessageDetails](#getmessagedetails)
- [Diagnostics](#diagnostics)
  - [diagnoseDelivery](#diagnosedelivery)
- [Bounces](#bounces)
  - [searchBounces](#searchbounces)
  - [getBounceDump](#getbouncedump)
  - [activateBounce](#activatebounce)
- [Suppressions](#suppressions)
  - [listSuppressions](#listsuppressions)
  - [createSuppressions](#createsuppressions)
  - [deleteSuppressions](#deletesuppressions)
- [Stats & Server](#stats--server)
  - [getDeliveryStats](#getdeliverystats)
  - [getServerInfo](#getserverinfo)
- [Webhooks](#webhooks)
  - [listWebhooks](#listwebhooks)
  - [createWebhook](#createwebhook)
  - [deleteWebhook](#deletewebhook)

---

## Email

### sendEmail
Sends a single text (and optional HTML) email.

**Example Prompt:**
```
Send an email using Postmark to recipient@example.com with the subject "Meeting Reminder" and the message "Don't forget our team meeting tomorrow at 2 PM."
```

**Expected Payload:**
```json
{
  "to": "recipient@example.com",
  "subject": "Meeting Reminder",
  "textBody": "Don't forget our team meeting tomorrow at 2 PM.",
  "htmlBody": "<p>Don't forget our team meeting tomorrow at 2 PM.</p>",
  "from": "sender@example.com",
  "tag": "meetings"
}
```

`htmlBody`, `from`, and `tag` are optional. If `from` is omitted, `DEFAULT_SENDER_EMAIL` is used.

**Response:**
```
Email sent successfully!
MessageID: 0a1b2c3d-...
To: recipient@example.com
Subject: Meeting Reminder
```

### sendEmailWithTemplate
Sends an email using a Postmark template.

**Example Prompt:**
```
Send the "welcome" template to customer@example.com with name "John Doe" and login_url "https://myapp.com/login".
```

**Expected Payload:**
```json
{
  "to": "customer@example.com",
  "templateAlias": "welcome",
  "templateModel": {
    "name": "John Doe",
    "login_url": "https://myapp.com/login"
  },
  "from": "sender@example.com",
  "tag": "onboarding"
}
```

Provide **either** `templateId` (number) **or** `templateAlias` (string), not both.

**Response:**
```
Template email sent successfully!
MessageID: 0a1b2c3d-...
To: customer@example.com
Template: welcome
```

### sendBatch
Sends up to 500 emails in a single API call. Each message is fully independent (its own recipient, subject, body). Postmark's [bulk email API](https://postmarkapp.com/developer/api/bulk-email) handles the underlying batch — this tool wraps it and synthesizes a per-message success/failure summary.

**Expected Payload:**
```json
{
  "messages": [
    {
      "to": "alice@example.com",
      "subject": "Order #1234 confirmed",
      "textBody": "Thanks Alice — your order is on its way.",
      "tag": "order-confirmation"
    },
    {
      "to": "bob@example.com",
      "subject": "Order #1235 confirmed",
      "textBody": "Thanks Bob — your order is on its way.",
      "tag": "order-confirmation"
    }
  ]
}
```

Per-message fields: `to`, `subject`, `textBody` are required. `htmlBody`, `from`, `cc`, `bcc`, `replyTo`, and `tag` are optional. If `from` is omitted on a message, `DEFAULT_SENDER_EMAIL` is used.

**Response:**
```
Sent 2/2 successfully

Successes:
  - alice@example.com — abc-123-def
  - bob@example.com — abc-456-ghi
```

When some messages fail at submission (e.g., suppressed recipients), failures are listed first with their `ErrorCode` and reason:
```
Sent 8/10 successfully (2 failed)

Failures:
  - blocked@example.com — 406: Address has been suppressed.
  - bad@example.com — 300: Inactive recipient
...
```

### sendBatchWithTemplate
Sends up to 500 templated emails — same template, per-recipient template models. Ideal for "render this onboarding template for each new user" flows.

**Expected Payload:**
```json
{
  "templateAlias": "welcome",
  "from": "hello@yourapp.com",
  "tag": "onboarding",
  "recipients": [
    { "to": "alice@example.com", "templateModel": { "name": "Alice", "plan": "Pro" } },
    { "to": "bob@example.com", "templateModel": { "name": "Bob", "plan": "Free" } }
  ]
}
```

Provide **either** `templateId` (number) **or** `templateAlias` (string). Top-level `from` and `tag` apply to all recipients but can be overridden per-recipient. Each recipient also accepts optional `cc`, `bcc`, and `replyTo`.

**Response:** same format as `sendBatch`.

---

## Templates

### listTemplates
Lists all templates on the server.

**Response:**
```
Found 2 templates:

• **Welcome**
  - ID: 12345678
  - Alias: welcome
  - Subject: Welcome to {{product_name}}
```

### getTemplate
Retrieves a single template's full content (HTML body, text body, subject, type).

**Payload:** `{ "templateIdOrAlias": "welcome" }` — accepts numeric ID or string alias.

### createTemplate
Creates a new template. Requires `name`. At least one of `htmlBody` or `textBody` must be provided.

`subject` is required for Standard templates and must be **omitted** for Layout templates — Postmark rejects the field on Layouts.

`layoutTemplate` (Standard only) binds the new template to an existing Layout by alias. Without it, the new template renders unwrapped (no chrome from any layout).

**Expected Payload:**
```json
{
  "name": "Order Confirmation",
  "subject": "Your order #{{order_id}} is confirmed",
  "htmlBody": "<h1>Thanks {{name}}</h1>",
  "textBody": "Thanks {{name}}",
  "alias": "order-confirmation",
  "templateType": "Standard",
  "layoutTemplate": "basic"
}
```

`templateType` may be `"Standard"` (default) or `"Layout"`.

### editTemplate
Updates an existing template. Requires `templateIdOrAlias` plus **at least one** updated field (`name`, `subject`, `htmlBody`, `textBody`, `alias`, or `layoutTemplate`).

Pass `"layoutTemplate": null` to unbind a template from its current Layout (the MCP translates this to the empty-string the Postmark API requires for clearing the association).

### deleteTemplate
Deletes a template by ID or alias.

**Payload:** `{ "templateIdOrAlias": "order-confirmation" }`

### validateTemplate
Validates template content (Mustachio syntax, undefined variables) without saving. At least one of `subject`, `htmlBody`, or `textBody` is required.

**Expected Payload:**
```json
{
  "subject": "Order #{{order_id}}",
  "htmlBody": "<p>Thanks {{name}}</p>",
  "textBody": "Thanks {{name}}",
  "testRenderModel": { "order_id": 42, "name": "John" },
  "templateType": "Standard"
}
```

---

## Messages

### searchOutboundMessages
Searches the outbound message history.

**Expected Payload (all filters optional):**
```json
{
  "recipient": "user@example.com",
  "fromEmail": "sender@example.com",
  "tag": "marketing",
  "subject": "Welcome",
  "status": "sent",
  "messageStream": "outbound",
  "fromDate": "2025-05-01",
  "toDate": "2025-05-15",
  "count": 50,
  "offset": 0
}
```

`status` is one of `queued`, `sent`, `processed`. `count` is 1–500 (default 50).

### getMessageDetails
Retrieves full details and event timeline for a single outbound message.

**Payload:** `{ "messageId": "0a1b2c3d-..." }`

---

## Diagnostics

### diagnoseDelivery
Composite triage tool. Answers "did my email reach X, and if not, why?" by running message search, suppression check, and bounce history lookups in parallel against a recipient address, then synthesizing a plain-English recommendation.

This is a **diagnostic** tool: it composes multiple Postmark API calls into a single coherent answer rather than mirroring a single endpoint.

**Example Prompt:**
```
Did my email to recipient@example.com get delivered? If not, what should I do?
```

**Expected Payload:**
```json
{
  "recipient": "recipient@example.com",
  "messageId": "0a1b2c3d-...",
  "fromDate": "2026-04-21",
  "toDate": "2026-04-28",
  "messageStream": "outbound"
}
```

All fields except `recipient` are optional. If `messageId` is omitted, the most recent message to the recipient is used. The default search window is the last 7 days.

**Sample response:**
```
Delivery Diagnosis: recipient@example.com
────────────────────────────────────────────────

Suppression: not suppressed on stream "outbound"

Most recent message:
  MessageID: fadeae4e-fb04-4102-9303-9876078c7b81
  Subject:   Welcome to MyApp
  Sent:      2026-04-27T18:42:19.0000000-04:00
  Status:    Sent
  Events:    Delivered, Opened×2, Clicked

Bounce history: none

Recommended action:
  Email was delivered. If recipient says they didn't see it, check their
  spam folder or ask them to whitelist the sender domain.
```

When the recipient is suppressed, the recommendation differs based on reason: `SpamComplaint` is permanent, `HardBounce` may be reactivatable, `ManualSuppression` can be deleted via `deleteSuppressions`.

---

## Bounces

### searchBounces
Searches the bounce log with optional filters by type, recipient, tag, message ID, date range, and active/inactive status.

**Expected Payload (all optional):**
```json
{
  "type": "HardBounce",
  "inactive": true,
  "emailFilter": "@example.com",
  "tag": "marketing",
  "messageID": "0a1b2c3d-...",
  "fromDate": "2025-05-01",
  "toDate": "2025-05-15",
  "count": 50,
  "offset": 0
}
```

Supported `type` values: `HardBounce`, `SoftBounce`, `SpamNotification`, `SpamComplaint`, `Unsubscribe`, `AddressChange`, `AutoResponder`, `ChallengeVerification`, `DmarcPolicy`, `ManuallyDeactivated`, `Transient`, `SMTPApiError`, `InboundError`, `DNSError`, `BadEmailAddress`, `TemplateRenderingFailed`.

### getBounceDump
Returns the raw SMTP dump for a bounce. Bounce dumps are retained for 30 days.

**Payload:** `{ "bounceId": 123456 }`

### activateBounce
Reactivates a deactivated email address (only bounces where `CanActivate: true`).

**Payload:** `{ "bounceId": 123456 }`

---

## Suppressions

### listSuppressions
Lists suppressions for a message stream.

**Expected Payload (all optional):**
```json
{
  "messageStream": "outbound",
  "suppressionReason": "HardBounce",
  "origin": "Recipient",
  "emailAddress": "user@example.com",
  "fromDate": "2025-05-01",
  "toDate": "2025-05-15"
}
```

`suppressionReason` ∈ `HardBounce`, `SpamComplaint`, `ManualSuppression`. `origin` ∈ `Recipient`, `Customer`, `Admin`. If `messageStream` is omitted, `DEFAULT_MESSAGE_STREAM` is used.

### createSuppressions
Suppresses up to 50 email addresses on a message stream.

**Payload:** `{ "emailAddresses": ["a@example.com", "b@example.com"], "messageStream": "outbound" }`

### deleteSuppressions
Removes up to 50 addresses from the suppression list. Note: `SpamComplaint` suppressions cannot be deleted.

**Payload:** `{ "emailAddresses": ["a@example.com"], "messageStream": "outbound" }`

---

## Stats & Server

### getDeliveryStats
Unified stats tool. Default behavior returns a friendly headline summary; pass an optional `stat` for a focused breakdown.

**Expected Payload (all optional):**
```json
{
  "stat": "summary",
  "tag": "marketing",
  "fromDate": "2025-05-01",
  "toDate": "2025-05-15",
  "messageStream": "outbound"
}
```

Supported `stat` values:

| `stat` | What it returns |
|---|---|
| `summary` *(default)* | Headline open / click / bounce / spam rates |
| `overview` | All overview counts (sent, tracked, opens, clicks, bounces, …) |
| `sent` | Sent count |
| `bounces` | Bounce breakdown by type |
| `spam` | Spam complaint count |
| `tracked` | Tracked email count |
| `opens` | Total + unique opens |
| `openPlatforms` | Open platform breakdown (Desktop / Mobile / WebMail / Unknown) |
| `openClients` | Top 10 email clients (Apple Mail, Gmail, …) |
| `openReadTimes` | Read-time histogram |
| `clicks` | Total + unique link clicks |
| `clickBrowsers` | Top 10 browsers used to click |
| `clickPlatforms` | Click platform breakdown (Desktop / Mobile / WebMail / Unknown) |
| `clickLocation` | HTML vs. plain-text click location |

**Default summary response:**
```
Email Delivery Summary

Sent:        74
Tracked:     33  (44.6% of sent)
Open rate:   93.9%  (31/33 unique opens)
Click rate:  4.8%  (10/207 unique links clicked)
Bounced:     1  (1.4%)
Spam:        0  (0.0%)

Period: 2025-05-01 → 2025-05-15
Tag: marketing
```

**Sample `stat: "openPlatforms"` response:**
```
Open Platform Usage

  Desktop        20  (64.5%)
  Mobile          0  (0.0%)
  WebMail        11  (35.5%)
  Unknown         0  (0.0%)
```

### getServerInfo
Returns the Postmark server's name, color, tracking settings, and webhook URLs.

**Payload:** `{}`

---

## Webhooks

### listWebhooks
Lists configured webhooks. Optional `messageStream` filter.

### createWebhook
Creates a webhook subscription. Requires a `url` and **at least one** trigger.

**Expected Payload:**
```json
{
  "url": "https://example.com/postmark-hook",
  "messageStream": "outbound",
  "openEnabled": true,
  "clickEnabled": true,
  "deliveryEnabled": false,
  "bounceEnabled": true,
  "spamComplaintEnabled": true,
  "subscriptionChangeEnabled": false
}
```

### deleteWebhook
Deletes a webhook by ID.

**Payload:** `{ "webhookId": 1234567 }`

## Implementation Details
### Automatic Configuration
All emails are automatically configured with:
- `TrackOpens: true`
- `TrackLinks: "HtmlAndText"`
- Message stream from `DEFAULT_MESSAGE_STREAM` environment variable

### Error Handling
The server implements comprehensive error handling:
- Validation of all required environment variables
- Graceful shutdown on SIGTERM and SIGINT
- Proper error handling for API calls
- No exposure of sensitive information in logs
- Consistent error message formatting

### Logging
- Uses appropriate log levels (`info` for normal operations, `error` for errors)
- Excludes sensitive information from logs
- Provides clear operation status and results

---

*For more information about the Postmark API, visit [Postmark's Developer Documentation](https://postmarkapp.com/developer).* 

## License
[MIT](LICENSE) © ActiveCampaign