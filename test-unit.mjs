/**
 * Unit tests for lib/log.js (maskEmail, sanitizeArgs, writeLog) and
 * lib/attachments.js (validateAttachment, assertMessageSize, assertBatchPayloadSize).
 *
 * No Postmark account or server required. All tests run against pure functions.
 * The attachments tests exercise multi-megabyte inputs directly (no MCP/stdio
 * round-trip), which is what keeps them fast — see test-offline.mjs for the
 * end-to-end wiring tests through the actual tool calls.
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
import {
  fmtBytes,
  validateAttachment,
  assertMessageSize,
  assertBatchPayloadSize,
  POSTMARK_MAX_MESSAGE_BYTES,
  POSTMARK_MAX_BATCH_PAYLOAD_BYTES,
  FORBIDDEN_ATTACHMENT_EXTENSIONS,
} from './lib/attachments.js';

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

// ─── lib/attachments.js — fmtBytes ─────────────────────────────────────────────

test('fmtBytes: bytes under 1024 shown as a plain count', () => {
  assert.equal(fmtBytes(512), '512 B');
});

test('fmtBytes: formats KB/MB/GB with one decimal place', () => {
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtBytes(2 * 1024 * 1024 * 1024), '2.0 GB');
});

// ─── validateAttachment — forbidden extensions ────────────────────────────────

test('validateAttachment: rejects every documented forbidden extension', () => {
  for (const ext of FORBIDDEN_ATTACHMENT_EXTENSIONS) {
    assert.throws(
      () => validateAttachment({ name: `file.${ext}`, content: 'QQ==', contentType: 'application/octet-stream' }, 'attachments[0]'),
      /forbidden attachment list/,
      `expected .${ext} to be rejected`,
    );
  }
});

test('validateAttachment: allows an extension not on the forbidden list', () => {
  assert.doesNotThrow(() =>
    validateAttachment({ name: 'file.dat', content: 'QQ==', contentType: 'application/octet-stream' }, 'attachments[0]'));
});

test('validateAttachment: forbidden-extension match is case-insensitive', () => {
  assert.throws(
    () => validateAttachment({ name: 'INSTALLER.EXE', content: 'QQ==', contentType: 'application/octet-stream' }, 'attachments[0]'),
    /forbidden attachment list/,
  );
});

test('validateAttachment: filename with no extension is not treated as forbidden', () => {
  assert.doesNotThrow(() =>
    validateAttachment({ name: 'README', content: 'QQ==', contentType: 'text/plain' }, 'attachments[0]'));
});

// ─── validateAttachment — base64 well-formedness ──────────────────────────────

test('validateAttachment: rejects characters outside the base64 alphabet', () => {
  assert.throws(
    () => validateAttachment({ name: 'a.txt', content: 'not-valid-base64!!!', contentType: 'text/plain' }, 'attachments[0]'),
    /base64 alphabet/,
  );
});

test('validateAttachment: rejects length not a multiple of 4', () => {
  assert.throws(
    () => validateAttachment({ name: 'a.txt', content: 'QQQ', contentType: 'text/plain' }, 'attachments[0]'),
    /multiple of 4/,
  );
});

test('validateAttachment: rejects non-canonical base64 that decodes leniently but fails to round-trip', () => {
  // "QR==" decodes to the same single byte as "QQ==" (Node ignores the non-zero
  // padding bits), but re-encoding that byte canonically produces "QQ==", not
  // "QR==" — exactly the kind of corruption a naive alphabet/length check misses.
  assert.throws(
    () => validateAttachment({ name: 'a.txt', content: 'QR==', contentType: 'text/plain' }, 'attachments[0]'),
    /round-trip/,
  );
});

test('validateAttachment: accepts well-formed base64 and maps to Postmark\'s field names', () => {
  const result = validateAttachment({ name: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }, 'attachments[0]');
  assert.equal(result.Name, 'a.txt');
  assert.equal(result.Content, 'aGVsbG8=');
  assert.equal(result.ContentType, 'text/plain');
});

test('validateAttachment: maps contentId to Postmark\'s ContentID field', () => {
  const result = validateAttachment(
    { name: 'a.png', content: 'aGVsbG8=', contentType: 'text/plain', contentId: 'logo' }, 'attachments[0]');
  assert.equal(result.ContentID, 'logo');
});

test('validateAttachment: omits ContentID when not provided', () => {
  const result = validateAttachment({ name: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }, 'attachments[0]');
  assert.equal('ContentID' in result, false);
});

// ─── validateAttachment — file signature ──────────────────────────────────────

test('validateAttachment: rejects content whose signature does not match its declared contentType', () => {
  assert.throws(
    () => validateAttachment({ name: 'a.png', content: 'aGVsbG8=', contentType: 'image/png' }, 'attachments[0]'),
    /file signature/,
  );
});

test('validateAttachment: skips the signature check for contentTypes with no known signature', () => {
  assert.doesNotThrow(() =>
    validateAttachment({ name: 'a.raw', content: 'aGVsbG8=', contentType: 'application/octet-stream' }, 'attachments[0]'));
});

// ─── validateAttachment — size limits ─────────────────────────────────────────

test('validateAttachment: rejects a single attachment whose base64 content alone exceeds 10MB', () => {
  const oversized = 'A'.repeat(POSTMARK_MAX_MESSAGE_BYTES + 4);
  assert.throws(
    () => validateAttachment({ name: 'huge.dat', content: oversized, contentType: 'application/octet-stream' }, 'attachments[0]'),
    /10 MB/,
  );
});

test('validateAttachment: accepts an attachment just under the 10MB ceiling', () => {
  const justUnder = 'A'.repeat(POSTMARK_MAX_MESSAGE_BYTES - 4);
  assert.doesNotThrow(() =>
    validateAttachment({ name: 'ok.dat', content: justUnder, contentType: 'application/octet-stream' }, 'attachments[0]'));
});

// ─── assertMessageSize ─────────────────────────────────────────────────────────

test('assertMessageSize: rejects textBody over 5MB', () => {
  assert.throws(
    () => assertMessageSize({ label: 'test', textBody: 'x'.repeat(5 * 1024 * 1024 + 1) }),
    /5 MB/,
  );
});

test('assertMessageSize: rejects htmlBody over 5MB', () => {
  assert.throws(
    () => assertMessageSize({ label: 'test', htmlBody: 'x'.repeat(5 * 1024 * 1024 + 1) }),
    /5 MB/,
  );
});

test('assertMessageSize: rejects combined body+attachments over 10MB even when each part alone is under its own limit', () => {
  assert.throws(
    () => assertMessageSize({ label: 'test', textBody: 'x'.repeat(4 * 1024 * 1024), attachmentBytes: 7 * 1024 * 1024 }),
    /10 MB total/,
  );
});

test('assertMessageSize: accepts a message comfortably under all limits', () => {
  assert.doesNotThrow(() =>
    assertMessageSize({ label: 'test', textBody: 'hello', htmlBody: '<p>hi</p>', attachmentBytes: 1024 }));
});

test('assertMessageSize: skips body checks entirely when textBody/htmlBody are omitted (template sends)', () => {
  assert.doesNotThrow(() => assertMessageSize({ label: 'test', attachmentBytes: 1024 }));
});

// ─── assertBatchPayloadSize ────────────────────────────────────────────────────

test('assertBatchPayloadSize: rejects a total over 50MB', () => {
  assert.throws(
    () => assertBatchPayloadSize(POSTMARK_MAX_BATCH_PAYLOAD_BYTES + 1, 'sendBatch'),
    /50 MB/,
  );
});

test('assertBatchPayloadSize: accepts a total at or under 50MB', () => {
  assert.doesNotThrow(() => assertBatchPayloadSize(POSTMARK_MAX_BATCH_PAYLOAD_BYTES, 'sendBatch'));
});
