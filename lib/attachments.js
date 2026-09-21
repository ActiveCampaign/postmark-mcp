/**
 * @file lib/attachments.js
 * @description Attachment handling for the Postmark MCP server — reading files
 * from disk by `path`, base64 well-formedness, per-type structural integrity
 * checks, forbidden-extension checks, and Postmark's documented size limits.
 *
 * Pulled out of index.js (mirroring lib/log.js) so this logic can be
 * unit-tested directly with plain values, instead of only reachable by
 * driving the full MCP server over stdio — which matters here because the
 * size-limit checks are only meaningfully exercised with multi-megabyte
 * payloads; routing that through a real stdio round-trip is orders of
 * magnitude slower than calling the functions directly.
 */

import { z } from 'zod';
import { readFileSync, statSync, realpathSync } from 'fs';
import { resolve, basename, relative, isAbsolute, extname } from 'path';

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

// Extension -> MIME type, used to infer contentType when an attachment is
// supplied by `path`. Deliberately small: covers what actually gets emailed.
// Anything unlisted falls back to application/octet-stream, which simply means
// the structural-integrity check is skipped (there's no validator for it).
const EXTENSION_MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  html: 'text/html', htm: 'text/html', json: 'application/json', xml: 'application/xml',
  ics: 'text/calendar', zip: 'application/zip', gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};

// Path prefixes that indicate the caller is an agent running in its own
// container, where uploaded files live on a filesystem this server cannot see.
// Used only to produce a better error message — never to allow or deny a read.
const SANDBOX_PATH_PREFIXES = ['/mnt/user-data/', '/mnt/data/', '/mnt/outputs/', '/mnt/skills/', '/home/claude/'];

/**
 * Resolves an attachment `path` to an absolute real path, enforcing the
 * optional POSTMARK_ATTACHMENT_DIR allowlist.
 *
 * Reading a local file and emailing it outbound is an exfiltration path if the
 * filename ever comes from untrusted content rather than the user (e.g. "attach
 * ~/.ssh/id_rsa"). Setting POSTMARK_ATTACHMENT_DIR confines reads to one
 * directory; leaving it unset preserves the obvious behaviour for the common
 * case where the operator trusts their own machine. Both sides are resolved
 * through realpath so a symlink inside the allowed directory can't escape it.
 */
export function resolveAttachmentPath(inputPath) {
  let resolved;
  try {
    resolved = realpathSync(resolve(inputPath));
  } catch {
    // A caller running in its own execution sandbox (agent containers mount
    // uploads under paths like /mnt/user-data/) sees a filesystem that is NOT
    // the one this server reads. Naming that explicitly turns an opaque
    // "file not found" into an actionable diagnosis, since the file really
    // does exist — just not anywhere this process can reach.
    if (SANDBOX_PATH_PREFIXES.some(p => inputPath.startsWith(p))) {
      throw new Error(`"${inputPath}" looks like a path inside your own execution sandbox, which is a different filesystem from the one this MCP server reads. This server runs as a local process on the user's machine (its working directory is "${process.cwd()}") and can only open files that exist there. A file uploaded into the conversation is not on that machine. Ask the user for the file's path on their own machine, or to save a copy there — and do not fall back to pasting base64 into \`content\`, which truncates for anything of real size.`);
    }
    throw new Error(`no file exists at "${inputPath}" — this server reads files from the machine it runs on (working directory "${process.cwd()}"), so the path must be valid there. Check the path, or ask the user for the correct one. If the file was pasted or uploaded into the chat rather than saved to disk, it has no path on that machine: ask the user to save it to a file first.`);
  }

  const allowedDir = process.env.POSTMARK_ATTACHMENT_DIR;
  if (allowedDir) {
    let allowedReal;
    try {
      allowedReal = realpathSync(resolve(allowedDir));
    } catch {
      throw new Error(`POSTMARK_ATTACHMENT_DIR is set to "${allowedDir}", but that directory does not exist — fix the server configuration.`);
    }
    const rel = relative(allowedReal, resolved);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`"${inputPath}" is outside POSTMARK_ATTACHMENT_DIR ("${allowedReal}"), which this server is configured to restrict attachment reads to. Move the file into that directory, or ask the user to change the server configuration.`);
    }
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    throw new Error(`"${inputPath}" could not be read (${err.code || err.message}) — check the file's permissions`);
  }
  if (!stat.isFile()) {
    throw new Error(`"${inputPath}" is not a regular file`);
  }
  // Base64 inflates by 4/3, so check before reading — this keeps a
  // multi-gigabyte file from being pulled into memory just to be rejected.
  const projectedBase64 = Math.ceil(stat.size / 3) * 4;
  if (projectedBase64 > POSTMARK_MAX_MESSAGE_BYTES) {
    throw new Error(`"${inputPath}" is ${fmtBytes(stat.size)} on disk, which becomes ${fmtBytes(projectedBase64)} once base64-encoded — over Postmark's 10 MB total message limit. Compress or resize the file before attaching.`);
  }

  return resolved;
}

