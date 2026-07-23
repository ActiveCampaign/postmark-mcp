/**
 * @file lib/attachments.js
 * @description Attachment validation for the Postmark MCP server — base64
 * well-formedness, file-signature matching, forbidden-extension checks, and
 * Postmark's documented size limits.
 *
 * Pulled out of index.js (mirroring lib/log.js) so this logic can be
 * unit-tested directly with plain values, instead of only reachable by
 * driving the full MCP server over stdio — which matters here because the
 * size-limit checks are only meaningfully exercised with multi-megabyte
 * payloads; routing that through a real stdio round-trip is orders of
 * magnitude slower than calling the functions directly.
 */

import { z } from 'zod';

// Known file signatures ("magic bytes") for the attachment types most likely
// to be sent through this tool. Used to catch corrupted or mistyped base64
// (e.g. a model reconstructing image bytes as text token-by-token rather than
// reading the real file) before Postmark accepts the send as a "success" — a
// mismatched signature means the decoded bytes cannot be the declared type,
// independent of whether the base64 syntax itself happens to be well-formed.
export const ATTACHMENT_FILE_SIGNATURES = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
};

// Postmark's own documented limits (verified against
// https://postmarkapp.com/support/article/1056-what-are-the-attachment-and-email-size-limits
// and https://postmarkapp.com/developer/user-guide/send-email-with-api/send-a-single-email).
// Sizes are measured the way Postmark measures them: post-base64-encoding, i.e.
// the length of the base64 string itself, not the decoded byte count.
export const POSTMARK_MAX_BODY_BYTES = 5 * 1024 * 1024;           // TextBody / HtmlBody, each
export const POSTMARK_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;       // total per message: body + attachments
export const POSTMARK_MAX_BATCH_PAYLOAD_BYTES = 50 * 1024 * 1024; // total per sendBatch/sendBatchWithTemplate call

// File extensions Postmark rejects outright regardless of content or contentType
// (same source as the size limits above).
export const FORBIDDEN_ATTACHMENT_EXTENSIONS = new Set([
  'vbs', 'exe', 'bin', 'bat', 'chm', 'com', 'cpl', 'crt', 'hlp', 'hta', 'inf', 'ins',
  'isp', 'jse', 'lnk', 'mdb', 'pcd', 'pif', 'reg', 'scr', 'sct', 'shs', 'vbe', 'vba',
  'wsf', 'wsh', 'wsl', 'msc', 'msi', 'msp', 'mst',
]);

// This tool's own conservative default, not a Postmark-documented limit — a
// structural guard against degenerate attachment counts even when each one is
// individually tiny. The size limits above are the ones that matter in practice.
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Formats a byte count for error messages, e.g. 8912896 -> "8.5 MB". */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)} ${units[i]}`;
}

export const attachmentSchema = z.object({
  name: z.string().min(1).describe("Filename including extension, e.g. \"invoice.pdf\". Files with a forbidden extension (executables, scripts, and similar — see attachments field description) are always rejected."),
  content: z.string().min(1).describe("Base64-encoded file content"),
  contentType: z.string().min(1).describe("MIME type, e.g. \"image/png\", \"application/pdf\""),
  contentId: z.string().optional().describe("Optional Content ID — reference as cid:<contentId> inside htmlBody to render inline instead of as a downloadable file. Must be unique within the message.")
});

export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional()
  .describe(
    `Optional file attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message — this tool's own conservative default, not a Postmark limit). ` +
    `Postmark's real limits: total message size (body + attachments combined, measured after base64 encoding) must stay under 10 MB, and these file extensions are always rejected regardless of content: ${[...FORBIDDEN_ATTACHMENT_EXTENSIONS].sort().join(', ')}. ` +
    `A full-resolution photo from a modern phone camera is often 3-8 MB by itself — compress or resize large images before attaching rather than sending the original. ` +
    `Each attachment's base64 content is validated (well-formed encoding, size, and for common image/PDF types a matching file signature) before anything is sent — a failed validation means nothing was sent, so it's always safe to retry with corrected data.`
  );

/**
 * Validates one attachment — file extension, base64 well-formedness, size,
 * and (for common types) file signature — and returns the Postmark
 * Attachments entry shape ({ Name, Content, ContentType, ContentID }).
 * Throws a descriptive Error rather than silently passing through malformed,
 * corrupted, or oversized data. `label` identifies the attachment in error
 * messages, e.g. "attachments[0]".
 */
