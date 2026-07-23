// Mutating smoke test for the Postmark MCP server.
//
// SETUP:
//   1. Copy this file to `smoke-test-mutating.mjs`:
//        cp smoke-test-mutating.example.mjs smoke-test-mutating.mjs
//   2. Edit SENDER and RECIPIENT below to two of YOUR verified Postmark
//      addresses. Both must be sender signatures on the same Postmark account.
//   3. Ensure your `.env` has POSTMARK_SERVER_TOKEN, DEFAULT_SENDER_EMAIL,
//      and DEFAULT_MESSAGE_STREAM set.
//   4. Run:   node smoke-test-mutating.mjs
//
// `smoke-test-mutating.mjs` is gitignored so your local copy stays out
// of the repo.
//
// This script runs full create→edit→delete lifecycles for templates,
// layouts, webhooks, and suppressions, plus real email sends from SENDER
// to RECIPIENT (single, templated, single-with-a-valid-attachment, batch of 3,
// template-batch of 2 — total 8 emails). It also confirms a corrupted
// attachment is rejected locally (no email sent) rather than silently going
// out broken. It cleans up after itself; check your inbox to confirm sends.

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Configuration ─────────────────────────────────────────────────────
// REPLACE these placeholders with your verified Postmark sender signatures.
// SENDER is typically your DEFAULT_SENDER_EMAIL; RECIPIENT can be any
// verified address on the same account that you have access to read.
const SENDER = "you@example.com";          // your DEFAULT_SENDER_EMAIL
const RECIPIENT = "another-you@example.com"; // any verified address you control
// ──────────────────────────────────────────────────────────────────────

// Guard against running with placeholder values — refuses to send mail
// from clearly-illustrative addresses.
const PLACEHOLDERS = ["you@example.com", "another-you@example.com"];
if (PLACEHOLDERS.includes(SENDER) || PLACEHOLDERS.includes(RECIPIENT)) {
  console.error("Error: SENDER and RECIPIENT are still set to placeholder values.");
  console.error("Edit the constants near the top of this file with your verified");
  console.error("Postmark sender signatures before running.");
  process.exit(1);
}

const ts = Date.now();
const TEMPLATE_ALIAS = `mcp-smoke-${ts}`;
const LAYOUT_ALIAS = `mcp-smoke-layout-${ts}`;
const WEBHOOK_URL = `https://example.com/mcp-smoke-${ts}`;
const SUPPRESS_EMAIL = `mcp-smoke-${ts}@example.com`;

// Real, verified 1x1 truecolor+alpha PNG (70 bytes) — constructed and
// CRC-validated programmatically (see test-offline.mjs), not typed from memory.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