/** Formats a byte count for error messages, e.g. 8912896 -> "8.5 MB". */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)} ${units[i]}`;
}

export const attachmentSchema = z.object({
  path: z.string().min(1).optional().describe("PREFERRED. Filesystem path to the file, e.g. \"/Users/me/Downloads/logo.png\" or \"./invoice.pdf\". The server reads the bytes itself, so `name` and `contentType` are inferred and `content` must be omitted. Always use this instead of `content` when the file exists on disk — it is the only reliable way to attach anything more than a few KB."),
  content: z.string().min(1).optional().describe("Base64-encoded file content. Use ONLY when the file is not on disk and the base64 is already available verbatim — never re-type, reconstruct, or transcribe base64 to fill this field, and never use it for a file you have only seen as an image. Prefer `path`."),
  name: z.string().min(1).optional().describe("Filename including extension, e.g. \"invoice.pdf\". Required with `content`; defaults to the basename when using `path`. Files with a forbidden extension (executables, scripts, and similar — see attachments field description) are always rejected."),
  contentType: z.string().min(1).optional().describe("MIME type, e.g. \"image/png\", \"application/pdf\". Required with `content`; inferred from the file extension when using `path`."),
  contentId: z.string().optional().describe("Optional Content ID — reference as cid:<contentId> inside htmlBody to render inline instead of as a downloadable file. Must be unique within the message.")
}).superRefine((att, ctx) => {
  if (att.path && att.content) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide either `path` or `content`, not both' });
    return;
  }
  if (!att.path && !att.content) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an attachment needs either `path` (preferred — the server reads the file) or `content` (base64)' });
    return;
  }
  if (att.content) {
    if (!att.name) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: '`name` is required when using `content` (it is inferred only when using `path`)' });
    if (!att.contentType) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: '`contentType` is required when using `content` (it is inferred only when using `path`). If this field went missing because the tool call was cut short while writing a long `content` string, use `path` instead.' });
  }
});

export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional()
  .describe(
    `Optional file attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message — this tool's own conservative default, not a Postmark limit). ` +
    `Specify each attachment by \`path\` whenever the file exists on disk: the server reads the bytes itself, so you emit a short path instead of a huge base64 string. ` +
    `Do NOT put a file's base64 into \`content\` by transcribing, reconstructing, or reading it out of an image you were shown — that produces truncated or invented data and the send will be rejected. ` +
    `If a user attached a file to the conversation rather than saving it, there is no way to read its bytes: ask them to save it to disk and give you the path. ` +
    `Postmark's real limits: total message size (body + attachments combined, measured after base64 encoding) must stay under 10 MB, and these file extensions are always rejected regardless of content: ${[...FORBIDDEN_ATTACHMENT_EXTENSIONS].sort().join(', ')}. ` +
    `A full-resolution photo from a modern phone camera is often 3-8 MB by itself — compress or resize large images before attaching rather than sending the original. ` +
    `Every attachment is validated (well-formed encoding, size, and for common image/PDF types a full structural integrity check — not just a header check — since a corrupted middle/end with an intact header would otherwise slip through) before anything is sent — a failed validation means nothing was sent, so it's always safe to retry with corrected data.`
  );

/**
 * Validates one attachment and returns the Postmark Attachments entry shape
 * ({ Name, Content, ContentType, ContentID }). Handles both input modes: with
 * `path` the file is read from disk here (inferring Name/ContentType), with
 * `content` the caller-supplied base64 is validated for well-formedness. Both
 * modes then go through the extension, size, and structural-integrity checks.
 * Throws a descriptive Error rather than silently passing through malformed,
 * corrupted, or oversized data. `label` identifies the attachment in error
 * messages, e.g. "attachments[0]".
 */
