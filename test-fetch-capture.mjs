/**
 * Test-only preload (node --import ./test-fetch-capture.mjs index.js).
 * Replaces global fetch so the real server's outgoing requests are recorded
 * to FETCH_CAPTURE_FILE (one JSON line per request) instead of hitting the network.
 * The capture includes request headers, server token included: use only with a test token.
 */
import { appendFileSync } from 'fs';

globalThis.fetch = async (url, init = {}) => {
  appendFileSync(process.env.FETCH_CAPTURE_FILE, JSON.stringify({ url: String(url), headers: init.headers }) + '\n');
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
