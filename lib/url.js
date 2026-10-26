/**
 * @file lib/url.js
 * @description Request URL resolution for the Postmark MCP server.
 *
 * Kept separate from index.js so the origin guard can be unit-tested
 * independently of the server runtime.
 */

/**
 * Resolves a postmarkRequest path to a full URL on the given API base.
 * Paths starting with a single '/' are prefixed with the base; absolute URLs
 * are accepted only if they start with `${base}/`. Everything else throws:
 * non-strings, other hosts, and '//host' (concatenation would keep it on the
 * base host, but it reads as a protocol-relative URL to another one).
 */
export function resolvePostmarkUrl(path, base) {
  if (typeof path !== 'string') throw new Error(`Refusing non-string request path (${typeof path})`);
  if (path.startsWith('/') && !path.startsWith('//')) return `${base}${path}`;
  if (path.startsWith(`${base}/`)) return path;
  throw new Error(`Refusing non-Postmark URL: ${path}`);
}
