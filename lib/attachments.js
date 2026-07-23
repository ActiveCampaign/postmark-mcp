/**
 * @file lib/attachments.js
 * @description Attachment validation for the Postmark MCP server — base64
 * well-formedness, per-type structural integrity checks, forbidden-extension
 * checks, and Postmark's documented size limits.
 *
 * Pulled out of index.js (mirroring lib/log.js) so this logic can be
 * unit-tested directly with plain values, instead of only reachable by
 * driving the full MCP server over stdio — which matters here because the
 * size-limit checks are only meaningfully exercised with multi-megabyte
 * payloads; routing that through a real stdio round-trip is orders of
 * magnitude slower than calling the functions directly.
 */

import { z } from 'zod';

// CRC32 (PNG spec, Annex D) — needed to verify PNG chunk integrity below.
const CRC32_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Walks every PNG chunk and verifies each one's CRC32, and that the chunk
 * stream exactly spans the buffer and ends in IEND. A bare magic-byte check
 * only proves the file *starts* like a PNG — it cannot catch a corrupted or
 * truncated body (e.g. a model that transcribed the header correctly but
 * drifted partway through a long base64 string), which decodes to the right
 * first 8 bytes but garbage after. This is the check that actually catches
 * that failure mode, since any changed/truncated byte breaks a chunk's CRC.
 */
function isValidPng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((b, i) => buf[i] === b)) return false;
  let offset = 8;
  let sawIend = false;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) return false; // truncated chunk header
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (offset + 8 + len + 4 > buf.length) return false; // truncated chunk data/CRC
    const data = buf.subarray(offset + 8, offset + 8 + len);
    const crcExpected = buf.readUInt32BE(offset + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== crcExpected) return false;
    if (type === 'IEND') sawIend = true;
    offset += 8 + len + 4;
  }
  return sawIend && offset === buf.length;
}

/**
 * Verifies the SOI...EOI markers frame the whole file. This doesn't fully
 * parse JPEG segments (DQT/DHT/SOF/SOS have no simple checksum to lean on the
 * way PNG chunks do), but it does catch truncation and drift at the tail —
 * the same "header survived, body didn't" pattern PNG's check targets.
 */
function isValidJpeg(buf) {
  if (buf.length < 4) return false;
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return false;
  return buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

/** Verifies the GIF87a/GIF89a header and the trailer byte (0x3B) required at end-of-file. */
function isValidGif(buf) {
  const isGif87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61].every((b, i) => buf[i] === b);
  const isGif89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61].every((b, i) => buf[i] === b);
  if (!isGif87 && !isGif89) return false;
  return buf.length > 0 && buf[buf.length - 1] === 0x3b;
}

/** Verifies the RIFF/WEBP header and that the RIFF-declared size matches the actual buffer length. */
function isValidWebp(buf) {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  return buf.readUInt32LE(4) === buf.length - 8;
}

/** Verifies the %PDF header and a trailing %%EOF marker (allowing trailing whitespace). */
function isValidPdf(buf) {
  if (buf.toString('ascii', 0, 4) !== '%PDF') return false;
  const tail = buf.subarray(Math.max(0, buf.length - 32)).toString('latin1');
  return /%%EOF\s*$/.test(tail);
}

// Structural integrity validators for the attachment types most likely to be
// sent through this tool. Used to catch corrupted or mistyped base64 (e.g. a
// model reconstructing file bytes as text token-by-token rather than reading
// the real file) before Postmark accepts the send as a "success" — unlike a
// bare magic-byte check, these also verify enough of the body/tail to catch
// corruption that leaves a valid-looking header in place.
export const ATTACHMENT_STRUCTURE_VALIDATORS = {
  'image/png': isValidPng,
  'image/jpeg': isValidJpeg,
  'image/gif': isValidGif,
  'image/webp': isValidWebp,
  'application/pdf': isValidPdf,
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
    `Each attachment's base64 content is validated (well-formed encoding, size, and for common image/PDF types a full structural integrity check — not just a header check — since a corrupted middle/end with an intact header would otherwise slip through) before anything is sent — a failed validation means nothing was sent, so it's always safe to retry with corrected data.`
  );

/**
 * Validates one attachment — file extension, base64 well-formedness, size,
 * and (for common types) structural integrity — and returns the Postmark
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

  const structureCheck = ATTACHMENT_STRUCTURE_VALIDATORS[att.contentType?.toLowerCase()];
  if (structureCheck && !structureCheck(decoded)) {
    throw new Error(`${label} ("${att.name}"): decoded content fails structural validation for ${att.contentType} — wrong header, truncated, or a corrupted body (this checks more than just the file signature). The data is likely corrupted or mislabeled — re-encode the original file rather than resending as-is.`);
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
