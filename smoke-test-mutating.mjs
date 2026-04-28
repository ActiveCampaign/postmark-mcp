// Mutating smoke test for the Postmark MCP server.
// Runs full lifecycles for templates, webhooks, suppressions, and sends two
// real emails between Jabal's verified addresses. Cleans up after itself.

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SENDER = "recipient@example.com";       // DEFAULT_SENDER_EMAIL
const RECIPIENT = "recipient@example.com";   // another verified address
const ts = Date.now();
const TEMPLATE_ALIAS = `mcp-smoke-${ts}`;
const LAYOUT_ALIAS = `mcp-smoke-layout-${ts}`;
const WEBHOOK_URL = `https://example.com/mcp-smoke-${ts}`;
const SUPPRESS_EMAIL = `mcp-smoke-${ts}@example.com`; // fake local-part on user's domain

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
    testRenderModel: { name: "Jabal" },
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
    templateModel: { name: "Jabal" },
    tag: "mcp-smoke-test",
  });
  log("sendEmailWithTemplate (real send)", r.ok, r.text);

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
      { to: RECIPIENT, templateModel: { name: "Jabal (batch 1)" } },
      { to: RECIPIENT, templateModel: { name: "Jabal (batch 2)" } },
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
