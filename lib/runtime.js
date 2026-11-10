/**
 * @file lib/runtime.js
 * @description Node.js runtime and request-encoding checks for the Postmark MCP server.
 *
 * Kept separate from index.js so the checks can be unit-tested
 * independently of the server runtime.
 */

const ADVISORY_URL = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';

// First patched release per supported line for CVE-2026-111497 (Brotli decoder RCE).
const BROTLI_FIXED = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
// Majors after 26 are assumed to ship with the fix, prereleases included; they postdate it.
const NEWEST_FIXED_MAJOR = 26;

/** Encodings postmarkRequest accepts. Never br (CVE-2026-111497). */
export const ACCEPT_ENCODING = 'gzip, deflate';

/**
 * Returns true when the given Node.js version (e.g. "22.23.4" or "v22.23.4")
 * carries Node's Brotli decoder fix. Unrecognised versions, lines that never
 * received the fix (odd-numbered and end-of-life majors) and prereleases on a
 * fixed line return false.
 */
export function hasBrotliFix(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(version));
  if (!m) return false;
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  if (major > NEWEST_FIXED_MAJOR) return true;
  const fixed = BROTLI_FIXED[major];
  if (!fixed || m[4]) return false;
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]);
}

/**
 * Startup warning lines for the running Node.js, or [] when there is nothing to say.
 * Node's fix patches its bundled Brotli, so a build linked against the system
 * libbrotli (node_shared_brotli, e.g. Homebrew) also needs that library patched,
 * whatever its Node version.
 */
export function brotliRuntimeWarnings({ node, execPath, sharedBrotli, brotli }) {
  const lines = [];
  if (!hasBrotliFix(node)) {
    lines.push(
      `[WARN] Node.js ${node} (${execPath}) is affected by CVE-2026-111497 (Brotli decoder RCE).`,
      '  → This server does not request Brotli, but the runtime itself stays vulnerable until it is upgraded.',
      `  → Upgrade that Node.js to 22.23.4+, 24.22.1+ or 26.12.1+ (Node 20, 23 and 25 never got the fix): ${ADVISORY_URL}`,
    );
  }
  if (sharedBrotli) {
    lines.push(
      `[WARN] Node.js at ${execPath} uses the system Brotli library (${brotli ?? 'unknown version'}), not its bundled copy.`,
      '  → The Node.js version alone does not cover CVE-2026-111497 here; apply your OS or package manager\'s brotli security update too.',
    );
  }
  return lines;
}

/**
 * Caller headers as a plain object with any Accept-Encoding (whatever its case)
 * replaced by ACCEPT_ENCODING. Accepts a plain object, a Headers instance, an array of
 * [name, value] pairs, or nothing.
 */
export function withAcceptEncoding(headers) {
  const entries = headers instanceof Headers ? [...headers.entries()]
    : Array.isArray(headers) ? headers
    : Object.entries(headers ?? {});
  return {
    ...Object.fromEntries(entries.filter(([k]) => k.toLowerCase() !== 'accept-encoding')),
    'Accept-Encoding': ACCEPT_ENCODING,
  };
}
