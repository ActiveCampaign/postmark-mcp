/**
 * @file lib/runtime.js
 * @description Node.js runtime checks for the Postmark MCP server.
 *
 * Kept separate from index.js so the version check can be unit-tested
 * independently of the server runtime.
 */

// First patched release per supported line for CVE-2026-111497 (Brotli decoder RCE).
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
const BROTLI_FIXED = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
// Majors after 26 are assumed to ship with the fix; they postdate it.
const NEWEST_FIXED_MAJOR = 26;

/**
 * Returns true when the given Node.js version (e.g. "22.23.4" or "v22.23.4")
 * carries the Brotli decoder fix. Unrecognised versions and lines that never
 * received the fix (odd-numbered and end-of-life majors) return false.
 */
export function hasBrotliFix(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (major > NEWEST_FIXED_MAJOR) return true;
  const fixed = BROTLI_FIXED[major];
  if (!fixed) return false;
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]);
}
