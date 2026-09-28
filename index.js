#!/usr/bin/env node
/**
 * @file Postmark MCP Server
 * @description Official Postmark MCP server for sending emails via Claude and AI assistants
 * @author Jabal Torres
 * @version 1.0.0
 * @license MIT
 */

import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from "zod";
import { createRequire } from 'module';
import { createLogger } from './lib/log.js';

const require = createRequire(import.meta.url);
const { version: clientVersion } = require('./package.json');
const POSTMARK_API_BASE = 'https://api.postmarkapp.com';
const REQUEST_TIMEOUT_MS = 60_000;
// Page size for the internal server-token resolver's /servers walk. Set to the API
// maximum for the fewest round trips; the listServers tool defaults to 100 for
// readable output, which is a separate concern.
const SERVERS_PAGE_SIZE = 500;

const serverToken = process.env.POSTMARK_SERVER_TOKEN;
const defaultSender = process.env.DEFAULT_SENDER_EMAIL;
const defaultMessageStream = process.env.DEFAULT_MESSAGE_STREAM;
const agentLabel = process.env.AGENT_LABEL || null;

// Account mode is opt-in. When POSTMARK_ACCOUNT_TOKEN is set the server can reach
// account-level endpoints (servers, domains, sender signatures) and route any
// server-scoped tool at a chosen server via the optional `server` argument. When
// it is unset the server behaves exactly as before: server-scoped only, no `server`
// argument, no account tools.
const accountToken = process.env.POSTMARK_ACCOUNT_TOKEN || null;

// Name or numeric id of the server whose token backs server-scoped tools when no
// `server` argument is given. Only consulted in account mode; not a secret.
const defaultServerRef = process.env.POSTMARK_DEFAULT_SERVER || null;

// Token used for server-scoped tools when no `server` argument is given. Seeded
// from POSTMARK_SERVER_TOKEN and, in account mode, resolved from POSTMARK_DEFAULT_SERVER
// at startup.
let defaultServerToken = serverToken || null;

// Per-invocation server-token override, set by the tool wrapper and read by
// postmarkRequest. AsyncLocalStorage keeps concurrent tool calls isolated: a
// module-level variable would let parallel calls clobber each other's target server.
const requestContext = new AsyncLocalStorage();

// Optional `server` argument spread into every server-scoped tool schema in account
// mode. Empty otherwise, so server-only mode keeps its original schemas verbatim.
const SERVER_SCOPE = accountToken
  ? { server: z.union([z.number().int(), z.string()]).optional().describe("Target server by numeric ID or exact name (account mode; defaults to POSTMARK_DEFAULT_SERVER)") }
  : {};

// Populated from the MCP initialize handshake once the client connects.
let mcpClient = null; // { name: string, version: string|null }
const logFile = process.env.LOG_FILE || null;
const logEmailFull = process.env.LOG_EMAIL_FULL === 'true';

// Optional comma-separated list of allowed webhook URL origins/prefixes, e.g.
// WEBHOOK_URL_ALLOWLIST=https://hooks.example.com,https://inbound.myapp.io
// When set, createWebhook rejects URLs whose parsed origin+path don't match an entry.
const webhookAllowlist = process.env.WEBHOOK_URL_ALLOWLIST
  ? process.env.WEBHOOK_URL_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)
  : null;

if (webhookAllowlist !== null && webhookAllowlist.length === 0) {
  console.error('[WARN] WEBHOOK_URL_ALLOWLIST is set but parsed to an empty list — all webhook URLs will be rejected. Check for stray whitespace or commas.');
}

/**
 * Checks whether a webhook URL is permitted by the allowlist.
 * Matches on parsed origin + pathname prefix to prevent raw-string bypasses
 * such as userinfo injection (https://allowed.host@evil.test/) or subdomain
 * suffix spoofing (https://allowed.host.evil.test/).
 * Returns true when no allowlist is configured (allow-all).
 */
function isAllowedWebhookUrl(url, allowlist) {
  if (!allowlist) return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  // Reject embedded credentials — userinfo can be used to spoof host matching.
  if (u.username || u.password) return false;
  return allowlist.some(entry => {
    let a;
    try { a = new URL(entry); } catch { return false; }
    return u.origin === a.origin && u.pathname.startsWith(a.pathname);
  });
}

// MCP tool annotation presets (https://modelcontextprotocol.io/docs/concepts/tools)
// Clients use these hints to decide whether to prompt for confirmation before invoking.
const READ_ONLY  = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true };
const MUTATING   = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true };

// Selects the Postmark auth header for a request. Account-level calls pass
// auth: 'account'; server-scoped calls resolve their token from the active
// request context (set per tool invocation) and fall back to the default.
function authHeader(auth) {
  if (auth === 'account') {
    if (!accountToken) throw new Error('This operation requires POSTMARK_ACCOUNT_TOKEN to be set.');
    return { 'X-Postmark-Account-Token': accountToken };
  }
  const token = requestContext.getStore()?.serverToken ?? defaultServerToken;
  if (!token) {
    throw new Error(
      'No server token available for this request. Pass a `server` argument, ' +
      'or set POSTMARK_DEFAULT_SERVER (account mode) or POSTMARK_SERVER_TOKEN.'
    );
  }
  return { 'X-Postmark-Server-Token': token };
}

// Lazily populated id -> { name, token } map of the account's servers, built from
// the account-scoped /servers endpoint. Only used in account mode.
const serverCache = new Map();

/** Fetches every server via the account token and rebuilds the id -> {name, token} cache. */
async function loadServers() {
  serverCache.clear();
  for (let offset = 0; ; offset += SERVERS_PAGE_SIZE) {
    const page = await postmarkRequest(`/servers${qs({ count: SERVERS_PAGE_SIZE, offset })}`, { auth: 'account' });
    for (const s of page.Servers ?? []) {
      serverCache.set(s.ID, { name: s.Name, token: s.ApiTokens?.[0] ?? null });
    }
    if (!page.TotalCount || offset + SERVERS_PAGE_SIZE >= page.TotalCount) break;
  }
  return serverCache;
}

/** Drops the cached server map so the next resolution refetches. */
function invalidateServerCache() {
  serverCache.clear();
}

/**
 * Resolves a server reference to that server's API token, populating the cache on
 * first use and refetching once on a miss to pick up servers created out of band.
 * A number, or a string of only digits, is treated as an ID; any other string is
 * matched against server names. A server whose name is all digits is therefore only
 * reachable by its ID. Returns null when ref is empty so callers fall back to the
 * default token.
 */
async function resolveServerToken(ref) {
  if (ref === undefined || ref === null || ref === '') return null;

  const lookup = () => {
    if (typeof ref === 'number' || /^\d+$/.test(ref)) {
      const byId = serverCache.get(Number(ref));
      if (byId) return byId;
    }
    for (const entry of serverCache.values()) {
      if (entry.name === ref) return entry;
    }
    return null;
  };

  if (serverCache.size === 0) await loadServers();
  let entry = lookup();
  if (!entry) { await loadServers(); entry = lookup(); }

  if (!entry) throw new Error(`No server found matching "${ref}". Use listServers to see available servers by name and ID.`);
  if (!entry.token) throw new Error(`Server "${ref}" has no API token available to the account token.`);
  return entry.token;
}

/**
 * Minimal hardened HTTP client for the Postmark REST API over native fetch.
 * Stamps client identity headers, enforces a request timeout,
 * and maps non-2xx responses to Error objects that surface Postmark's
 * Message / ErrorCode. Returns parsed JSON (or null for empty 2xx bodies).
 */
async function postmarkRequest(path, options = {}) {
  // All internal callers pass a literal path starting with '/'. The absolute-URL
  // branch is kept for flexibility, but anything else is a programming error and
  // would be an SSRF footgun if user-influenced input ever reached this parameter.
  if (!path.startsWith('/') && !path.startsWith('http')) {
    throw new Error(`postmarkRequest: path must start with '/' or 'http', got: ${path}`);
  }
  const { auth, ...fetchOptions } = options;
  const url = path.startsWith('http') ? path : `${POSTMARK_API_BASE}${path}`;
  const headers = {
    Accept: 'application/json',
    ...authHeader(auth),
    'X-Postmark-Client': 'postmark-mcp',
    'X-Postmark-Client-Version': clientVersion,
    ...(mcpClient?.name && { 'X-Postmark-MCP-Client': [mcpClient.name, mcpClient.version].filter(Boolean).join('/') }),
    ...(agentLabel && { 'X-Agent-Label': agentLabel }),
    ...fetchOptions.headers,
  };
  if (fetchOptions.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Postmark request timed out after ${REQUEST_TIMEOUT_MS/1000}s: ${path}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = res.statusText, code;
    try { const d = JSON.parse(text); if (d.Message) message = d.Message; if (d.ErrorCode != null) code = d.ErrorCode; } catch {}
    throw new Error(`Postmark API ${res.status}${code != null ? ` (ErrorCode ${code})` : ''}: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Build a query string from a params object, skipping undefined/null/empty values. */
function qs(params) {
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return q ? `?${q}` : '';
}

// Initialize Postmark client and MCP server
async function initializeServices() {
  try {
    if (!serverToken && !accountToken) {
      console.error('[ERROR] Neither POSTMARK_SERVER_TOKEN nor POSTMARK_ACCOUNT_TOKEN is set.');
      console.error('  → Server Token (single server): https://account.postmarkapp.com → your server → API Tokens tab');
      console.error('  → Account Token (account mode, all servers + account tools): https://account.postmarkapp.com → API Tokens tab');
      console.error('  → Set one in your .env file or pass it via the env block in your MCP client config.');
      process.exit(1);
    }

    if (accountToken && !serverToken && !defaultServerRef) {
      console.error('[WARN] Account mode is active with no default server (POSTMARK_SERVER_TOKEN or POSTMARK_DEFAULT_SERVER unset).');
      console.error('  → Account tools work; server-scoped tools require an explicit `server` argument until a default is set.');
    }

    if (!defaultSender) {
      console.error('[ERROR] DEFAULT_SENDER_EMAIL is not set.');
      console.error('  → This must be an email address with a verified Sender Signature in Postmark.');
      console.error('  → Manage sender signatures at: https://account.postmarkapp.com/signature_domains');
      process.exit(1);
    }

    if (!defaultMessageStream) {
      console.error('[ERROR] DEFAULT_MESSAGE_STREAM is not set.');
      console.error('  → Set this to your outbound message stream ID (typically "outbound").');
      console.error('  → View streams at: https://account.postmarkapp.com → your server → Message Streams');
      process.exit(1);
    }

    console.error('Initializing Postmark MCP server..');
    console.error('Default sender: ', defaultSender);
    console.error('Message stream: ', defaultMessageStream);
    if (agentLabel) console.error('Agent label: ', agentLabel);

    if (accountToken) console.error('Account mode: enabled');

    // Verify connectivity + token with a test API call. In account mode this also
    // resolves POSTMARK_DEFAULT_SERVER into the fallback server token; that lookup
    // needs the account, so it only happens here, not under POSTMARK_SKIP_VERIFY.
    // Set POSTMARK_SKIP_VERIFY=true to bypass the check (e.g. in offline tests).
    if (process.env.POSTMARK_SKIP_VERIFY === 'true') {
      if (serverToken !== 'POSTMARK_API_TEST') {
        console.error('[WARN] POSTMARK_SKIP_VERIFY is enabled with a real token. Startup token verification is skipped; do not use this in production.');
      }
    } else {
      if (accountToken) {
        await postmarkRequest(`/servers${qs({ count: 1, offset: 0 })}`, { auth: 'account' });
        if (!defaultServerToken && defaultServerRef) {
          defaultServerToken = await resolveServerToken(defaultServerRef);
          console.error('Default server resolved: ', defaultServerRef);
        }
      }
      if (defaultServerToken) await postmarkRequest('/server');
    }

    const mcpServer = new McpServer({
      name: "postmark-mcp",
      version: clientVersion
    });

    return { mcpServer };
  } catch (error) {
    const msg = error.message || '';
    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.includes('ErrorCode 10')) {
      throw new Error(
        `Initialization failed: Postmark rejected a token (401 Unauthorized).\n` +
        `  → POSTMARK_SERVER_TOKEN must be a Server Token; POSTMARK_ACCOUNT_TOKEN must be an Account Token. They are not interchangeable.\n` +
        `  → Server tokens: https://account.postmarkapp.com → your server → API Tokens tab\n` +
        `  → Account token: https://account.postmarkapp.com → API Tokens tab`
      );
    }
    if (error.cause?.code === 'ENOTFOUND' || msg.includes('fetch failed') || msg.includes('ENOTFOUND')) {
      throw new Error(
        `Initialization failed: Could not reach the Postmark API (${msg}).\n` +
        `  → Check your internet connection and that https://api.postmarkapp.com is reachable.`
      );
    }
    throw new Error(`Initialization failed: ${error.code ? `${error.code} - ` : ''}${msg || 'An unexpected error occurred'}`);
  }
}