export function validateAttachment(att, label) {
  const dot = att.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : att.name.slice(dot + 1).toLowerCase();
  if (FORBIDDEN_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new Error(`${label} ("${att.name}"): the ".${ext}" file extension is on Postmark's forbidden attachment list and is always rejected, regardless of content — see https://postmarkapp.com/developer/user-guide/send-email-with-api/send-a-single-email`);
  }

  const stripped = att.content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new Error(`${label} ("${att.name}"): content is not valid base64 — it contains characters outside the base64 alphabet`);
  }
  if (stripped.length % 4 !== 0) {
    throw new Error(`${label} ("${att.name}"): content is not valid base64 — length is not a multiple of 4`);
  }
  if (stripped.length > POSTMARK_MAX_MESSAGE_BYTES) {
    throw new Error(`${label} ("${att.name}"): base64 content is ${fmtBytes(stripped.length)} on its own, which already exceeds Postmark's 10 MB total message size limit. Compress or resize the file before attaching.`);
  }

  const decoded = Buffer.from(stripped, 'base64');
  if (decoded.length === 0) {
    throw new Error(`${label} ("${att.name}"): content decoded to 0 bytes`);
  }
  // Buffer.from() silently drops invalid runs rather than throwing, so a
  // round-trip re-encode is what actually catches malformed/truncated base64.
  if (decoded.toString('base64').replace(/=+$/, '') !== stripped.replace(/=+$/, '')) {
    throw new Error(`${label} ("${att.name}"): content does not round-trip as valid base64 — it may have been truncated or corrupted before reaching this tool`);
  }

  const signatures = ATTACHMENT_FILE_SIGNATURES[att.contentType?.toLowerCase()];
  if (signatures && !signatures.some(sig => sig.every((byte, i) => decoded[i] === byte))) {
    throw new Error(`${label} ("${att.name}"): decoded content does not match the file signature expected for ${att.contentType} — the data is likely corrupted or mislabeled. Re-encode the original file rather than resending as-is.`);
  }

  return { Name: att.name, Content: stripped, ContentType: att.contentType, ...(att.contentId && { ContentID: att.contentId }) };
}

/** Validates and maps an `attachments` tool-input array to Postmark's Attachments shape. Returns undefined when not provided. */
export function buildAttachments(attachments) {
  if (!attachments?.length) return undefined;
  return attachments.map((att, i) => validateAttachment(att, `attachments[${i}]`));
}

/**
 * Enforces Postmark's per-message size limits: 5 MB per TextBody/HtmlBody
 * section, 10 MB total (body + attachments, measured after base64 encoding —
 * `attachmentBytes` should be the summed length of each attachment's base64
 * Content string). `textBody`/`htmlBody` are omitted for template-based sends
 * (sendEmailWithTemplate/sendBatchWithTemplate) since the rendered body size
 * isn't known client-side; the 10 MB check still applies to attachments alone.
 */
export function assertMessageSize({ label, textBody, htmlBody, attachmentBytes = 0 }) {
  const textBytes = textBody ? Buffer.byteLength(textBody, 'utf8') : 0;
  const htmlBytes = htmlBody ? Buffer.byteLength(htmlBody, 'utf8') : 0;
  if (textBytes > POSTMARK_MAX_BODY_BYTES) {
    throw new Error(`${label}: textBody is ${fmtBytes(textBytes)}, which exceeds Postmark's 5 MB limit per body section`);
  }
  if (htmlBytes > POSTMARK_MAX_BODY_BYTES) {
    throw new Error(`${label}: htmlBody is ${fmtBytes(htmlBytes)}, which exceeds Postmark's 5 MB limit per body section`);
  }
  const total = textBytes + htmlBytes + attachmentBytes;
  if (total > POSTMARK_MAX_MESSAGE_BYTES) {
    throw new Error(`${label}: combined size is ${fmtBytes(total)} (body + attachments, measured after base64 encoding), which exceeds Postmark's 10 MB total message limit. Reduce attachment size/count or shorten the body.`);
  }
}

/** Enforces Postmark's documented 50 MB total payload limit for a batch send call. */
export function assertBatchPayloadSize(totalBytes, toolName) {
  if (totalBytes > POSTMARK_MAX_BATCH_PAYLOAD_BYTES) {
    throw new Error(`${toolName}: combined payload size across all messages is ${fmtBytes(totalBytes)}, which exceeds Postmark's 50 MB total batch payload limit. Split this into multiple smaller batch calls.`);
  }
}