const transport = new StdioClientTransport({ command: "node", args: ["index.js"] });
const client = new Client({ name: "smoke-mutating", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const results = [];
const log = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail.split("\n")[0].slice(0, 140) : ""}`);
};

async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) {
      return { ok: false, text: r.content?.[0]?.text || "(no message)" };
    }
    return { ok: true, text: r.content?.[0]?.text || "" };
  } catch (err) {
    return { ok: false, text: err.message };
  }
}

let createdTemplateId = null;
let createdLayoutId = null;
let createdWebhookId = null;
let suppressionCreated = false;

try {
  // ─────────── Layout template (used for layout-binding lifecycle below) ───────────
  let r = await call("createTemplate", {
    name: `MCP Smoke Layout ${ts}`,
    htmlBody: "<html><body><div>{{{ @content }}}</div><footer>smoke layout</footer></body></html>",
    textBody: "{{{ @content }}}\n\n— smoke layout",
    alias: LAYOUT_ALIAS,
    templateType: "Layout",
  });
  log("createTemplate (Layout)", r.ok, r.text);
  if (r.ok) {
    const m = r.text.match(/ID:\s*(\d+)/);
    if (m) createdLayoutId = parseInt(m[1], 10);
  }

  // ─────────── Standard template lifecycle ───────────
  r = await call("createTemplate", {
    name: `MCP Smoke ${ts}`,
    subject: "Hello {{name}}",
    htmlBody: "<h1>Hi {{name}}</h1><p>Sent at " + ts + "</p>",
    textBody: "Hi {{name}} — sent at " + ts,
    alias: TEMPLATE_ALIAS,
    layoutTemplate: LAYOUT_ALIAS,
  });
  log("createTemplate (with layoutTemplate binding)",
    r.ok && r.text.includes(`Layout: ${LAYOUT_ALIAS}`),
    r.text);
  if (r.ok) {
    const m = r.text.match(/ID:\s*(\d+)/);
    if (m) createdTemplateId = parseInt(m[1], 10);
  }

  r = await call("getTemplate", { templateIdOrAlias: TEMPLATE_ALIAS });
  log("getTemplate (by alias)", r.ok && r.text.includes(`MCP Smoke ${ts}`), r.text);
  log("getTemplate (surfaces Layout binding)",
    r.ok && r.text.includes(`Layout: ${LAYOUT_ALIAS}`),
    r.text);

  r = await call("validateTemplate", {
    subject: "Hello {{name}}",
    htmlBody: "<h1>Hi {{name}}</h1>",
    textBody: "Hi {{name}}",
    testRenderModel: { name: "Test User" },
  });
  log("validateTemplate (valid)", r.ok && /ALL VALID/.test(r.text), r.text);

  r = await call("validateTemplate", {
    subject: "Hello {{#unclosed}}",
  });
  log("validateTemplate (invalid surfaced)", r.ok && /INVALID|HAS ERRORS/i.test(r.text), r.text);

  r = await call("editTemplate", {
    templateIdOrAlias: TEMPLATE_ALIAS,
    subject: "Updated subject {{name}}",
  });
  log("editTemplate", r.ok, r.text);

  // ─────────── Layout binding round-trip ───────────
  r = await call("editTemplate", {
    templateIdOrAlias: TEMPLATE_ALIAS,
    layoutTemplate: null,
  });
  log("editTemplate (unbind layout via null)",
    r.ok && r.text.includes(`Layout: none`),
    r.text);

  r = await call("getTemplate", { templateIdOrAlias: TEMPLATE_ALIAS });
  log("getTemplate (confirms layout unbound)",
    r.ok && r.text.includes(`Layout: none`),
    r.text);

  r = await call("editTemplate", {
    templateIdOrAlias: TEMPLATE_ALIAS,
    layoutTemplate: LAYOUT_ALIAS,
  });
  log("editTemplate (rebind layout)",
    r.ok && r.text.includes(`Layout: ${LAYOUT_ALIAS}`),
    r.text);

  r = await call("listTemplates", {});
  log("listTemplates (rows include Layout binding)",
    r.ok && r.text.includes(`Layout: ${LAYOUT_ALIAS}`),
    r.text);

  // ─────────── Email sends ───────────
  r = await call("sendEmail", {
    to: RECIPIENT,
    from: SENDER,
    subject: `MCP smoke test ${ts}`,
    textBody: "Plain text body from the MCP smoke test.",
    htmlBody: "<p>HTML body from the MCP smoke test.</p>",
    tag: "mcp-smoke-test",
  });
  log("sendEmail (real send)", r.ok, r.text);

  r = await call("sendEmailWithTemplate", {
    to: RECIPIENT,
    from: SENDER,
    templateAlias: TEMPLATE_ALIAS,
    templateModel: { name: "Test User" },
    tag: "mcp-smoke-test",
  });
  log("sendEmailWithTemplate (real send)", r.ok, r.text);

  // ─────────── Attachment validation ───────────
  r = await call("sendEmail", {
    to: RECIPIENT,
    from: SENDER,
    subject: `MCP smoke test — attachment ${ts}`,
    textBody: "Real send with a valid attachment.",
    tag: "mcp-smoke-test",
    attachments: [{ name: "pixel.png", content: TINY_PNG_BASE64, contentType: "image/png" }],
  });
  log("sendEmail (real send, valid attachment)", r.ok && r.text.includes("Attachments: pixel.png"), r.text);

  r = await call("sendEmail", {
    to: RECIPIENT,
    from: SENDER,
    subject: `MCP smoke test — corrupted attachment ${ts}`,
    textBody: "This send should be rejected before anything goes out.",
    tag: "mcp-smoke-test",
    attachments: [{ name: "bad.png", content: TINY_PNG_BASE64.slice(0, -10), contentType: "image/png" }],
  });
  log("sendEmail (corrupted attachment rejected, nothing sent)", !r.ok, r.text);

  // ─────────── Batch sends ───────────
  r = await call("sendBatch", {
    messages: [
      { to: RECIPIENT, from: SENDER, subject: `MCP batch #1 ${ts}`, textBody: "Batch test 1", tag: "mcp-smoke-test" },
      { to: RECIPIENT, from: SENDER, subject: `MCP batch #2 ${ts}`, textBody: "Batch test 2", tag: "mcp-smoke-test" },
      { to: RECIPIENT, from: SENDER, subject: `MCP batch #3 ${ts}`, textBody: "Batch test 3", tag: "mcp-smoke-test" },
    ],
  });
  log("sendBatch (3 messages, formatter renders)",
    r.ok && /Sent \d+\/3/.test(r.text),
    r.text);

  r = await call("sendBatchWithTemplate", {
    templateAlias: TEMPLATE_ALIAS,
    from: SENDER,
    tag: "mcp-smoke-test",
    recipients: [
      { to: RECIPIENT, templateModel: { name: "Test User (batch 1)" } },
      { to: RECIPIENT, templateModel: { name: "Test User (batch 2)" } },
    ],
  });
  log("sendBatchWithTemplate (real sends)",
    r.ok && /Sent 2\/2/.test(r.text),
    r.text);

  // ─────────── Webhook lifecycle ───────────
  r = await call("createWebhook", {
    url: WEBHOOK_URL,
    messageStream: process.env.DEFAULT_MESSAGE_STREAM,
    bounceEnabled: true,
    spamComplaintEnabled: true,
  });
  log("createWebhook", r.ok, r.text);
  if (r.ok) {
    const m = r.text.match(/ID:\s*(\d+)/);
    if (m) createdWebhookId = parseInt(m[1], 10);
  }

  r = await call("listWebhooks", { messageStream: process.env.DEFAULT_MESSAGE_STREAM });
  log("listWebhooks (sees new hook)",
    r.ok && r.text.includes(WEBHOOK_URL),
    r.text);

  // ─────────── Suppression lifecycle ───────────
  r = await call("createSuppressions", {
    emailAddresses: [SUPPRESS_EMAIL],
    messageStream: process.env.DEFAULT_MESSAGE_STREAM,
  });
  log("createSuppressions", r.ok && /Suppressed|Pending/i.test(r.text), r.text);
  if (r.ok && /Suppressed|Pending/i.test(r.text)) suppressionCreated = true;

  // Note: the Postmark suppressions dump endpoint is eventually consistent,
  // so we only assert the call succeeds — not that the just-created entry
  // appears in the snapshot.
  r = await call("listSuppressions", {
    messageStream: process.env.DEFAULT_MESSAGE_STREAM,
    emailAddress: SUPPRESS_EMAIL,
  });
  log("listSuppressions (call succeeds)", r.ok, r.text);

} finally {
  // ─────────── Cleanup ───────────
  console.log("\n──── cleanup ────");

  if (createdTemplateId !== null || true) {
    const r = await call("deleteTemplate", { templateIdOrAlias: TEMPLATE_ALIAS });
    log("deleteTemplate", r.ok, r.text);
  }

  if (createdLayoutId !== null) {
    const r = await call("deleteTemplate", { templateIdOrAlias: LAYOUT_ALIAS });
    log("deleteTemplate (Layout)", r.ok, r.text);
  } else {
    log("deleteTemplate (Layout — skipped, never created)", true, "");
  }

  if (createdWebhookId !== null) {
    const r = await call("deleteWebhook", { webhookId: createdWebhookId });
    log("deleteWebhook", r.ok, r.text);
  } else {
    log("deleteWebhook (skipped — no webhook created)", true, "");
  }

  if (suppressionCreated) {
    const r = await call("deleteSuppressions", {
      emailAddresses: [SUPPRESS_EMAIL],
      messageStream: process.env.DEFAULT_MESSAGE_STREAM,
    });
    log("deleteSuppressions", r.ok, r.text);
  } else {
    log("deleteSuppressions (skipped — no suppression created)", true, "");
  }

  await client.close();

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