export function validateAttachment(att, label) {
  // Retrying a failed base64 send by emitting base64 again fails identically,
  // so every message below points at `path` as the actual recovery.
  const USE_PATH = 'Do NOT retry by sending base64 again — it will fail the same way. Use the `path` field instead so the server reads the file from disk. If the file is not on disk (e.g. the user attached it to the conversation), ask them to save it somewhere and give you the path.';

  let name = att.name;
  let contentType = att.contentType;
  let stripped;
  const fromPath = Boolean(att.path);

  if (fromPath) {
    let resolved;
    try {
      resolved = resolveAttachmentPath(att.path);
    } catch (err) {
      throw new Error(`${label}: ${err.message}`);
    }
    name ||= basename(resolved);
    if (!contentType) {
      const ext = extname(resolved).slice(1).toLowerCase();
      contentType = EXTENSION_MIME_TYPES[ext] || 'application/octet-stream';
    }
    // Bytes come straight off disk, so the base64 below is well-formed by
    // construction — the format checks are skipped, but size and structural
    // integrity still apply (the file on disk could itself be corrupt).
    // Guarded because the file can become unreadable between resolution and
    // read (permissions, deletion); a raw errno here would lose the label.
    try {
      stripped = readFileSync(resolved).toString('base64');
    } catch (err) {
      throw new Error(`${label}: failed to read "${att.path}" (${err.code || err.message})`);
    }
  } else {
    stripped = att.content.replace(/\s+/g, '');
  }

  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  if (FORBIDDEN_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new Error(`${label} ("${name}"): the ".${ext}" file extension is on Postmark's forbidden attachment list and is always rejected, regardless of content — see https://postmarkapp.com/developer/user-guide/send-email-with-api/send-a-single-email`);
  }

  if (!fromPath) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
      throw new Error(`${label} ("${name}"): content is not valid base64 — it contains characters outside the base64 alphabet. ${USE_PATH}`);
    }
    if (stripped.length % 4 !== 0) {
      throw new Error(`${label} ("${name}"): base64 content is incomplete — ${stripped.length} characters, which is not a multiple of 4, meaning it was cut off before it finished. This is the usual result of writing a long base64 string directly into a tool call and running past the output limit. ${USE_PATH}`);
    }
  }

  if (stripped.length > POSTMARK_MAX_MESSAGE_BYTES) {
    throw new Error(`${label} ("${name}"): base64 content is ${fmtBytes(stripped.length)} on its own, which already exceeds Postmark's 10 MB total message size limit. Compress or resize the file before attaching.`);
  }

  const decoded = Buffer.from(stripped, 'base64');
  if (decoded.length === 0) {
    throw new Error(`${label} ("${name}"): content decoded to 0 bytes${fromPath ? ' — the file on disk is empty' : `. ${USE_PATH}`}`);
  }
  // Buffer.from() silently drops invalid runs rather than throwing, so a
  // round-trip re-encode is what actually catches malformed/truncated base64.
  if (!fromPath && decoded.toString('base64').replace(/=+$/, '') !== stripped.replace(/=+$/, '')) {
    throw new Error(`${label} ("${name}"): content does not round-trip as valid base64 — it was truncated or corrupted before reaching this tool. ${USE_PATH}`);
  }

  const structureCheck = ATTACHMENT_STRUCTURE_VALIDATORS[contentType?.toLowerCase()];
  if (structureCheck && !structureCheck(decoded)) {
    throw new Error(
      `${label} ("${name}"): decoded content fails structural validation for ${contentType} — wrong header, truncated, or a corrupted body (this checks more than just the file signature). ` +
      (fromPath
        ? `The file at "${att.path}" appears to be corrupt or is not actually a ${contentType} file. Check the file opens correctly, or correct its extension.`
        : `The data was corrupted or reconstructed rather than copied. ${USE_PATH}`)
    );
  }

  return { Name: name, Content: stripped, ContentType: contentType, ...(att.contentId && { ContentID: att.contentId }) };
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
