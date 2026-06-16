/**
 * Unit tests for lib/log.js — maskEmail, sanitizeArgs, writeLog.
 *
 * No Postmark account or server required. All tests run against pure functions.
 *
 * Run:  npm test
 *  or:  node --test test-unit.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from './lib/log.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const masked   = (opts = {}) => createLogger({ emailFull: false, ...opts });
const fullMode = (opts = {}) => createLogger({ emailFull: true,  ...opts });

// ─── maskEmail ────────────────────────────────────────────────────────────────

test('maskEmail: normal mailbox masks middle chars, preserves domain', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('user@example.com'), 'u**r@example.com');
});

test('maskEmail: 2-char mailbox always injects at least one star', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('ab@example.com'), 'a*b@example.com');
});

test('maskEmail: 1-char mailbox is returned unchanged', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('a@example.com'), 'a@example.com');
});

test('maskEmail: plus-addressed mailbox masks correctly', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('contact+tag@postmarkapp.com'), 'c*********g@postmarkapp.com');
});

test('maskEmail: dots in mailbox are masked', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('alice.smith@company.co.uk'), 'a*********h@company.co.uk');
});

test('maskEmail: multi-part domain is preserved in full', () => {
  const { maskEmail } = masked();
  const result = maskEmail('me@sub.domain.example.org');
  assert.match(result, /@sub\.domain\.example\.org$/);
});

test('maskEmail: minimal valid email (single-char mailbox) is unchanged', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('x@y.z'), 'x@y.z');
});

test('maskEmail: string without @ is returned unchanged', () => {
  const { maskEmail } = masked();
  assert.equal(maskEmail('notanemail'), 'notanemail');
});

test('maskEmail: emailFull=true returns address unchanged', () => {
  const { maskEmail } = fullMode();
  assert.equal(maskEmail('user@example.com'), 'user@example.com');
  assert.equal(maskEmail('ab@example.com'),   'ab@example.com');
});

// ─── sanitizeArgs — content fields ────────────────────────────────────────────

test('sanitizeArgs: htmlBody replaced with byte count', () => {
  const { sanitizeArgs } = masked();
  const body = '<h1>Hello</h1>';
  const result = sanitizeArgs({ htmlBody: body });
  assert.equal(result.htmlBody, `[${body.length}ch]`);
});

test('sanitizeArgs: textBody replaced with byte count', () => {
  const { sanitizeArgs } = masked();
  const body = 'Hello world';
  const result = sanitizeArgs({ textBody: body });
  assert.equal(result.textBody, `[${body.length}ch]`);
});

test('sanitizeArgs: string over MAX_STRING_LEN is truncated', () => {
  const { sanitizeArgs } = masked();
  const long = 'x'.repeat(301);
  const result = sanitizeArgs({ subject: long });
  assert.match(result.subject, /^\[truncated 301ch\]$/);
});

test('sanitizeArgs: string under MAX_STRING_LEN passes through', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ subject: 'Meeting Reminder' });
  assert.equal(result.subject, 'Meeting Reminder');
});

// ─── sanitizeArgs — redaction ─────────────────────────────────────────────────

test('sanitizeArgs: field named "apikey" is redacted', () => {
  const { sanitizeArgs } = masked();
  assert.equal(sanitizeArgs({ apikey: 'sk-abc123' }).apikey, '[redacted]');
});

test('sanitizeArgs: field named "secret" is redacted', () => {
  const { sanitizeArgs } = masked();
  assert.equal(sanitizeArgs({ secret: 'super-secret' }).secret, '[redacted]');
});

test('sanitizeArgs: field named "password" is redacted', () => {
  const { sanitizeArgs } = masked();
  assert.equal(sanitizeArgs({ password: 'hunter2' }).password, '[redacted]');
});

test('sanitizeArgs: field named "token" is redacted', () => {
  const { sanitizeArgs } = masked();
  assert.equal(sanitizeArgs({ token: 'abc' }).token, '[redacted]');
});

test('sanitizeArgs: field named "secretToken" (mixed case) is redacted', () => {
  const { sanitizeArgs } = masked();
  assert.equal(sanitizeArgs({ secretToken: 'xyz' }).secretToken, '[redacted]');
});

// ─── sanitizeArgs — email masking ─────────────────────────────────────────────

test('sanitizeArgs: email string values are masked', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ to: 'user@example.com' });
  assert.equal(result.to, 'u**r@example.com');
});

test('sanitizeArgs: emailFull=true leaves email values unmasked', () => {
  const { sanitizeArgs } = fullMode();
  const result = sanitizeArgs({ to: 'user@example.com' });
  assert.equal(result.to, 'user@example.com');
});

test('sanitizeArgs: non-email strings are not masked', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ tag: 'onboarding', messageStream: 'outbound' });
  assert.equal(result.tag, 'onboarding');
  assert.equal(result.messageStream, 'outbound');
});

// ─── sanitizeArgs — scalars and primitives ────────────────────────────────────

test('sanitizeArgs: boolean values pass through', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ openEnabled: true, deliveryEnabled: false });
  assert.equal(result.openEnabled, true);
  assert.equal(result.deliveryEnabled, false);
});

test('sanitizeArgs: number values pass through', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ count: 50, offset: 0, bounceId: 123456 });
  assert.equal(result.count, 50);
  assert.equal(result.bounceId, 123456);
});

// ─── sanitizeArgs — objects ───────────────────────────────────────────────────

test('sanitizeArgs: templateModel object replaced with key list', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ templateModel: { name: 'Alice', plan: 'Pro', token: 'xyz' } });
  assert.deepEqual(result.templateModel, { _keys: ['name', 'plan', 'token'] });
});

test('sanitizeArgs: empty object replaced with empty key list', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({ templateModel: {} });
  assert.deepEqual(result.templateModel, { _keys: [] });
});

// ─── sanitizeArgs — arrays ────────────────────────────────────────────────────

test('sanitizeArgs: empty array stays empty', () => {
  const { sanitizeArgs } = masked();
  assert.deepEqual(sanitizeArgs({ items: [] }).items, []);
});

test('sanitizeArgs: messages array summarised as { _count, _recipients } with masked emails', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({
    messages: [
      { to: 'alice@example.com', subject: 'Hi', textBody: 'Hello' },
      { to: 'bob@example.com',   subject: 'Hey', textBody: 'World' },
    ],
  });
  assert.deepEqual(result.messages, {
    _count: 2,
    _recipients: ['a***e@example.com', 'b*b@example.com'],
  });
});

test('sanitizeArgs: recipients array (sendBatchWithTemplate) summarised correctly', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({
    recipients: [
      { to: 'user@example.com', templateModel: { name: 'Alice' } },
      { to: 'ab@corp.io',       templateModel: { name: 'Bob' } },
    ],
  });
  assert.equal(result.recipients._count, 2);
  assert.deepEqual(result.recipients._recipients, ['u**r@example.com', 'a*b@corp.io']);
});

test('sanitizeArgs: emailAddresses primitive array has each email masked', () => {
  const { sanitizeArgs } = masked();
  const result = sanitizeArgs({
    emailAddresses: ['user@example.com', 'ab@corp.io', 'a@x.com'],
  });
  assert.deepEqual(result.emailAddresses, ['u**r@example.com', 'a*b@corp.io', 'a@x.com']);
});

test('sanitizeArgs: emailAddresses with emailFull=true are unmasked', () => {
  const { sanitizeArgs } = fullMode();
  const result = sanitizeArgs({ emailAddresses: ['user@example.com', 'ab@corp.io'] });
  assert.deepEqual(result.emailAddresses, ['user@example.com', 'ab@corp.io']);
});

test('sanitizeArgs: large primitive array is truncated with a tail marker', () => {
  const { sanitizeArgs } = masked();
  const bigArray = Array.from({ length: 25 }, (_, i) => `item-${i}`);
  const result = sanitizeArgs({ items: bigArray });
  assert.equal(result.items.length, 21); // 20 items + tail marker
  assert.match(result.items[20], /\+5 more/);
});

// ─── writeLog / LOG_FILE ──────────────────────────────────────────────────────

test('writeLog: writes JSON line to LOG_FILE', () => {
  const dir  = mkdtempSync(join(tmpdir(), 'postmark-mcp-test-'));
  const file = join(dir, 'test.log');
  const { writeLog } = createLogger({ logFile: file });

  writeLog({ tool: 'getServerInfo', status: 'ok', durationMs: 42 });

  const raw = readFileSync(file, 'utf8').trim();
  const entry = JSON.parse(raw);
  assert.equal(entry.tool, 'getServerInfo');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.durationMs, 42);
  unlinkSync(file);
});

test('writeLog: multiple calls append lines (not overwrite)', () => {
  const dir  = mkdtempSync(join(tmpdir(), 'postmark-mcp-test-'));
  const file = join(dir, 'test.log');
  const { writeLog } = createLogger({ logFile: file });

  writeLog({ tool: 'sendEmail',    status: 'ok' });
  writeLog({ tool: 'listWebhooks', status: 'ok' });

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).tool, 'sendEmail');
  assert.equal(JSON.parse(lines[1]).tool, 'listWebhooks');
  unlinkSync(file);
});

test('writeLog: no LOG_FILE does not create a file', () => {
  const { writeLog } = createLogger({ logFile: null });
  const path = join(tmpdir(), `postmark-mcp-should-not-exist-${Date.now()}.log`);
  writeLog({ tool: 'getServerInfo', status: 'ok' });
  assert.equal(existsSync(path), false);
});
