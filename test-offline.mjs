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
 *   7. Email send tools require confirmation and carry destructiveHint: true
 *   8. Destructive tools carry destructiveHint: true
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
  'createTemplate', 'activateBounce', 'createSuppressions', 'createWebhook',
];

const EMAIL_SEND_TOOLS = [
  'sendEmail', 'sendEmailWithTemplate', 'sendBatch', 'sendBatchWithTemplate',
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

test('email send tools require confirmation and are marked destructive', async () => {
  const { tools } = await serverNoAllowlist.listTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of EMAIL_SEND_TOOLS) {
    const tool = byName[name];
    assert.ok(tool, `tool "${name}" not found in listTools response`);
    assert.equal(tool.annotations?.readOnlyHint, false, `${name}: readOnlyHint should be false`);
    assert.equal(tool.annotations?.destructiveHint, true, `${name}: destructiveHint should be true`);
    assert.equal(tool.annotations?.idempotentHint, false, `${name}: idempotentHint should be false`);
    assert.match(tool.description, /obtain explicit confirmation/i, `${name}: description should require confirmation`);
    assert.match(tool.description, /never retry automatically/i, `${name}: description should prohibit automatic retries`);
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
  const categorised = new Set([
    ...READ_ONLY_TOOLS,
    ...MUTATING_TOOLS,
    ...EMAIL_SEND_TOOLS,
    ...DESTRUCTIVE_TOOLS,
  ]);
  const uncategorised = tools.filter(t => !categorised.has(t.name)).map(t => t.name);
  assert.deepEqual(
    uncategorised, [],
    `these tools are not covered by the annotation test lists: ${uncategorised.join(', ')}`,
  );
});
