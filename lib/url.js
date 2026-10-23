/**
 * @file lib/url.js
 * @description Request URL resolution for the Postmark MCP server.
 *
 * Kept separate from index.js so the origin guard can be unit-tested
 * independently of the server runtime.
 */

/**
 * Resolves a postmarkRequest path to a full URL on the given API base.
 * Paths starting with '/' are prefixed with the base; absolute URLs are
 * accepted only if already under the base origin. Anything else (another
 * host, a protocol-relative '//host') throws, so the server token is never
 * sent to a non-Postmark host.
 */
export function resolvePostmarkUrl(path, base) {
  if (path.startsWith('/') && !path.startsWith('//')) return `${base}${path}`;
  if (path.startsWith(`${base}/`)) return path;
  throw new Error(`Refusing non-Postmark URL: ${path}`);
}
