/**
 * @file lib/log.js
 * @description Structured logging utilities for the Postmark MCP server.
 *
 * Exported via createLogger() so the sanitization and masking logic can be
 * unit-tested independently of the server runtime.
 */

import { appendFileSync } from 'fs';

// Fields whose values are always redacted regardless of content.
const REDACT_PATTERN = /password|secret|token|apikey|api_key/i;

// Fields whose string content is replaced with a byte-count marker.
const CONTENT_FIELDS = /htmlBody|textBody/i;

// Strings longer than this are truncated even outside known content fields.
const MAX_STRING_LEN = 300;

// Detects email-like strings so masking can be applied uniformly.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Creates a logger bound to a specific runtime configuration.
 *
 * @param {{ emailFull?: boolean, logFile?: string|null }} opts
 *   emailFull  – when true, email addresses are not masked in log output
 *   logFile    – if set, log lines are also appended to this file path
 *
 * @returns {{ maskEmail, sanitizeArgs, writeLog }}
 */
export function createLogger({ emailFull = false, logFile = null } = {}) {

  /**
   * Masks an email address for log output:
   *   user@example.com    → u**r@example.com
   *   ab@example.com      → a*b@example.com   (2-char: always ≥1 star)
   *   a@example.com       → a@example.com      (1-char: nothing to mask)
   * Domain is always preserved in full.
   * When emailFull is true the original string is returned unchanged.
   */
  function maskEmail(email) {
    if (emailFull) return email;
    const at = email.lastIndexOf('@');
    if (at <= 0) return email;
    const mailbox = email.slice(0, at);
    const domain  = email.slice(at + 1);
    if (mailbox.length <= 1) return email;
    const stars  = '*'.repeat(Math.max(1, mailbox.length - 2));
    return `${mailbox[0]}${stars}${mailbox[mailbox.length - 1]}@${domain}`;
  }

  function sanitizeValue(key, value) {
    if (REDACT_PATTERN.test(key)) return '[redacted]';

    if (typeof value === 'string') {
      if (CONTENT_FIELDS.test(key)) return `[${value.length}ch]`;
      if (value.length > MAX_STRING_LEN) return `[truncated ${value.length}ch]`;
      if (EMAIL_RE.test(value)) return maskEmail(value);
      // Comma-separated email lists (e.g. cc, bcc fields)
      if (value.includes(',')) {
        const parts = value.split(',').map(s => s.trim());
        if (parts.length > 1 && parts.every(p => EMAIL_RE.test(p))) {
          return parts.map(maskEmail).join(', ');
        }
      }
      return value;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return [];
      // Attachment arrays — surface count + filenames, never log base64 content
      if (value[0] && typeof value[0] === 'object' && 'content' in value[0] && 'name' in value[0]) {
        return { _count: value.length, names: value.map(a => a.name).slice(0, 20) };
      }
      // Message / recipient arrays — surface count + addressees, drop content
      if (value[0] && typeof value[0] === 'object') {
        const addrs = value
          .map(m => m.to || m.email || m.EmailAddress)
          .filter(Boolean)
          .map(a => maskEmail(a));
        return addrs.length
          ? { _count: value.length, _recipients: addrs.slice(0, 20) }
          : { _count: value.length };
      }
      // Primitive arrays (e.g. array of email strings)
      const items = value.length <= 20
        ? value
        : [...value.slice(0, 20), `…+${value.length - 20} more`];
      return items.map(item =>
        (typeof item === 'string' && EMAIL_RE.test(item)) ? maskEmail(item) : item
      );
    }

    // Arbitrary data objects (templateModel etc.) — show key names, not values
    if (value && typeof value === 'object') return { _keys: Object.keys(value) };

    return value;
  }

  /**
   * Returns a sanitized copy of a tool-arguments object safe for logging.
   * All sensitive, large, or PII-bearing values are replaced in-place.
   */
  function sanitizeArgs(args) {
    if (!args || typeof args !== 'object') return {};
    return Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, sanitizeValue(k, v)])
    );
  }

  /**
   * Writes a JSON log entry to stderr. If logFile is configured, also appends
   * to that file. File write failures are reported as a warning line on stderr
   * and never propagate to the caller.
   */
  function writeLog(entry) {
    const line = JSON.stringify(entry);
    process.stderr.write(line + '\n');
    if (logFile) {
      try {
        appendFileSync(logFile, line + '\n');
      } catch (e) {
        process.stderr.write(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          message: `LOG_FILE write failed: ${e.message}`,
        }) + '\n');
      }
    }
  }

  return { maskEmail, sanitizeArgs, writeLog };
}
