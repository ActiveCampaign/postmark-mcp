/**
 * Tier 3: end-to-end env-var wiring tests.
 *
 * Verifies that LOG_FILE, LOG_EMAIL_FULL, and MCP client identity are all
 * wired correctly through the running server. No Postmark account required —
 * tool calls are expected to fail at the network level, but the logging
 * wrapper fires regardless and writes the LOG_FILE entry.
 *
 * Run:  node --test test-e2e.mjs
 *  or:  npm run test:e2e
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['index.js'],
    env: {
      ...process.env,
      POSTMARK_SERVER_TOKEN: 'POSTMARK_API_TEST',
      DEFAULT_SENDER_EMAIL: 'sender@example.com',
      DEFAULT_MESSAGE_STREAM: 'outbound',
      POSTMARK_SKIP_VERIFY: 'true',
      ...extraEnv,
    },
  });
  const client = new Client({ name: 'test-e2e', version: '1.2.3' });
  await client.connect(transport);
  return client;
}

/** Reads all newline-delimited JSON entries from a log file. */
function readLogEntries(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ─── Shared server (LOG_FILE tests + client identity) ─────────────────────────

let sharedLogFile;
let sharedServer;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'postmark-mcp-e2e-'));
  sharedLogFile = join(dir, 'server.log');
  sharedServer = await startServer({ LOG_FILE: sharedLogFile });

  // Trigger one tool invocation; getServerInfo has no required args.
  // It will fail at the Postmark API level (fetch / 401) but that is fine —
  // the logging wrapper always writes the log entry.
  await sharedServer.callTool({ name: 'getServerInfo', arguments: {} });
});

after(async () => {
  await sharedServer?.close();
  if (sharedLogFile && existsSync(sharedLogFile)) unlinkSync(sharedLogFile);
});

// ─── LOG_FILE ─────────────────────────────────────────────────────────────────

test('LOG_FILE: log entry is written after a tool invocation', () => {
  assert.ok(existsSync(sharedLogFile), 'log file should exist after a tool call');
  const entries = readLogEntries(sharedLogFile);
  assert.ok(entries.length >= 1, 'log file should contain at least one entry');
});

test('LOG_FILE: entry contains all required structured fields', () => {
  const [entry] = readLogEntries(sharedLogFile);
  assert.ok(entry.timestamp,   'entry should have a timestamp');
  assert.ok(entry.tool,        'entry should have a tool name');
  assert.equal(entry.tool, 'getServerInfo');
  assert.ok('clientName'    in entry, 'entry should have clientName');
  assert.ok('clientVersion' in entry, 'entry should have clientVersion');
  assert.ok('args'          in entry, 'entry should have args');
  assert.ok('status'        in entry, 'entry should have status');
  assert.ok('durationMs'    in entry, 'entry should have durationMs');
  assert.ok(typeof entry.durationMs === 'number', 'durationMs should be a number');
});

test('LOG_FILE: timestamp is a valid ISO 8601 date string', () => {
  const [entry] = readLogEntries(sharedLogFile);
  const d = new Date(entry.timestamp);
  assert.ok(!isNaN(d.getTime()), `timestamp "${entry.timestamp}" is not a valid date`);
});

// ─── MCP client identity ──────────────────────────────────────────────────────

test('log entry captures clientName and clientVersion from MCP initialize', () => {
  const [entry] = readLogEntries(sharedLogFile);
  assert.equal(entry.clientName,    'test-e2e', 'clientName should match the test client name');
  assert.equal(entry.clientVersion, '1.2.3',    'clientVersion should match the test client version');
});

// ─── LOG_EMAIL_FULL=false (default) ──────────────────────────────────────────

test('LOG_EMAIL_FULL unset: email address in tool args is masked in log', async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'postmark-mcp-e2e-'));
  const file = join(dir, 'masked.log');
  const client = await startServer({ LOG_FILE: file });

  try {
    await client.callTool({
      name: 'sendEmail',
      arguments: {
        to:       'alice@example.com',
        subject:  'Test subject',
        textBody: 'Test body',
      },
    });
  } finally {
    await client.close();
  }

  const entries = readLogEntries(file);
  assert.ok(entries.length >= 1, 'log file should contain at least one entry');
  const entry = entries.find(e => e.tool === 'sendEmail');
  assert.ok(entry, 'should have a sendEmail log entry');
  assert.notEqual(entry.args.to, 'alice@example.com', 'email should be masked');
  assert.match(entry.args.to, /^a\*+e@example\.com$/, 'email should follow masking pattern');
  unlinkSync(file);
});

// ─── LOG_EMAIL_FULL=true ──────────────────────────────────────────────────────

test('LOG_EMAIL_FULL=true: email address in tool args is NOT masked in log', async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'postmark-mcp-e2e-'));
  const file = join(dir, 'full.log');
  const client = await startServer({ LOG_FILE: file, LOG_EMAIL_FULL: 'true' });

  try {
    await client.callTool({
      name: 'sendEmail',
      arguments: {
        to:       'alice@example.com',
        subject:  'Test subject',
        textBody: 'Test body',
      },
    });
  } finally {
    await client.close();
  }

  const entries = readLogEntries(file);
  const entry = entries.find(e => e.tool === 'sendEmail');
  assert.ok(entry, 'should have a sendEmail log entry');
  assert.equal(entry.args.to, 'alice@example.com', 'email should be unmasked when LOG_EMAIL_FULL=true');
  unlinkSync(file);
});

// ─── Multiple invocations append ─────────────────────────────────────────────

test('LOG_FILE: multiple tool calls produce separate log entries in order', async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'postmark-mcp-e2e-'));
  const file = join(dir, 'multi.log');
  const client = await startServer({ LOG_FILE: file });

  try {
    await client.callTool({ name: 'getServerInfo',  arguments: {} });
    await client.callTool({ name: 'listWebhooks',   arguments: {} });
    await client.callTool({ name: 'getDeliveryStats', arguments: {} });
  } finally {
    await client.close();
  }

  const entries = readLogEntries(file);
  assert.equal(entries.length, 3, 'should have one log entry per tool call');
  assert.equal(entries[0].tool, 'getServerInfo');
  assert.equal(entries[1].tool, 'listWebhooks');
  assert.equal(entries[2].tool, 'getDeliveryStats');
  unlinkSync(file);
});
