/**
 * Tier 2: offline MCP validation tests.
 *
 * Tests that run entirely locally — no Postmark account required.
 * The server is started with POSTMARK_API_TEST as the token; validation
 * under test fires before any network call is made to Postmark.
 *
 * Covers:
 *   1. createWebhook rejects http:// URLs (Zod schema enforcement)
 *   2. createWebhook rejects URLs not in WEBHOOK_URL_ALLOWLIST
 *   3. createWebhook accepts URLs that match the allowlist prefix
 *   4. All registered tools carry annotation objects
 *   5. Read-only tools carry readOnlyHint: true
 *   6. Mutating tools carry readOnlyHint: false, destructiveHint: false
 *   7. Destructive tools carry destructiveHint: true
 *
 * Run:  node --test test-offline.mjs
 *  or:  npm run test:offline
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Server factory ────────────────────────────────────────────────────────────

/**
 * Spawns index.js over stdio and returns a connected MCP Client.
 * Caller is responsible for calling client.close() when done.
 */
async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['index.js'],
    env: {
      ...process.env,
      // POSTMARK_API_TEST is the documented Postmark test token — accepted by the
      // API without a real account, but all validation under test here fires before
      // any HTTP call reaches Postmark.
      POSTMARK_SERVER_TOKEN: 'POSTMARK_API_TEST',
      DEFAULT_SENDER_EMAIL: 'sender@example.com',
      DEFAULT_MESSAGE_STREAM: 'outbound',
      POSTMARK_SKIP_VERIFY: 'true',
      ...extraEnv,
    },
  });
  const client = new Client({ name: 'test-offline', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns the MCP result object (never throws on tool errors). */
async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

/** Returns true when the MCP result represents a tool-level error. */
function isToolError(result) {
  return result?.isError === true;
}

/** Extracts the error text from a tool error result. */
function errorText(result) {
  return result?.content?.map(c => c.text ?? '').join(' ') ?? '';
}

// ─── Webhook URL enforcement ───────────────────────────────────────────────────
//
// These tests share a single server instance with no allowlist set.

let serverNoAllowlist;

before(async () => {
  serverNoAllowlist = await startServer();
});

after(async () => {
  await serverNoAllowlist?.close();
});

test('createWebhook: rejects http:// URL (Zod schema enforcement)', async () => {
  const result = await callTool(serverNoAllowlist, 'createWebhook', {
    url: 'http://example.com/hook',
    openEnabled: true,
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
});

test('createWebhook: accepts https:// URL when no allowlist is configured', async () => {
  // With no allowlist the HTTPS check should pass (any HTTPS URL is allowed).
  // The call WILL reach the Postmark API and fail there, but we only care that
  // the local validation passes — so we expect an API error, not a Zod error.
  const result = await callTool(serverNoAllowlist, 'createWebhook', {
    url: 'https://example.com/hook',
    openEnabled: true,
  });
  // Either the API accepted it (isError false) or Postmark returned an API-level
  // error — both mean local validation passed. A Zod error would contain "Invalid"
  // in the message and never reach Postmark at all.
  if (isToolError(result)) {
    const text = errorText(result);
    assert.ok(
      !text.includes('Invalid') && !text.includes('startsWith'),
      `local Zod validation should have passed, but got: ${text}`,
    );
  }
});

test('createWebhook: rejects URL missing required trigger flags', async () => {
  // No trigger enabled — should be rejected by the handler guard before the API.
  const result = await callTool(serverNoAllowlist, 'createWebhook', {
    url: 'https://example.com/hook',
    // intentionally omit all trigger flags
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /trigger/i);
});

// ─── WEBHOOK_URL_ALLOWLIST enforcement ────────────────────────────────────────
//
// Each sub-test needs its own server instance with a specific allowlist value.

test('createWebhook: rejects URL not matching WEBHOOK_URL_ALLOWLIST', async () => {
  const client = await startServer({
    WEBHOOK_URL_ALLOWLIST: 'https://allowed.example.com,https://also-allowed.example.com',
  });
  try {
    const result = await callTool(client, 'createWebhook', {
      url: 'https://blocked.example.com/hook',
      openEnabled: true,
    });
    assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
    assert.match(errorText(result), /allowed/i);
  } finally {
    await client.close();
  }
});

test('createWebhook: accepts URL matching WEBHOOK_URL_ALLOWLIST prefix', async () => {
  const client = await startServer({
    WEBHOOK_URL_ALLOWLIST: 'https://allowed.example.com',
  });
  try {
    const result = await callTool(client, 'createWebhook', {
      url: 'https://allowed.example.com/my/hook',
      openEnabled: true,
    });
    // The URL passed local validation. If Postmark returns an error that's fine —
    // we only assert the error is NOT our allowlist rejection.
    if (isToolError(result)) {
      const text = errorText(result);
      assert.ok(
        !text.toLowerCase().includes('allowed'),
        `should not be rejected by allowlist, but got: ${text}`,
      );
    }
  } finally {
    await client.close();
  }
});

test('createWebhook: accepts first entry of a multi-entry WEBHOOK_URL_ALLOWLIST', async () => {
  const client = await startServer({
    WEBHOOK_URL_ALLOWLIST: 'https://first.example.com,https://second.example.com',
  });
  try {
    const result = await callTool(client, 'createWebhook', {
      url: 'https://first.example.com/hook',
      openEnabled: true,
    });
    if (isToolError(result)) {
      const text = errorText(result);
      assert.ok(!text.toLowerCase().includes('allowed'), `unexpected allowlist rejection: ${text}`);
    }
  } finally {
    await client.close();
  }
});

// ─── S1 regression: allowlist bypass vectors ──────────────────────────────────
//
// These two URLs pass a naive startsWith() check but resolve to different hosts.
// Both must be rejected by the fixed URL-parsed allowlist implementation.

test('createWebhook: rejects userinfo bypass (S1 regression)', async () => {
  // https://allowed.example.com@evil.test/hook
  // startsWith("https://allowed.example.com") → true, but host === "evil.test"
  const client = await startServer({
    WEBHOOK_URL_ALLOWLIST: 'https://allowed.example.com',
  });
  try {
    const result = await callTool(client, 'createWebhook', {
      url: 'https://allowed.example.com@evil.test/hook',
      openEnabled: true,
    });
    assert.ok(isToolError(result), `expected rejection, got: ${JSON.stringify(result)}`);
    assert.match(errorText(result), /rejected|allowed/i);
  } finally {
    await client.close();
  }
});

test('createWebhook: rejects subdomain suffix bypass (S1 regression)', async () => {
  // https://allowed.example.com.evil.test/hook
  // startsWith("https://allowed.example.com") → true, but host === "allowed.example.com.evil.test"
  const client = await startServer({
    WEBHOOK_URL_ALLOWLIST: 'https://allowed.example.com',
  });
  try {
    const result = await callTool(client, 'createWebhook', {
      url: 'https://allowed.example.com.evil.test/hook',
      openEnabled: true,
    });
    assert.ok(isToolError(result), `expected rejection, got: ${JSON.stringify(result)}`);
    assert.match(errorText(result), /rejected|allowed/i);
  } finally {
    await client.close();
  }
});

// ─── Attachment validation ──────────────────────────────────────────────────────
//
// TINY_PNG_BASE64 is a real, verified 1x1 truecolor+alpha PNG (70 bytes) —
// constructed and CRC-validated programmatically, not typed from memory, so
// these tests exercise genuine base64/signature validation rather than a
// string that merely looks plausible.

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('sendEmail: rejects attachment with invalid base64 characters', async () => {
  const result = await callTool(serverNoAllowlist, 'sendEmail', {
    to: 'someone@example.com',
    subject: 'Test',
    textBody: 'Test body',
    attachments: [{ name: 'bad.png', content: 'not-valid-base64!!!', contentType: 'image/png' }],
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /base64/i);
});

test('sendEmail: rejects attachment whose content does not match its declared contentType', async () => {
  const result = await callTool(serverNoAllowlist, 'sendEmail', {
    to: 'someone@example.com',
    subject: 'Test',
    textBody: 'Test body',
    // Valid PNG bytes, but mislabeled as a JPEG — the structural validation check should catch
    // this regardless of the base64 syntax being perfectly well-formed.
    attachments: [{ name: 'photo.jpg', content: TINY_PNG_BASE64, contentType: 'image/jpeg' }],
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /signature/i);
});

test('sendEmail: rejects attachment truncated after encoding (simulates a mangled transcription)', async () => {
  const result = await callTool(serverNoAllowlist, 'sendEmail', {
    to: 'someone@example.com',
    subject: 'Test',
    textBody: 'Test body',
    attachments: [{ name: 'pixel.png', content: TINY_PNG_BASE64.slice(0, -10), contentType: 'image/png' }],
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /base64|signature/i);
});

test('sendEmail: accepts a valid small PNG attachment (passes local validation)', async () => {
  const result = await callTool(serverNoAllowlist, 'sendEmail', {
    to: 'someone@example.com',
    subject: 'Test',
    textBody: 'Test body',
    attachments: [{ name: 'pixel.png', content: TINY_PNG_BASE64, contentType: 'image/png' }],
  });
  // Either Postmark's test API accepted it, or it returned an API-level error —
  // both mean our local base64/signature validation passed. A validation error
  // from our own code would mention "base64" or "signature" and never reach Postmark.
  if (isToolError(result)) {
    const text = errorText(result);
    assert.ok(
      !/base64|signature/i.test(text),
      `local attachment validation should have passed, but got: ${text}`,
    );
  }
});

test('sendEmail: rejects a forbidden attachment file extension regardless of content', async () => {
  const result = await callTool(serverNoAllowlist, 'sendEmail', {
    to: 'someone@example.com',
    subject: 'Test',
    textBody: 'Test body',
    attachments: [{ name: 'installer.exe', content: 'QQ==', contentType: 'application/octet-stream' }],
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /forbidden/i);
});

// Size-limit math (5MB/10MB/50MB thresholds) is covered directly and cheaply
// in test-unit.mjs against lib/attachments.js — driving a multi-megabyte
// payload through a real MCP/stdio round-trip here would work identically
// but take tens of seconds instead of milliseconds for no added confidence.

test('sendBatch: rejects a corrupted attachment on one message before any send reaches Postmark', async () => {
  const result = await callTool(serverNoAllowlist, 'sendBatch', {
    messages: [
      {
        to: 'someone@example.com', subject: 'Test 1', textBody: 'Body 1',
        attachments: [{ name: 'bad.png', content: 'not-valid-base64!!!', contentType: 'image/png' }],
      },
      { to: 'someone-else@example.com', subject: 'Test 2', textBody: 'Body 2' },
    ],
  });
  assert.ok(isToolError(result), `expected tool error, got: ${JSON.stringify(result)}`);
  assert.match(errorText(result), /messages\[0\]\.attachments\[0\]/);
});

// ─── Tool annotations ─────────────────────────────────────────────────────────
//
// Verifies that every tool has an annotations object and that the
// read-only / mutating / destructive hints are applied to the correct tools.

const READ_ONLY_TOOLS = [
  'listTemplates', 'getTemplate', 'validateTemplate',
  'searchOutboundMessages', 'getMessageDetails', 'diagnoseDelivery',
  'searchBounces', 'getBounceDump', 'listSuppressions',
  'getDeliveryStats', 'getServerInfo', 'listWebhooks',
];

const MUTATING_TOOLS = [
  'sendEmail', 'sendEmailWithTemplate', 'sendBatch', 'sendBatchWithTemplate',
  'createTemplate', 'activateBounce', 'createSuppressions', 'createWebhook',
];

const DESTRUCTIVE_TOOLS = [
  'editTemplate', 'deleteTemplate', 'deleteSuppressions', 'deleteWebhook',
];

test('all tools expose an annotations object', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  assert.ok(tools.length > 0, 'server should expose at least one tool');
  const missing = tools.filter(t => !t.annotations || typeof t.annotations !== 'object');
  assert.deepEqual(missing.map(t => t.name), [], 'some tools are missing annotations');
});

test('read-only tools have readOnlyHint: true and destructiveHint: false', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of READ_ONLY_TOOLS) {
    const tool = byName[name];
    assert.ok(tool, `tool "${name}" not found in listTools response`);
    assert.equal(tool.annotations?.readOnlyHint, true,  `${name}: readOnlyHint should be true`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name}: destructiveHint should be false`);
  }
});

test('mutating tools have readOnlyHint: false and destructiveHint: false', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of MUTATING_TOOLS) {
    const tool = byName[name];
    assert.ok(tool, `tool "${name}" not found in listTools response`);
    assert.equal(tool.annotations?.readOnlyHint,   false, `${name}: readOnlyHint should be false`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name}: destructiveHint should be false`);
  }
});

test('destructive tools have destructiveHint: true and readOnlyHint: false', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of DESTRUCTIVE_TOOLS) {
    const tool = byName[name];
    assert.ok(tool, `tool "${name}" not found in listTools response`);
    assert.equal(tool.annotations?.destructiveHint, true,  `${name}: destructiveHint should be true`);
    assert.equal(tool.annotations?.readOnlyHint,    false, `${name}: readOnlyHint should be false`);
  }
});

test('every registered tool belongs to exactly one annotation category', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  const categorised = new Set([...READ_ONLY_TOOLS, ...MUTATING_TOOLS, ...DESTRUCTIVE_TOOLS]);
  const uncategorised = tools.filter(t => !categorised.has(t.name)).map(t => t.name);
  assert.deepEqual(
    uncategorised, [],
    `these tools are not covered by the annotation test lists: ${uncategorised.join(', ')}`,
  );
});
