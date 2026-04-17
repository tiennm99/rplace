/**
 * Extract a user identifier from the request.
 * Uses CF-Connecting-IP header (provided by Cloudflare, cannot be spoofed).
 * Returns SHA-256 hex (truncated to 16 chars) — collision-resistant for rate-limit buckets.
 * @param {Request} request
 * @returns {Promise<string>} user id prefixed with "anon:"
 */
export async function getUserId(request) {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) {
    // No CF-Connecting-IP means dev/local or misconfig; bucket all such traffic together.
    console.warn('cf-connecting-ip missing — falling back to shared dev bucket');
    return 'anon:dev';
  }

  const data = new TextEncoder().encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `anon:${hex}`;
}