// Start the server
async function main() {
  try {
    const { mcpServer: server } = await initializeServices();

    registerTools(server);

    console.error('Connecting to MCP transport..');
    const transport = new StdioServerTransport();

    // Capture MCP client identity from the initialize handshake.
    // The SDK fires oninitialized after the client sends its `initialized` notification.
    server.server.oninitialized = () => {
      const cv = server.server.getClientVersion();
      if (cv?.name) {
        mcpClient = { name: cv.name, version: cv.version || null };
        console.error('MCP client identified:', cv.name, cv.version || '');
      }
    };

    await server.connect(transport);

    console.error('Postmark MCP server is running and ready!');
    console.error('Available tools (24): sendEmail, sendEmailWithTemplate, sendBatch, sendBatchWithTemplate, ' +
      'listTemplates, getTemplate, createTemplate, editTemplate, deleteTemplate, validateTemplate, ' +
      'searchOutboundMessages, getMessageDetails, diagnoseDelivery, ' +
      'searchBounces, getBounceDump, activateBounce, ' +
      'listSuppressions, createSuppressions, deleteSuppressions, ' +
      'getDeliveryStats, getServerInfo, ' +
      'listWebhooks, createWebhook, deleteWebhook');
    if (accountToken) {
      console.error('Account tools (15): listServers, createServer, editServer, deleteServer, ' +
        'listDomains, getDomain, createDomain, verifyDomainDkim, verifyDomainReturnPath, deleteDomain, ' +
        'listSenders, getSender, createSender, resendSenderConfirmation, deleteSender');
    }

    process.on('SIGTERM', () => handleShutdown(server));
    process.on('SIGINT', () => handleShutdown(server));
  } catch (error) {
    console.error('Server initialization failed: ', error.message);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function handleShutdown(server) {
  console.error('Shutting down server..');

  try {
    await server.close();
    console.error('Server shutdown complete. Bye! 👋');
    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Shutdown: ', error.message);
    process.exit(1);
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception: ', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection: ', reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

// ───── Formatting helpers ─────

const fmtInt = n => (n ?? 0).toLocaleString('en-US');

const fmtPct = (numerator, denominator) => {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
};

// Render { Desktop, Mobile, WebMail, Unknown } breakdown with percentages
const fmtPlatformUsage = (data) => {
  const buckets = ['Desktop', 'Mobile', 'WebMail', 'Unknown'];
  const total = buckets.reduce((sum, k) => sum + (data[k] || 0), 0);
  if (total === 0) return '  (no data in range)';
  return buckets
    .map(k => `  ${k.padEnd(8)} ${fmtInt(data[k] || 0).padStart(8)}  (${fmtPct(data[k] || 0, total)})`)
    .join('\n');
};

// Render top-N { name: count } breakdown sorted descending. Skips `Days`.
const fmtTopBreakdown = (data, limit = 10) => {
  const entries = Object.entries(data)
    .filter(([k, v]) => k !== 'Days' && typeof v === 'number')
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (no data in range)';
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const shown = entries.slice(0, limit);
  const lines = shown.map(([k, v]) =>
    `  ${k.padEnd(20)} ${fmtInt(v).padStart(8)}  (${fmtPct(v, total)})`
  );
  if (entries.length > limit) {
    lines.push(`  ${`… and ${entries.length - limit} more`}`);
  }
  return lines.join('\n');
};

// Render delivery summary (default behavior of getDeliveryStats — v1 compatible)
const fmtDeliverySummary = (d, { fromDate, toDate, tag, messageStream } = {}) => {
  const sent = d.Sent || 0;
  const tracked = d.Tracked || 0;
  const bounced = d.Bounced || 0;
  const spam = d.SpamComplaints || 0;
  const uniqueOpens = d.UniqueOpens || 0;
  const totalLinks = d.TotalTrackedLinksSent || 0;
  const uniqueClicks = d.UniqueLinksClicked || 0;

  const lines = [
    'Email Delivery Summary',
    '',
    `Sent:        ${fmtInt(sent)}`,
    `Tracked:     ${fmtInt(tracked)}  (${fmtPct(tracked, sent)} of sent)`,
    `Open rate:   ${fmtPct(uniqueOpens, tracked)}  (${fmtInt(uniqueOpens)}/${fmtInt(tracked)} unique opens)`,
    `Click rate:  ${fmtPct(uniqueClicks, totalLinks)}  (${fmtInt(uniqueClicks)}/${fmtInt(totalLinks)} unique links clicked)`,
    `Bounced:     ${fmtInt(bounced)}  (${fmtPct(bounced, sent)})`,
    `Spam:        ${fmtInt(spam)}  (${fmtPct(spam, sent)})`,
  ];

  const filters = [];
  if (fromDate || toDate) filters.push(`Period: ${fromDate || 'start'} → ${toDate || 'now'}`);
  if (tag) filters.push(`Tag: ${tag}`);
  if (messageStream) filters.push(`Stream: ${messageStream}`);
  if (filters.length) {
    lines.push('');
    lines.push(...filters);
  }

  return lines.join('\n');
};

// Format any of the per-stat responses returned by getDeliveryStats
const fmtStatResponse = (stat, d) => {
  switch (stat) {
    case 'overview':
      return [
        'Outbound Overview',
        '',
        `Sent:                ${fmtInt(d.Sent)}`,
        `Bounced:             ${fmtInt(d.Bounced)}  (${(d.BounceRate ?? 0).toFixed(2)}%)`,
        `SMTP API errors:     ${fmtInt(d.SMTPApiErrors)}`,
        `Spam complaints:     ${fmtInt(d.SpamComplaints)}  (${(d.SpamComplaintsRate ?? 0).toFixed(2)}%)`,
        `Tracked:             ${fmtInt(d.Tracked)}`,
        `Opens (total):       ${fmtInt(d.Opens)}`,
        `Opens (unique):      ${fmtInt(d.UniqueOpens)}`,
        `Tracked links sent:  ${fmtInt(d.TotalTrackedLinksSent)}`,
        `Total clicks:        ${fmtInt(d.TotalClicks)}`,
        `Unique link clicks:  ${fmtInt(d.UniqueLinksClicked)}`,
        `With open tracking:  ${fmtInt(d.WithOpenTracking)}`,
        `With link tracking:  ${fmtInt(d.WithLinkTracking)}`,
      ].join('\n');

    case 'sent':
      return `Sent\n\n  Total: ${fmtInt(d.Sent)}`;

    case 'bounces': {
      const typeEntries = Object.entries(d)
        .filter(([k, v]) => k !== 'Days' && k !== 'Total' && typeof v === 'number' && v > 0)
        .sort((a, b) => b[1] - a[1]);
      const total = typeEntries.reduce((sum, [, v]) => sum + v, 0);
      if (total === 0) return 'Bounces\n\n  (no bounces in range)';
      const types = typeEntries
        .map(([k, v]) => `  ${k.padEnd(24)} ${fmtInt(v).padStart(8)}  (${fmtPct(v, total)})`)
        .join('\n');
      return `Bounces\n\n  Total: ${fmtInt(total)}\n\n${types}`;
    }

    case 'spam':
      return `Spam Complaints\n\n  Total: ${fmtInt(d.SpamComplaint)}`;

    case 'tracked':
      return `Tracked Emails\n\n  Total: ${fmtInt(d.Tracked)}`;

    case 'opens':
      return [
        'Email Opens',
        '',
        `  Total opens:    ${fmtInt(d.Opens)}`,
        `  Unique opens:   ${fmtInt(d.Unique)}`,
      ].join('\n');

    case 'openPlatforms':
      return `Open Platform Usage\n\n${fmtPlatformUsage(d)}`;

    case 'openClients':
      return `Email Client Usage (top 10)\n\n${fmtTopBreakdown(d)}`;

    case 'openReadTimes':
      return `Open Read Times\n\n${fmtTopBreakdown(d)}`;

    case 'clicks':
      return [
        'Link Clicks',
        '',
        `  Total clicks:   ${fmtInt(d.Clicks)}`,
        `  Unique clicks:  ${fmtInt(d.Unique)}`,
      ].join('\n');

    case 'clickBrowsers':
      return `Click Browser Usage (top 10)\n\n${fmtTopBreakdown(d)}`;

    case 'clickPlatforms':
      return `Click Platform Usage\n\n${fmtPlatformUsage(d)}`;

    case 'clickLocation': {
      const html = d.HTML || 0;
      const text = d.Text || 0;
      const total = html + text;
      return [
        'Click Location',
        '',
        `  HTML:  ${fmtInt(html).padStart(8)}  (${fmtPct(html, total)})`,
        `  Text:  ${fmtInt(text).padStart(8)}  (${fmtPct(text, total)})`,
      ].join('\n');
    }

    default:
      return JSON.stringify(d, null, 2);
  }
};

// ───── Structured logging ──────────────────────────────────────────────────

const { maskEmail, sanitizeArgs, writeLog } = createLogger({ emailFull: logEmailFull, logFile });

// Tool registration
function registerTools(server) {
  // Transparently wrap every server.tool() call with structured logging.
  // The original handler is replaced with one that emits a JSON log line on
  // completion (or error), with sanitized args so no sensitive content leaks.
  const _tool = server.tool.bind(server);

  // Wraps a handler with structured logging. `resolveServer` is true for
  // server-scoped tools: in account mode the wrapper resolves the per-call target
  // server from the `server` argument and runs the handler inside a context
  // postmarkRequest reads. Account tools pass false and authenticate themselves.
  function logged(name, handler, resolveServer) {
    return async (args) => {
      const start = Date.now();
      const base = {
        timestamp: new Date().toISOString(),
        tool: name,
        clientName: mcpClient?.name ?? null,
        clientVersion: mcpClient?.version ?? null,
        args: sanitizeArgs(args),
      };
      try {
        const token = resolveServer && accountToken ? await resolveServerToken(args?.server) : null;
        const result = token
          ? await requestContext.run({ serverToken: token }, () => handler(args))
          : await handler(args);
        writeLog({ ...base, status: 'ok', durationMs: Date.now() - start });
        return result;
      } catch (err) {
        writeLog({ ...base, status: 'error', error: err.message, durationMs: Date.now() - start });
        throw err;
      }
    };
  }

  // Server-scoped tools. In account mode the optional `server` argument is spread
  // into each schema (SERVER_SCOPE) and the wrapper routes the call to that server.
  server.tool = (name, description, schema, annotations, handler) => {
    return _tool(name, description, { ...SERVER_SCOPE, ...schema }, annotations, logged(name, handler, true));
  };

  // Account-scoped tools (servers, domains, senders). Registered only in account
  // mode; they carry no `server` argument and authenticate with the account token.
  const accountTool = (name, description, schema, annotations, handler) =>
    _tool(name, description, schema, annotations, logged(name, handler, false));

  // ─────────────── Email ───────────────

  server.tool(
    "sendEmail",
    "Send a single transactional email via Postmark. Accepts one recipient or an array of up to 50. The From address must be a verified sender signature. Open and link tracking are enabled automatically. Use sendBatch to send multiple distinct messages in one call.",
    {
      to: z.union([
        z.string().email(),
        z.array(z.string().email()).min(1).max(50),
      ]).describe("Recipient email address, or an array of up to 50 addresses"),
      subject: z.string().describe("Email subject"),
      textBody: z.string().describe("Plain text body of the email"),
      htmlBody: z.string().optional().describe("HTML body of the email (optional)"),
      from: z.string().email().optional().describe("Sender email address (optional, uses default if not provided)"),
      cc: z.string().optional().describe("CC recipient(s), comma-separated (optional)"),
      bcc: z.string().optional().describe("BCC recipient(s), comma-separated (optional)"),
      replyTo: z.string().email().optional().describe("Reply-To address (optional)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    MUTATING,
    async ({ to, subject, textBody, htmlBody, from, cc, bcc, replyTo, tag }) => {
      const emailData = {
        From: from || defaultSender,
        To: Array.isArray(to) ? to.join(', ') : to,
        Subject: subject,
        TextBody: textBody,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (htmlBody) emailData.HtmlBody = htmlBody;
      if (cc) emailData.Cc = cc;
      if (bcc) emailData.Bcc = bcc;
      if (replyTo) emailData.ReplyTo = replyTo;
      if (tag) emailData.Tag = tag;

      const result = await postmarkRequest('/email', { method: 'POST', body: JSON.stringify(emailData) });
      if (result.ErrorCode !== 0) {
        throw new Error(`Postmark returned ErrorCode ${result.ErrorCode}: ${result.Message}`);
      }
      console.error('Email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nSubject: ${subject}`
        }]
      };
    }
  );

  server.tool(
    "sendEmailWithTemplate",
    "Send a single email rendered from a saved Postmark template. Supply either templateId (numeric) or templateAlias (string) plus a templateModel object that provides the template variables. The From address must be a verified sender signature.",
    {
      to: z.string().email().describe("Recipient email address"),
      templateId: z.number().optional().describe("Template ID — provide either this or templateAlias, not both"),
      templateAlias: z.string().optional().describe("Template alias — provide either this or templateId, not both"),
      templateModel: z.object({}).passthrough().describe("Data model for template variables"),
      from: z.string().email().optional().describe("Sender email address (optional)"),
      cc: z.string().optional().describe("CC recipient(s), comma-separated (optional)"),
      bcc: z.string().optional().describe("BCC recipient(s), comma-separated (optional)"),
      replyTo: z.string().email().optional().describe("Reply-To address (optional)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    MUTATING,
    async ({ to, templateId, templateAlias, templateModel, from, cc, bcc, replyTo, tag }) => {
      if (!templateId && !templateAlias) {
        throw new Error("Either templateId or templateAlias must be provided");
      }
      if (templateId && templateAlias) {
        throw new Error("Provide only one of templateId or templateAlias, not both");
      }

      const emailData = {
        From: from || defaultSender,
        To: to,
        TemplateModel: templateModel,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (templateId) {
        emailData.TemplateId = templateId;
      } else {
        emailData.TemplateAlias = templateAlias;
      }

      if (cc) emailData.Cc = cc;
      if (bcc) emailData.Bcc = bcc;
      if (replyTo) emailData.ReplyTo = replyTo;
      if (tag) emailData.Tag = tag;

      console.error('Sending template email..', { templateId: templateId || templateAlias });
      const result = await postmarkRequest('/email/withTemplate', { method: 'POST', body: JSON.stringify(emailData) });
      if (result.ErrorCode !== 0) {
        throw new Error(`Postmark returned ErrorCode ${result.ErrorCode}: ${result.Message}`);
      }
      console.error('Template email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Template email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nTemplate: ${templateId || templateAlias}`
        }]
      };
    }
  );

  // ─────────────── Batch send ───────────────

  // Format batch send results into successes / failures summary.
  // Postmark returns one MessageSendingResponse per input message; ErrorCode
  // 0 indicates success. Failed sends still come back with `To` and a
  // `Message` describing why.
  const formatBatchResults = (results) => {
    const successes = results.filter(r => r.ErrorCode === 0);
    const failures = results.filter(r => r.ErrorCode !== 0);
    const lines = [`Sent ${successes.length}/${results.length} successfully` +
      (failures.length ? ` (${failures.length} failed)` : '')];

    if (failures.length) {
      lines.push('', 'Failures:');
      failures.slice(0, 20).forEach(f => {
        lines.push(`  - ${f.To || '(unknown)'} — ${f.ErrorCode}: ${f.Message}`);
      });
      if (failures.length > 20) lines.push(`  - ... and ${failures.length - 20} more`);
    }

    if (successes.length) {
      lines.push('', `Successes${successes.length > 10 ? ' (first 10 shown)' : ''}:`);
      successes.slice(0, 10).forEach(s => {
        lines.push(`  - ${s.To} — ${s.MessageID}`);
      });
      if (successes.length > 10) lines.push(`  - ... and ${successes.length - 10} more successful sends`);
    }

    return lines.join('\n');
  };

  server.tool(
    "sendBatch",
    "Send up to 500 independent emails in a single synchronous Postmark API call (POST /email/batch). Each message has its own recipient, subject, and body. Returns per-message results — the overall HTTP call succeeds even when individual messages fail. Use sendEmail for a single message.",
    {
      messages: z.array(z.object({
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Email subject"),
        textBody: z.string().describe("Plain text body"),
        htmlBody: z.string().optional().describe("HTML body"),
        from: z.string().email().optional().describe("Sender (defaults to DEFAULT_SENDER_EMAIL)"),
        cc: z.string().optional().describe("CC recipient(s), comma-separated"),
        bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
        replyTo: z.string().email().optional().describe("Reply-To address"),
        tag: z.string().optional().describe("Tag for categorization")
      })).min(1).max(500).describe("Up to 500 messages to send in a single request")
    },
    MUTATING,
    async ({ messages }) => {
      const payload = messages.map(m => {
        const msg = {
          From: m.from || defaultSender,
          To: m.to,
          Subject: m.subject,
          TextBody: m.textBody,
          MessageStream: defaultMessageStream,
          TrackOpens: true,
          TrackLinks: "HtmlAndText"
        };
        if (m.htmlBody) msg.HtmlBody = m.htmlBody;
        if (m.cc) msg.Cc = m.cc;
        if (m.bcc) msg.Bcc = m.bcc;
        if (m.replyTo) msg.ReplyTo = m.replyTo;
        if (m.tag) msg.Tag = m.tag;
        return msg;
      });

      console.error('Sending batch..', { count: payload.length });
      const results = await postmarkRequest('/email/batch', { method: 'POST', body: JSON.stringify(payload) });
      const failures = results.filter(r => r.ErrorCode !== 0).length;
      console.error(`Batch sent: ${results.length - failures}/${results.length} succeeded`);

      return { content: [{ type: "text", text: formatBatchResults(results) }] };
    }
  );

  server.tool(
    "sendBatchWithTemplate",
    "Send the same Postmark template to up to 500 recipients in a single call, with per-recipient template models (POST /email/batchWithTemplates). Supply either templateId or templateAlias. Returns per-message results. Use sendEmailWithTemplate for a single recipient.",
    {
      templateId: z.number().int().optional().describe("Template ID (use either this or templateAlias)"),
      templateAlias: z.string().optional().describe("Template alias (use either this or templateId)"),
      from: z.string().email().optional().describe("Default sender for all messages (defaults to DEFAULT_SENDER_EMAIL)"),
      tag: z.string().optional().describe("Default tag applied to all messages (overridable per-recipient)"),
      recipients: z.array(z.object({
        to: z.string().email().describe("Recipient email address"),
        templateModel: z.object({}).passthrough().describe("Per-recipient template variables"),
        from: z.string().email().optional().describe("Override sender for this recipient"),
        cc: z.string().optional().describe("CC recipient(s), comma-separated"),
        bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
        replyTo: z.string().email().optional().describe("Reply-To address"),
        tag: z.string().optional().describe("Override tag for this recipient")
      })).min(1).max(500).describe("Up to 500 recipients, each with their own template model")
    },
    MUTATING,
    async ({ templateId, templateAlias, from, tag, recipients }) => {
      if (!templateId && !templateAlias) {
        throw new Error("Either templateId or templateAlias must be provided");
      }
      if (templateId && templateAlias) {
        throw new Error("Provide only one of templateId or templateAlias, not both");
      }

      const payload = recipients.map(r => {
        const msg = {
          From: r.from || from || defaultSender,
          To: r.to,
          TemplateModel: r.templateModel,
          MessageStream: defaultMessageStream,
          TrackOpens: true,
          TrackLinks: "HtmlAndText"
        };
        if (templateId) msg.TemplateId = templateId;
        else msg.TemplateAlias = templateAlias;
        if (r.cc) msg.Cc = r.cc;
        if (r.bcc) msg.Bcc = r.bcc;
        if (r.replyTo) msg.ReplyTo = r.replyTo;
        const effectiveTag = r.tag ?? tag;
        if (effectiveTag) msg.Tag = effectiveTag;
        return msg;
      });

      console.error('Sending template batch..', { count: payload.length, template: templateId || templateAlias });
      const results = await postmarkRequest('/email/batchWithTemplates', { method: 'POST', body: JSON.stringify({ Messages: payload }) });
      const failures = results.filter(r => r.ErrorCode !== 0).length;
      console.error(`Template batch sent: ${results.length - failures}/${results.length} succeeded`);

      return { content: [{ type: "text", text: formatBatchResults(results) }] };
    }
  );

  // ─────────────── Templates ───────────────

  server.tool(
    "listTemplates",
    "List saved email templates on this Postmark server. Returns up to 100 templates with name, ID, alias, subject, type (Standard or Layout), and layout binding. Use getTemplate to retrieve a template's full HTML and text content.",
    {},
    READ_ONLY,
    async () => {
      console.error('Fetching templates..');
      const result = await postmarkRequest(`/templates${qs({ count: 100, offset: 0 })}`);
      console.error(`Found ${result.Templates.length} templates`);

      const templateList = result.Templates.map(t => {
        const lines = [
          `• **${t.Name}**`,
          `  - ID: ${t.TemplateId}`,
          `  - Alias: ${t.Alias || 'none'}`,
          `  - Subject: ${t.Subject || 'none'}`,
        ];
        if (t.TemplateType) lines.push(`  - Type: ${t.TemplateType}`);
        if (t.LayoutTemplate) lines.push(`  - Layout: ${t.LayoutTemplate}`);
        return lines.join('\n');
      }).join('\n\n');

      const truncated = result.Templates.length === 100;
      return {
        content: [{
          type: "text",
          text: `Found ${result.Templates.length} templates${truncated ? ' (first 100 shown — server may have more; pagination not yet supported)' : ''}:\n\n${templateList}`
        }]
      };
    }
  );

  server.tool(
    "getTemplate",
    "Retrieve the full content of a single Postmark template — HTML body, text body, subject, type (Standard/Layout), and layout association — by numeric ID or string alias.",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string)")
    },
    READ_ONLY,
    async ({ templateIdOrAlias }) => {
      console.error('Fetching template..', { templateIdOrAlias });
      const result = await postmarkRequest(`/templates/${encodeURIComponent(templateIdOrAlias)}`);
      console.error('Template retrieved');

      return {
        content: [{
          type: "text",
          text: `Template: ${result.Name}\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Subject: ${result.Subject}\n` +
            `Type: ${result.TemplateType}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}\n` +
            `Associated Server: ${result.AssociatedServerId}\n\n` +
            `--- HTML Body ---\n${result.HtmlBody || '(empty)'}\n\n` +
            `--- Text Body ---\n${result.TextBody || '(empty)'}`
        }]
      };
    }
  );

  server.tool(
    "createTemplate",
    "Create a new email template on this Postmark server. Requires a name and at least one of htmlBody or textBody. Subject is required for Standard templates and must be omitted for Layout templates. Optionally bind a Standard template to an existing Layout via layoutTemplate.",
    {
      name: z.string().describe("Template name"),
      subject: z.string().optional().describe("Template subject line. Required for Standard templates; must be omitted for Layout templates (Postmark rejects Subject on Layouts)."),
      htmlBody: z.string().optional().describe("HTML content of the template"),
      textBody: z.string().optional().describe("Plain text content of the template"),
      alias: z.string().optional().describe("A unique alias for the template (letters, numbers, dots, hyphens, underscores)"),
      templateType: z.enum(["Standard", "Layout"]).optional().describe("Template type (default: Standard)"),
      layoutTemplate: z.string().optional().describe("Alias of an existing Layout template to wrap this template's content. Only valid when templateType is 'Standard' (the default).")
    },
    MUTATING,
    async ({ name, subject, htmlBody, textBody, alias, templateType, layoutTemplate }) => {
      if (!htmlBody && !textBody) {
        throw new Error("At least one of htmlBody or textBody must be provided");
      }
      const isLayout = templateType === "Layout";
      if (!isLayout && !subject) {
        throw new Error("Subject is required for Standard templates");
      }
      if (isLayout && subject) {
        throw new Error("Subject must not be provided for Layout templates — Postmark rejects this field on Layouts");
      }
      if (layoutTemplate && isLayout) {
        throw new Error("layoutTemplate cannot be set on a Layout template — only Standard templates wrap a layout");
      }

      const options = { Name: name };
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (alias) options.Alias = alias;
      if (templateType) options.TemplateType = templateType;
      if (layoutTemplate) options.LayoutTemplate = layoutTemplate;

      console.error('Creating template..', { name });
      const result = await postmarkRequest('/templates', { method: 'POST', body: JSON.stringify(options) });
      console.error('Template created: ', result.TemplateId);

      return {
        content: [{
          type: "text",
          text: `Template created successfully!\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Name: ${result.Name}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}`
        }]
      };
    }
  );

  server.tool(
    "editTemplate",
    "Update an existing Postmark template's name, subject, HTML body, text body, alias, or layout binding. At least one field must be provided. Overwrites existing content in place — this cannot be undone. Pass layoutTemplate: null to detach a Standard template from its Layout.",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string)"),
      name: z.string().optional().describe("Updated template name"),
      subject: z.string().optional().describe("Updated subject line"),
      htmlBody: z.string().optional().describe("Updated HTML content"),
      textBody: z.string().optional().describe("Updated plain text content"),
      alias: z.string().optional().describe("Updated alias"),
      layoutTemplate: z.string().nullable().optional().describe("Alias of a Layout template to bind this Standard template to. Pass null to unbind (remove the layout association).")
    },
    DESTRUCTIVE,
    async ({ templateIdOrAlias, name, subject, htmlBody, textBody, alias, layoutTemplate }) => {
      const options = {};
      if (name) options.Name = name;
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (alias) options.Alias = alias;
      // Postmark's edit endpoint treats JSON null as "no change". Sending an
      // empty string is the documented way to unbind a layout association.
      if (layoutTemplate !== undefined) {
        options.LayoutTemplate = layoutTemplate === null ? "" : layoutTemplate;
      }

      if (Object.keys(options).length === 0) {
        throw new Error("Provide at least one field to update (name, subject, htmlBody, textBody, alias, or layoutTemplate)");
      }

      console.error('Editing template..', { templateIdOrAlias });
      const result = await postmarkRequest(`/templates/${encodeURIComponent(templateIdOrAlias)}`, { method: 'PUT', body: JSON.stringify(options) });
      console.error('Template updated: ', result.TemplateId);

      return {
        content: [{
          type: "text",
          text: `Template updated successfully!\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Name: ${result.Name}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}`
        }]
      };
    }
  );

  server.tool(
    "deleteTemplate",
    "Permanently delete a Postmark template by numeric ID or string alias. This cannot be undone. Layout templates cannot be deleted while Standard templates are still bound to them.",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string) to delete")
    },
    DESTRUCTIVE,
    async ({ templateIdOrAlias }) => {
      console.error('Deleting template..', { templateIdOrAlias });
      await postmarkRequest(`/templates/${encodeURIComponent(templateIdOrAlias)}`, { method: 'DELETE' });
      console.error('Template deleted');

      return {
        content: [{
          type: "text",
          text: `Template "${templateIdOrAlias}" deleted successfully.`
        }]
      };
    }
  );

  server.tool(
    "validateTemplate",
    "Validate Postmark Mustachio template syntax and variable references without saving anything. Checks subject, HTML body, and/or text body for errors and optionally renders them against a test data model. Use this before createTemplate or editTemplate to catch mistakes early.",
    {
      subject: z.string().optional().describe("Template subject to validate"),
      htmlBody: z.string().optional().describe("HTML body to validate"),
      textBody: z.string().optional().describe("Text body to validate"),
      testRenderModel: z.object({}).passthrough().optional().describe("Test data model to render the template with"),
      templateType: z.enum(["Standard", "Layout"]).optional().describe("Template type (default: Standard)"),
      layoutTemplate: z.string().optional().describe("Layout template alias to validate against")
    },
    READ_ONLY,
    async ({ subject, htmlBody, textBody, testRenderModel, templateType, layoutTemplate }) => {
      if (!subject && !htmlBody && !textBody) {
        throw new Error("At least one of subject, htmlBody, or textBody must be provided");
      }

      const options = {};
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (testRenderModel) options.TestRenderModel = testRenderModel;
      if (templateType) options.TemplateType = templateType;
      if (layoutTemplate) options.LayoutTemplate = layoutTemplate;

      console.error('Validating template..');
      const result = await postmarkRequest('/templates/validate', { method: 'POST', body: JSON.stringify(options) });
      console.error('Template validation complete');

      const sections = [];

      if (result.Subject) {
        sections.push(`Subject: ${result.Subject.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.Subject.ValidationErrors?.length ? `\n  Errors: ${result.Subject.ValidationErrors.map(e => e.Message).join(', ')}` : '') +
          (result.Subject.RenderedContent ? `\n  Rendered: ${result.Subject.RenderedContent}` : ''));
      }
      if (result.HtmlBody) {
        sections.push(`HTML Body: ${result.HtmlBody.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.HtmlBody.ValidationErrors?.length ? `\n  Errors: ${result.HtmlBody.ValidationErrors.map(e => e.Message).join(', ')}` : ''));
      }
      if (result.TextBody) {
        sections.push(`Text Body: ${result.TextBody.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.TextBody.ValidationErrors?.length ? `\n  Errors: ${result.TextBody.ValidationErrors.map(e => e.Message).join(', ')}` : ''));
      }

      const allValid = result.AllContentIsValid;

      return {
        content: [{
          type: "text",
          text: `Template Validation: ${allValid ? 'ALL VALID' : 'HAS ERRORS'}\n\n${sections.join('\n\n')}`
        }]
      };
    }
  );

  // ─────────────── Messages ───────────────

  server.tool(
    "searchOutboundMessages",
    "Search outbound message history on this Postmark server. Filter by recipient, sender, subject, tag, delivery status, message stream, or date range. Returns up to 500 messages per call with basic metadata. Use getMessageDetails to retrieve the full event timeline for a specific message.",
    {
      recipient: z.string().optional().describe("Filter by recipient email address"),
      fromEmail: z.string().optional().describe("Filter by sender email address"),
      tag: z.string().optional().describe("Filter by tag"),
      subject: z.string().optional().describe("Filter by subject line"),
      status: z.enum(["queued", "sent", "processed"]).optional().describe("Filter by message status"),
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      count: z.number().int().min(1).max(500).optional().describe("Number of results to return (default 50, max 500)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0). Note: count + offset cannot exceed 10,000.")
    },
    READ_ONLY,
    async ({ recipient, fromEmail, tag, subject, status, messageStream, fromDate, toDate, count, offset }) => {
      const filter = {};
      if (recipient) filter.recipient = recipient;
      if (fromEmail) filter.fromemail = fromEmail;
      if (tag) filter.tag = tag;
      if (subject) filter.subject = subject;
      if (status) filter.status = status;
      if (messageStream) filter.messagestream = messageStream;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      filter.count = count || 50;
      filter.offset = offset || 0;

      console.error('Searching outbound messages..', filter);
      const result = await postmarkRequest(`/messages/outbound${qs(filter)}`);
      console.error(`Found ${result.TotalCount} messages`);

      if (result.Messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your criteria." }] };
      }

      const messageList = result.Messages.map(m =>
        `• **${m.Subject}**\n  - MessageID: ${m.MessageID}\n  - To: ${m.Recipients.join(', ')}\n  - From: ${m.From}\n  - Status: ${m.Status}\n  - Date: ${m.ReceivedAt}\n  - Tag: ${m.Tag || 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.TotalCount} messages (showing ${result.Messages.length}):\n\n${messageList}`
        }]
      };
    }
  );

  server.tool(
    "getMessageDetails",
    "Retrieve the full delivery details and event timeline (Delivered, Opened, Clicked, Bounced, etc.) for a single outbound message by its Postmark MessageID. Use searchOutboundMessages to find a MessageID first.",
    {
      messageId: z.string().describe("The MessageID of the email to retrieve details for")
    },
    READ_ONLY,
    async ({ messageId }) => {
      console.error('Fetching message details..', { messageId });
      const result = await postmarkRequest(`/messages/outbound/${encodeURIComponent(messageId)}/details`);
      console.error('Message details retrieved');

      const events = (result.MessageEvents || []).map(e =>
        `  - ${e.Type} at ${e.ReceivedAt}${e.Details?.Summary ? ` (${e.Details.Summary})` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Message Details\n\n` +
            `MessageID: ${result.MessageID}\n` +
            `Subject: ${result.Subject}\n` +
            `From: ${result.From}\n` +
            `To: ${(result.Recipients || []).join(', ')}\n` +
            `Status: ${result.Status}\n` +
            `Date: ${result.ReceivedAt}\n` +
            `Tag: ${result.Tag || 'none'}\n` +
            `${events ? `\nEvents:\n${events}` : '\nNo events recorded.'}`
        }]
      };
    }
  );

  // ─────────────── Diagnostics ───────────────

  // Composite triage tool: answers "did my email reach X, and if not, why?"
  // by running searches/lookups in parallel and synthesizing a recommendation.
  server.tool(
    "diagnoseDelivery",
    "Diagnose why an email may not have reached a recipient. Runs message search, suppression lookup, and bounce history checks in parallel and returns a plain-English recommendation. Use this as a first step when a recipient reports a missing, undelivered, or bounced email.",
    {
      recipient: z.string().email().describe("The recipient address to investigate"),
      messageId: z.string().optional().describe("Optional specific MessageID to investigate. If omitted, the most recent message to recipient is used"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Search window start, YYYY-MM-DD (default: 7 days ago)"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Search window end, YYYY-MM-DD (default: today)"),
      messageStream: z.string().optional().describe("Message stream for suppression check (default: DEFAULT_MESSAGE_STREAM)")
    },
    READ_ONLY,
    async ({ recipient, messageId, fromDate, toDate, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const windowFrom = fromDate || weekAgo;
      const windowTo = toDate || today;

      console.error('Diagnosing delivery..', { messageId, stream });

      // Independent lookups in parallel — each tolerant of failure so a
      // single 404 (e.g., bad messageId) doesn't sink the whole diagnosis.
      const [messages, suppressions, bounces] = await Promise.all([
        messageId
          ? postmarkRequest(`/messages/outbound/${encodeURIComponent(messageId)}/details`)
              .then(r => [r]).catch(() => [])
          : postmarkRequest(`/messages/outbound${qs({
              recipient,
              fromdate: windowFrom,
              todate: windowTo,
              count: 5,
            })}`).then(r => r.Messages || []).catch(() => []),
        postmarkRequest(`/message-streams/${encodeURIComponent(stream)}/suppressions/dump${qs({ EmailAddress: recipient })}`)
          .then(r => r.Suppressions || []).catch(() => []),
        postmarkRequest(`/bounces${qs({ emailFilter: recipient, count: 10 })}`)
          .then(r => r.Bounces || []).catch(() => []),
      ]);

      // Promote the most recent search hit to full details so we have events
      let latest = null;
      if (messages.length > 0) {
        latest = messages[0].MessageEvents
          ? messages[0]
          : await postmarkRequest(`/messages/outbound/${encodeURIComponent(messages[0].MessageID)}/details`).catch(() => messages[0]);
      }

      const lines = [`Delivery Diagnosis: ${recipient}`, '─'.repeat(48), ''];

      // 1. Suppression status (most decisive single signal)
      if (suppressions.length > 0) {
        const s = suppressions[0];
        lines.push(`Suppression: SUPPRESSED on stream "${stream}"`);
        lines.push(`  Reason: ${s.SuppressionReason}`);
        lines.push(`  Origin: ${s.Origin}`);
        lines.push(`  Since:  ${s.CreatedAt}`);
      } else {
        lines.push(`Suppression: not suppressed on stream "${stream}"`);
      }
      lines.push('');

      // 2. Most recent message + its events
      if (latest) {
        const events = (latest.MessageEvents || []).map(e => e.Type);
        const counts = events.reduce((acc, t) => ({ ...acc, [t]: (acc[t] || 0) + 1 }), {});
        lines.push('Most recent message:');
        lines.push(`  MessageID: ${latest.MessageID}`);
        lines.push(`  Subject:   ${latest.Subject || '(none)'}`);
        lines.push(`  Sent:      ${latest.ReceivedAt}`);
        lines.push(`  Status:    ${latest.Status}`);
        if (events.length) {
          const summary = Object.entries(counts)
            .map(([t, n]) => n > 1 ? `${t}×${n}` : t).join(', ');
          lines.push(`  Events:    ${summary}`);
        }
      } else {
        lines.push(`No messages found for ${recipient} between ${windowFrom} and ${windowTo}.`);
      }
      lines.push('');

      // 3. Bounce history
      if (bounces.length > 0) {
        lines.push(`Bounce history (${bounces.length} recent):`);
        bounces.slice(0, 3).forEach(b => {
          const reactivatable = b.CanActivate ? ' [can reactivate]' : '';
          lines.push(`  - ${b.BouncedAt} ${b.Type}: ${b.Description}${reactivatable}`);
        });
        if (bounces.length > 3) lines.push(`  - ... and ${bounces.length - 3} more`);
      } else {
        lines.push('Bounce history: none');
      }
      lines.push('');

      // 4. Synthesized recommendation
      lines.push('Recommended action:');
      if (suppressions.length > 0) {
        const s = suppressions[0];
        if (s.SuppressionReason === 'SpamComplaint') {
          lines.push('  Recipient marked previous mail as spam — suppression is permanent and');
          lines.push('  cannot be lifted via API. Do not retry.');
        } else if (s.SuppressionReason === 'HardBounce') {
          const reactivatable = bounces.find(b => b.CanActivate);
          if (reactivatable) {
            lines.push(`  Run activateBounce with bounceId ${reactivatable.ID}, then resend.`);
          } else {
            lines.push('  Address hard-bounced. Verify the address is valid before retrying;');
            lines.push('  if confirmed valid, run deleteSuppressions then resend.');
          }
        } else {
          lines.push('  Run deleteSuppressions with this address to lift the suppression, then resend.');
        }
      } else if (latest && (latest.MessageEvents || []).some(e => e.Type === 'Delivered')) {
        lines.push('  Email was delivered. If recipient says they didn\'t see it, check their');
        lines.push('  spam folder or ask them to whitelist the sender domain.');
      } else if (latest?.Status === 'Queued') {
        lines.push('  Most recent message is still queued. Re-run in a few minutes.');
      } else if (!latest) {
        lines.push(`  No recent send to this address. Use sendEmail to send, or expand the date range.`);
      } else {
        lines.push(`  Message status is "${latest.Status}". Review events above to identify the failure.`);
      }

      return { content: [{ type: "text", text: lines.join('\n') }] };
    }
  );

  // ─────────────── Bounces ───────────────

  server.tool(
    "searchBounces",
    "Search the Postmark bounce log. Filter by bounce type, email address, tag, message ID, message stream, and date range. Returns bounce records with type, description, timestamp, and whether each address can be reactivated. Bounce records are retained for 45 days.",
    {
      type: z.enum([
        "AddressChange", "AutoResponder", "BadEmailAddress", "Blocked",
        "ChallengeVerification", "DMARCPolicy", "DnsError", "HardBounce",
        "InboundError", "ManuallyDeactivated", "OpenRelayTest", "SMTPApiError",
        "SoftBounce", "SpamComplaint", "SpamNotification", "Subscribe",
        "TemplateRenderingFailed", "Transient", "Unconfirmed", "Unknown",
        "Unsubscribe", "VirusNotification"
      ]).optional().describe("Filter by bounce type (matches Postmark's BounceType enum — 22 values)"),
      inactive: z.boolean().optional().describe("Filter by deactivated status"),
      emailFilter: z.string().optional().describe("Filter by full or partial email address"),
      tag: z.string().optional().describe("Filter by tag"),
      messageID: z.string().optional().describe("Filter by original message ID"),
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default 50, max 500)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0). Note: count + offset cannot exceed 10,000.")
    },
    READ_ONLY,
    async ({ type, inactive, emailFilter, tag, messageID, messageStream, fromDate, toDate, count, offset }) => {
      const filter = {};
      if (type) filter.type = type;
      if (inactive !== undefined) filter.inactive = inactive;
      if (emailFilter) filter.emailFilter = emailFilter;
      if (tag) filter.tag = tag;
      if (messageID) filter.messageID = messageID;
      if (messageStream) filter.messagestream = messageStream;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      filter.count = count || 50;
      filter.offset = offset || 0;

      console.error('Searching bounces..', filter);
      const result = await postmarkRequest(`/bounces${qs(filter)}`);
      console.error(`Found ${result.TotalCount} bounces`);

      if (result.Bounces.length === 0) {
        return { content: [{ type: "text", text: "No bounces found matching your criteria." }] };
      }

      const bounceList = result.Bounces.map(b =>
        `• **${b.Email}**\n  - BounceID: ${b.ID}\n  - Type: ${b.Type} (${b.TypeCode})\n  - Description: ${b.Description}\n  - Date: ${b.BouncedAt}\n  - Inactive: ${b.Inactive}\n  - Can Activate: ${b.CanActivate}\n  - Subject: ${b.Subject || 'N/A'}\n  - Tag: ${b.Tag || 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.TotalCount} bounces (showing ${result.Bounces.length}):\n\n${bounceList}`
        }]
      };
    }
  );

  server.tool(
    "getBounceDump",
    "Retrieve the raw SMTP conversation transcript for a specific bounce record. Useful for diagnosing exactly how a remote mail server rejected a message. Dumps are only retained for 30 days after the bounce.",
    {
      bounceId: z.number().int().describe("The ID of the bounce to retrieve the SMTP dump for")
    },
    READ_ONLY,
    async ({ bounceId }) => {
      console.error('Fetching bounce dump..', { bounceId });
      const result = await postmarkRequest(`/bounces/${encodeURIComponent(bounceId)}/dump`);
      console.error('Bounce dump retrieved');

      return {
        content: [{
          type: "text",
          text: result.Body
            ? `SMTP Bounce Dump (Bounce ID: ${bounceId}):\n\n${result.Body}`
            : `No SMTP dump available for bounce ${bounceId}. Dumps are retained for 30 days.`
        }]
      };
    }
  );

  server.tool(
    "activateBounce",
    "Reactivate a deactivated email address so it can receive mail again on Postmark. Only works on bounces where CanActivate is true (typically HardBounce). SpamComplaint bounces cannot be reactivated. Use searchBounces or diagnoseDelivery to find the bounceId.",
    {
      bounceId: z.number().int().describe("The ID of the bounce to reactivate")
    },
    MUTATING,
    async ({ bounceId }) => {
      console.error('Activating bounce..', { bounceId });
      const result = await postmarkRequest(`/bounces/${encodeURIComponent(bounceId)}/activate`, { method: 'PUT' });
      console.error('Bounce activated');

      return {
        content: [{
          type: "text",
          text: `Bounce reactivated successfully!\n\n` +
            `Bounce ID: ${result.Bounce.ID}\n` +
            `Email: ${result.Bounce.Email}\n` +
            `Message: ${result.Message}`
        }]
      };
    }
  );

  // ─────────────── Suppressions ───────────────

  server.tool(
    "listSuppressions",
    "List suppressed email addresses on a Postmark message stream. Optionally filter by suppression reason (HardBounce, SpamComplaint, ManualSuppression), origin (Recipient, Customer, Admin), email address, or date range. Suppressed addresses will not receive mail on that stream.",
    {
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)"),
      suppressionReason: z.enum(["HardBounce", "SpamComplaint", "ManualSuppression"]).optional().describe("Filter by suppression reason"),
      origin: z.enum(["Recipient", "Customer", "Admin"]).optional().describe("Filter by suppression origin"),
      emailAddress: z.string().optional().describe("Filter by full or partial email address"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format")
    },
    READ_ONLY,
    async ({ messageStream, suppressionReason, origin, emailAddress, fromDate, toDate }) => {
      const stream = messageStream || defaultMessageStream;
      const filter = {};
      if (suppressionReason) filter.SuppressionReason = suppressionReason;
      if (origin) filter.Origin = origin;
      if (emailAddress) filter.EmailAddress = emailAddress;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;

      console.error('Fetching suppressions..', { stream, filter });
      const result = await postmarkRequest(`/message-streams/${encodeURIComponent(stream)}/suppressions/dump${qs(filter)}`);
      console.error(`Found ${result.Suppressions.length} suppressions`);

      if (result.Suppressions.length === 0) {
        return { content: [{ type: "text", text: `No suppressions found on stream "${stream}" matching your criteria.` }] };
      }

      const list = result.Suppressions.map(s =>
        `• **${s.EmailAddress}**\n  - Reason: ${s.SuppressionReason}\n  - Origin: ${s.Origin}\n  - Created: ${s.CreatedAt}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Suppressions.length} suppressions (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "createSuppressions",
    "Add up to 50 email addresses to the suppression list for a Postmark message stream. Suppressed addresses will not receive mail on that stream. Each address in the response indicates whether suppression was created or failed.",
    {
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("Email addresses to suppress (max 50)"),
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)")
    },
    MUTATING,
    async ({ emailAddresses, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const options = {
        Suppressions: emailAddresses.map(email => ({ EmailAddress: email }))
      };

      console.error('Creating suppressions..', { count: emailAddresses.length, stream });
      const result = await postmarkRequest(`/message-streams/${encodeURIComponent(stream)}/suppressions`, { method: 'POST', body: JSON.stringify(options) });
      console.error('Suppressions created');

      const list = result.Suppressions.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ` — ${s.Message}` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Suppression results (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "deleteSuppressions",
    "Remove up to 50 addresses from the suppression list on a Postmark message stream, allowing them to receive mail again. SpamComplaint suppressions cannot be deleted via API. Deleting a HardBounce suppression is equivalent to reactivating that bounce.",
    {
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("Email addresses to unsuppress (max 50). Note: SpamComplaint suppressions cannot be deleted."),
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)")
    },
    DESTRUCTIVE,
    async ({ emailAddresses, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const options = {
        Suppressions: emailAddresses.map(email => ({ EmailAddress: email }))
      };

      console.error('Deleting suppressions..', { count: emailAddresses.length, stream });
      const result = await postmarkRequest(`/message-streams/${encodeURIComponent(stream)}/suppressions/delete`, { method: 'POST', body: JSON.stringify(options) });
      console.error('Suppressions deleted');

      const list = result.Suppressions.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ` — ${s.Message}` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Suppression deletion results (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  // ─────────────── Stats & Server ───────────────

  server.tool(
    "getDeliveryStats",
    "Retrieve outbound email statistics for this Postmark server. The default 'summary' stat returns headline open rate, click rate, bounce rate, and spam rate. Specify a stat value (opens, clicks, bounces, openPlatforms, etc.) for a focused breakdown. Filterable by tag, date range, and message stream.",
    {
      stat: z.enum([
        "summary", "overview", "sent", "bounces", "spam", "tracked",
        "opens", "openPlatforms", "openClients", "openReadTimes",
        "clicks", "clickBrowsers", "clickPlatforms", "clickLocation"
      ]).optional().describe("Which stat to retrieve. Default 'summary' returns headline open/click/bounce rates."),
      tag: z.string().optional().describe("Filter by tag"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      messageStream: z.string().optional().describe("Filter by message stream ID")
    },
    READ_ONLY,
    async ({ stat, tag, fromDate, toDate, messageStream }) => {
      const filter = {};
      if (tag) filter.tag = tag;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      if (messageStream) filter.messagestream = messageStream;

      const requested = stat || "summary";
      console.error('Fetching stats..', { stat: requested, filter });

      const statPaths = {
        summary:        '/stats/outbound',
        overview:       '/stats/outbound',
        sent:           '/stats/outbound/sends',
        bounces:        '/stats/outbound/bounces',
        spam:           '/stats/outbound/spam',
        tracked:        '/stats/outbound/tracked',
        opens:          '/stats/outbound/opens',
        openPlatforms:  '/stats/outbound/opens/platforms',
        openClients:    '/stats/outbound/opens/emailClients',
        openReadTimes:  '/stats/outbound/opens/readTimes',
        clicks:         '/stats/outbound/clicks',
        clickBrowsers:  '/stats/outbound/clicks/browserFamilies',
        clickPlatforms: '/stats/outbound/clicks/platforms',
        clickLocation:  '/stats/outbound/clicks/location',
      };

      const data = await postmarkRequest(`${statPaths[requested]}${qs(filter)}`);
      console.error('Stats retrieved');

      const text = requested === "summary"
        ? fmtDeliverySummary(data, { fromDate, toDate, tag, messageStream })
        : fmtStatResponse(requested, data);

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "getServerInfo",
    "Retrieve this Postmark server's configuration: name, ID, color, SMTP activation status, inbound address, open and link tracking settings, and any legacy server-level webhook URLs. Use listWebhooks for webhooks managed via the Webhooks API.",
    {},
    READ_ONLY,
    async () => {
      console.error('Fetching server info..');
      const result = await postmarkRequest('/server');
      console.error('Server info retrieved');

      return {
        content: [{
          type: "text",
          text: `Server: ${result.Name}\n\n` +
            `ID: ${result.ID}\n` +
            `Color: ${result.Color}\n` +
            `SMTP Activated: ${result.SmtpApiActivated}\n` +
            `Inbound Address: ${result.InboundAddress || 'none'}\n` +
            `Inbound Domain: ${result.InboundDomain || 'none'}\n\n` +
            `Tracking:\n` +
            `  Open Tracking: ${result.TrackOpens}\n` +
            `  Link Tracking: ${result.TrackLinks}\n` +
            `  First Open Only: ${result.PostFirstOpenOnly}\n\n` +
            `Webhooks:\n` +
            `  Bounce: ${result.BounceHookUrl || 'none'}\n` +
            `  Open: ${result.OpenHookUrl || 'none'}\n` +
            `  Delivery: ${result.DeliveryHookUrl || 'none'}\n` +
            `  Click: ${result.ClickHookUrl || 'none'}\n` +
            `  Inbound: ${result.InboundHookUrl || 'none'}`
        }]
      };
    }
  );

  // ─────────────── Webhooks ───────────────

  server.tool(
    "listWebhooks",
    "List all webhooks configured on this Postmark server via the Webhooks API. Optionally filter by message stream. Shows each webhook's URL, numeric ID, stream, and enabled event triggers. Use the ID with deleteWebhook to remove one.",
    {
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')")
    },
    READ_ONLY,
    async ({ messageStream }) => {
      const filter = {};
      if (messageStream) filter.messagestream = messageStream;

      console.error('Fetching webhooks..', filter);
      const result = await postmarkRequest(`/webhooks${qs(filter)}`);
      console.error(`Found ${result.Webhooks.length} webhooks`);

      if (result.Webhooks.length === 0) {
        return { content: [{ type: "text", text: "No webhooks configured." }] };
      }

      const list = result.Webhooks.map(w => {
        const triggers = [];
        if (w.Triggers?.Open?.Enabled) triggers.push('Open');
        if (w.Triggers?.Click?.Enabled) triggers.push('Click');
        if (w.Triggers?.Delivery?.Enabled) triggers.push('Delivery');
        if (w.Triggers?.Bounce?.Enabled) triggers.push('Bounce');
        if (w.Triggers?.SpamComplaint?.Enabled) triggers.push('SpamComplaint');
        if (w.Triggers?.SubscriptionChange?.Enabled) triggers.push('SubscriptionChange');

        return `• **${w.Url}**\n  - ID: ${w.ID}\n  - Stream: ${w.MessageStream || 'all'}\n  - Triggers: ${triggers.join(', ') || 'none'}`;
      }).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Webhooks.length} webhooks:\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "createWebhook",
    "Register a new Postmark webhook that will receive HTTP POST notifications when specified events occur (opens, clicks, bounces, etc.). Requires an HTTPS URL and at least one enabled trigger. Webhooks are persistent — Postmark will keep calling the URL until the webhook is deleted. Only register URLs you control. To secure the receiving endpoint, whitelist Postmark's published sending IPs at the network level.",
    {
      url: z.string().url().startsWith("https://").describe("The webhook URL to receive POST requests (must use HTTPS)"),
      messageStream: z.string().optional().describe("Message stream ID (e.g. 'outbound')"),
      openEnabled: z.boolean().optional().describe("Trigger on email opens"),
      clickEnabled: z.boolean().optional().describe("Trigger on link clicks"),
      deliveryEnabled: z.boolean().optional().describe("Trigger on email delivery"),
      bounceEnabled: z.boolean().optional().describe("Trigger on bounces"),
      spamComplaintEnabled: z.boolean().optional().describe("Trigger on spam complaints"),
      subscriptionChangeEnabled: z.boolean().optional().describe("Trigger on subscription changes")
    },
    MUTATING,
    async ({ url, messageStream, openEnabled, clickEnabled, deliveryEnabled, bounceEnabled, spamComplaintEnabled, subscriptionChangeEnabled }) => {
      const anyTrigger = openEnabled || clickEnabled || deliveryEnabled ||
        bounceEnabled || spamComplaintEnabled || subscriptionChangeEnabled;
      if (!anyTrigger) {
        throw new Error("At least one trigger must be enabled (openEnabled, clickEnabled, deliveryEnabled, bounceEnabled, spamComplaintEnabled, or subscriptionChangeEnabled)");
      }

      if (!isAllowedWebhookUrl(url, webhookAllowlist)) {
        throw new Error(
          `Webhook URL rejected: does not match any allowed origin in WEBHOOK_URL_ALLOWLIST. ` +
          `Allowed entries: ${webhookAllowlist ? webhookAllowlist.join(', ') : '(none)'}`
        );
      }

      const options = {
        Url: url,
        Triggers: {
          Open: { Enabled: openEnabled || false },
          Click: { Enabled: clickEnabled || false },
          Delivery: { Enabled: deliveryEnabled || false },
          Bounce: { Enabled: bounceEnabled || false },
          SpamComplaint: { Enabled: spamComplaintEnabled || false },
          SubscriptionChange: { Enabled: subscriptionChangeEnabled || false }
        }
      };

      if (messageStream) options.MessageStream = messageStream;

      console.error('Creating webhook..', { url });
      const result = await postmarkRequest('/webhooks', { method: 'POST', body: JSON.stringify(options) });
      console.error('Webhook created: ', result.ID);

      const triggers = [];
      if (result.Triggers?.Open?.Enabled) triggers.push('Open');
      if (result.Triggers?.Click?.Enabled) triggers.push('Click');
      if (result.Triggers?.Delivery?.Enabled) triggers.push('Delivery');
      if (result.Triggers?.Bounce?.Enabled) triggers.push('Bounce');
      if (result.Triggers?.SpamComplaint?.Enabled) triggers.push('SpamComplaint');
      if (result.Triggers?.SubscriptionChange?.Enabled) triggers.push('SubscriptionChange');

      return {
        content: [{
          type: "text",
          text: `Webhook created successfully!\n\n` +
            `ID: ${result.ID}\n` +
            `URL: ${result.Url}\n` +
            `Stream: ${result.MessageStream || 'all'}\n` +
            `Triggers: ${triggers.join(', ') || 'none'}`
        }]
      };
    }
  );

  server.tool(
    "deleteWebhook",
    "Permanently delete a Postmark webhook by its numeric ID. Postmark will stop sending event notifications to that URL immediately. Use listWebhooks to find the ID.",
    {
      webhookId: z.number().int().describe("The ID of the webhook to delete")
    },
    DESTRUCTIVE,
    async ({ webhookId }) => {
      console.error('Deleting webhook..', { webhookId });
      await postmarkRequest(`/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
      console.error('Webhook deleted');

      return {
        content: [{
          type: "text",
          text: `Webhook ${webhookId} deleted successfully.`
        }]
      };
    }
  );

  if (!accountToken) return;

  // ─────────────── Account: servers ───────────────
  //
  // These tools use the account token. Server API tokens are never included in
  // their output; use the server-scoped tools (with a `server` argument) to act
  // on a specific server.

  accountTool(
    "listServers",
    "List the Postmark servers in the account. Returns each server's name, ID, color, and delivery type. Optionally filter by name. Server API tokens are not included; use a server-scoped tool with the `server` argument to act on one.",
    {
      name: z.string().optional().describe("Filter to servers whose name contains this string"),
      count: z.number().int().min(1).max(500).optional().describe("Page size (default 100, max 500)"),
      offset: z.number().int().min(0).optional().describe("Number of servers to skip (default 0)")
    },
    READ_ONLY,
    async ({ name, count, offset }) => {
      console.error('Listing servers..');
      const data = await postmarkRequest(`/servers${qs({ count: count ?? 100, offset: offset ?? 0, name })}`, { auth: 'account' });
      const servers = data.Servers ?? [];
      const lines = servers.map(s => `  ${String(s.ID).padStart(9)}  ${s.Name}  (${s.Color}, ${s.DeliveryType})`);
      return {
        content: [{
          type: "text",
          text: `Servers (${servers.length} of ${fmtInt(data.TotalCount)}):\n\n${lines.join('\n') || '  (none)'}`
        }]
      };
    }
  );

  accountTool(
    "createServer",
    "Create a new Postmark server. Requires a name. Optionally set color and tracking defaults. The new server's API token is created by Postmark but is not returned here; retrieve it from the Postmark UI or use it via the `server` argument on server-scoped tools. Webhook URLs are set per server with createWebhook.",
    {
      name: z.string().describe("Server name (must be unique in the account)"),
      color: z.enum(["Purple", "Blue", "Turquoise", "Green", "Red", "Yellow", "Grey", "Orange"]).optional().describe("Display color in the Postmark UI"),
      deliveryType: z.enum(["Live", "Sandbox"]).optional().describe("Environment type; defaults to Live. Cannot be changed after creation. Use Sandbox for a server that accepts mail without delivering it"),
      trackOpens: z.boolean().optional().describe("Enable open tracking by default"),
      trackLinks: z.enum(["None", "HtmlAndText", "HtmlOnly", "TextOnly"]).optional().describe("Link tracking mode"),
      smtpApiActivated: z.boolean().optional().describe("Enable the SMTP API for this server")
    },
    MUTATING,
    async ({ name, color, deliveryType, trackOpens, trackLinks, smtpApiActivated }) => {
      const body = { Name: name };
      if (color) body.Color = color;
      if (deliveryType) body.DeliveryType = deliveryType;
      if (trackOpens !== undefined) body.TrackOpens = trackOpens;
      if (trackLinks) body.TrackLinks = trackLinks;
      if (smtpApiActivated !== undefined) body.SmtpApiActivated = smtpApiActivated;

      console.error('Creating server..', { name });
      const s = await postmarkRequest('/servers', { auth: 'account', method: 'POST', body: JSON.stringify(body) });
      invalidateServerCache();
      console.error('Server created: ', s.ID);
      return {
        content: [{
          type: "text",
          text: `Server "${s.Name}" created.\n\nID: ${s.ID}\nColor: ${s.Color || 'none'}\nDelivery type: ${s.DeliveryType || 'Live'}`
        }]
      };
    }
  );

  accountTool(
    "editServer",
    "Update an existing Postmark server's settings by ID. Only the fields you pass are changed. Requires at least one field to update. Webhook URLs are managed per server with createWebhook.",
    {
      serverId: z.number().int().describe("The ID of the server to edit"),
      name: z.string().optional().describe("New server name"),
      color: z.enum(["Purple", "Blue", "Turquoise", "Green", "Red", "Yellow", "Grey", "Orange"]).optional().describe("Display color in the Postmark UI"),
      trackOpens: z.boolean().optional().describe("Enable or disable open tracking"),
      trackLinks: z.enum(["None", "HtmlAndText", "HtmlOnly", "TextOnly"]).optional().describe("Link tracking mode"),
      smtpApiActivated: z.boolean().optional().describe("Enable or disable the SMTP API")
    },
    MUTATING,
    async ({ serverId, name, color, trackOpens, trackLinks, smtpApiActivated }) => {
      const body = {};
      if (name) body.Name = name;
      if (color) body.Color = color;
      if (trackOpens !== undefined) body.TrackOpens = trackOpens;
      if (trackLinks) body.TrackLinks = trackLinks;
      if (smtpApiActivated !== undefined) body.SmtpApiActivated = smtpApiActivated;
      if (Object.keys(body).length === 0) {
        throw new Error('editServer requires at least one field to update.');
      }

      console.error('Editing server..', { serverId });
      const s = await postmarkRequest(`/servers/${encodeURIComponent(serverId)}`, { auth: 'account', method: 'PUT', body: JSON.stringify(body) });
      invalidateServerCache();
      console.error('Server updated');
      return {
        content: [{
          type: "text",
          text: `Server "${s.Name}" (ID ${s.ID}) updated.`
        }]
      };
    }
  );

  accountTool(
    "deleteServer",
    "Permanently delete a Postmark server by ID. This cannot be undone. Postmark notes this feature is not enabled for all accounts; if the account lacks it the API error is surfaced verbatim and you should contact Postmark support.",
    {
      serverId: z.number().int().describe("The ID of the server to delete")
    },
    DESTRUCTIVE,
    async ({ serverId }) => {
      console.error('Deleting server..', { serverId });
      await postmarkRequest(`/servers/${encodeURIComponent(serverId)}`, { auth: 'account', method: 'DELETE' });
      invalidateServerCache();
      console.error('Server deleted');
      return {
        content: [{
          type: "text",
          text: `Server ${serverId} deleted successfully.`
        }]
      };
    }
  );

  // ─────────────── Account: domains and sender signatures ───────────────

  accountTool(
    "listDomains",
    "List the sending domains in the account. Returns each domain's name, ID, and SPF/DKIM/return-path verification status.",
    {
      count: z.number().int().min(1).max(500).optional().describe("Page size (default 100, max 500)"),
      offset: z.number().int().min(0).optional().describe("Number of domains to skip (default 0)")
    },
    READ_ONLY,
    async ({ count, offset }) => {
      console.error('Listing domains..');
      const data = await postmarkRequest(`/domains${qs({ count: count ?? 100, offset: offset ?? 0 })}`, { auth: 'account' });
      const domains = data.Domains ?? [];
      const lines = domains.map(d => `  ${String(d.ID).padStart(9)}  ${d.Name}  (SPF ${d.SPFVerified ? 'ok' : 'no'}, DKIM ${d.DKIMVerified ? 'ok' : 'no'}, return-path ${d.ReturnPathDomainVerified ? 'ok' : 'no'})`);
      return {
        content: [{
          type: "text",
          text: `Domains (${domains.length} of ${fmtInt(data.TotalCount)}):\n\n${lines.join('\n') || '  (none)'}`
        }]
      };
    }
  );

  accountTool(
    "getDomain",
    "Retrieve full details for a sending domain by ID, including DKIM host and text value, return-path CNAME, and current verification status. Use this to obtain the DNS records that must be published to verify the domain.",
    {
      domainId: z.number().int().describe("The ID of the domain to retrieve")
    },
    READ_ONLY,
    async ({ domainId }) => {
      console.error('Fetching domain..', { domainId });
      const d = await postmarkRequest(`/domains/${encodeURIComponent(domainId)}`, { auth: 'account' });
      return {
        content: [{
          type: "text",
          text: [
            `Domain: ${d.Name} (ID ${d.ID})`,
            '',
            `SPF verified:         ${d.SPFVerified ? 'yes' : 'no'}`,
            `DKIM verified:        ${d.DKIMVerified ? 'yes' : 'no'}`,
            `Return-path verified: ${d.ReturnPathDomainVerified ? 'yes' : 'no'}`,
            '',
            `DKIM host:  ${d.DKIMPendingHost || d.DKIMHost || '(none)'}`,
            `DKIM value: ${d.DKIMPendingTextValue || d.DKIMTextValue || '(none)'}`,
            `Return-path: ${d.ReturnPathDomain || '(none)'} -> ${d.ReturnPathDomainCNAMEValue || '(none)'}`,
          ].join('\n')
        }]
      };
    }
  );

  accountTool(
    "createDomain",
    "Create a sending domain in the account. Postmark generates the DKIM and return-path records to publish; retrieve them with getDomain, then verify with verifyDomainDkim and verifyDomainReturnPath once the DNS is live.",
    {
      name: z.string().describe("The domain name, e.g. example.com"),
      returnPathDomain: z.string().optional().describe("Custom return-path subdomain, e.g. pm-bounces.example.com")
    },
    MUTATING,
    async ({ name, returnPathDomain }) => {
      const body = { Name: name };
      if (returnPathDomain) body.ReturnPathDomain = returnPathDomain;
      console.error('Creating domain..', { name });
      const d = await postmarkRequest('/domains', { auth: 'account', method: 'POST', body: JSON.stringify(body) });
      console.error('Domain created: ', d.ID);
      return {
        content: [{
          type: "text",
          text: `Domain "${d.Name}" created (ID ${d.ID}). Use getDomain to retrieve its DKIM and return-path DNS records.`
        }]
      };
    }
  );

  accountTool(
    "verifyDomainDkim",
    "Ask Postmark to re-check a domain's DKIM DNS record and update its verification status. Run after publishing the DKIM record returned by getDomain.",
    {
      domainId: z.number().int().describe("The ID of the domain to verify")
    },
    MUTATING,
    async ({ domainId }) => {
      console.error('Verifying domain DKIM..', { domainId });
      const d = await postmarkRequest(`/domains/${encodeURIComponent(domainId)}/verifyDkim`, { auth: 'account', method: 'PUT' });
      return {
        content: [{
          type: "text",
          text: `DKIM for "${d.Name}" (ID ${d.ID}): ${d.DKIMVerified ? 'verified' : 'not verified yet'}.`
        }]
      };
    }
  );

  accountTool(
    "verifyDomainReturnPath",
    "Ask Postmark to re-check a domain's return-path CNAME record and update its verification status. Run after publishing the return-path record returned by getDomain.",
    {
      domainId: z.number().int().describe("The ID of the domain to verify")
    },
    MUTATING,
    async ({ domainId }) => {
      console.error('Verifying domain return-path..', { domainId });
      const d = await postmarkRequest(`/domains/${encodeURIComponent(domainId)}/verifyReturnPath`, { auth: 'account', method: 'PUT' });
      return {
        content: [{
          type: "text",
          text: `Return-path for "${d.Name}" (ID ${d.ID}): ${d.ReturnPathDomainVerified ? 'verified' : 'not verified yet'}.`
        }]
      };
    }
  );

  accountTool(
    "deleteDomain",
    "Permanently delete a sending domain by ID. This cannot be undone. Sender signatures under the domain are affected; verify no active server relies on it first.",
    {
      domainId: z.number().int().describe("The ID of the domain to delete")
    },
    DESTRUCTIVE,
    async ({ domainId }) => {
      console.error('Deleting domain..', { domainId });
      await postmarkRequest(`/domains/${encodeURIComponent(domainId)}`, { auth: 'account', method: 'DELETE' });
      console.error('Domain deleted');
      return {
        content: [{
          type: "text",
          text: `Domain ${domainId} deleted successfully.`
        }]
      };
    }
  );

  accountTool(
    "listSenders",
    "List the sender signatures (individual From addresses) in the account. Returns each signature's email, name, ID, and confirmation/DKIM status. For whole-domain sending use the domain tools instead.",
    {
      count: z.number().int().min(1).max(500).optional().describe("Page size (default 100, max 500)"),
      offset: z.number().int().min(0).optional().describe("Number of signatures to skip (default 0)")
    },
    READ_ONLY,
    async ({ count, offset }) => {
      console.error('Listing sender signatures..');
      const data = await postmarkRequest(`/senders${qs({ count: count ?? 100, offset: offset ?? 0 })}`, { auth: 'account' });
      const senders = data.SenderSignatures ?? [];
      const lines = senders.map(s => `  ${String(s.ID).padStart(9)}  ${s.EmailAddress}  (${s.Confirmed ? 'confirmed' : 'unconfirmed'})`);
      return {
        content: [{
          type: "text",
          text: `Sender signatures (${senders.length} of ${fmtInt(data.TotalCount)}):\n\n${lines.join('\n') || '  (none)'}`
        }]
      };
    }
  );

  accountTool(
    "getSender",
    "Retrieve full details for a sender signature by ID, including confirmation status and DKIM settings.",
    {
      signatureId: z.number().int().describe("The ID of the sender signature to retrieve")
    },
    READ_ONLY,
    async ({ signatureId }) => {
      console.error('Fetching sender signature..', { signatureId });
      const s = await postmarkRequest(`/senders/${encodeURIComponent(signatureId)}`, { auth: 'account' });
      return {
        content: [{
          type: "text",
          text: [
            `Sender: ${s.EmailAddress} (ID ${s.ID})`,
            `Name:      ${s.Name || '(none)'}`,
            `Confirmed: ${s.Confirmed ? 'yes' : 'no'}`,
            `DKIM:      ${s.DKIMVerified ? 'verified' : 'not verified'}`,
          ].join('\n')
        }]
      };
    }
  );

  accountTool(
    "createSender",
    "Create a sender signature for a single From address. Postmark emails the address a confirmation link; the signature cannot send until confirmed. To send from any address at a domain, verify the domain instead.",
    {
      fromEmail: z.string().email().describe("The From address to register"),
      name: z.string().describe("The display name for this signature"),
      replyToEmail: z.string().email().optional().describe("Default Reply-To address for this signature"),
      returnPathDomain: z.string().optional().describe("Custom return-path subdomain")
    },
    MUTATING,
    async ({ fromEmail, name, replyToEmail, returnPathDomain }) => {
      const body = { FromEmail: fromEmail, Name: name };
      if (replyToEmail) body.ReplyToEmail = replyToEmail;
      if (returnPathDomain) body.ReturnPathDomain = returnPathDomain;
      console.error('Creating sender signature..', { fromEmail: maskEmail(fromEmail) });
      const s = await postmarkRequest('/senders', { auth: 'account', method: 'POST', body: JSON.stringify(body) });
      console.error('Sender signature created: ', s.ID);
      return {
        content: [{
          type: "text",
          text: `Sender signature for ${s.EmailAddress} created (ID ${s.ID}). A confirmation email has been sent; it cannot send mail until confirmed.`
        }]
      };
    }
  );

  accountTool(
    "resendSenderConfirmation",
    "Resend the confirmation email for an unconfirmed sender signature by ID.",
    {
      signatureId: z.number().int().describe("The ID of the sender signature")
    },
    MUTATING,
    async ({ signatureId }) => {
      console.error('Resending sender confirmation..', { signatureId });
      await postmarkRequest(`/senders/${encodeURIComponent(signatureId)}/resend`, { auth: 'account', method: 'POST' });
      return {
        content: [{
          type: "text",
          text: `Confirmation email resent for sender signature ${signatureId}.`
        }]
      };
    }
  );

  accountTool(
    "deleteSender",
    "Permanently delete a sender signature by ID. This cannot be undone. The address can no longer be used as a From address until re-registered and confirmed.",
    {
      signatureId: z.number().int().describe("The ID of the sender signature to delete")
    },
    DESTRUCTIVE,
    async ({ signatureId }) => {
      console.error('Deleting sender signature..', { signatureId });
      await postmarkRequest(`/senders/${encodeURIComponent(signatureId)}`, { auth: 'account', method: 'DELETE' });
      console.error('Sender signature deleted');
      return {
        content: [{
          type: "text",
          text: `Sender signature ${signatureId} deleted successfully.`
        }]
      };
    }
  );
}

main().catch((error) => {
  console.error('[ERROR] Failed to start server: ', error.message);
  process.exit(1);
});
