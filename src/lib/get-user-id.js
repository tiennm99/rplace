/**
 * Extract a user identifier from the request.
 * Uses CF-Connecting-IP header (provided by Cloudflare).
 * @param {Request} request
 * @returns {string} user id prefixed with "anon:"
 */
export function getUserId(request) {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // Simple hash for privacy
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash + ip.charCodeAt(i)) | 0;
  }
  return `anon:${(hash >>> 0).toString(36)}`;
}
