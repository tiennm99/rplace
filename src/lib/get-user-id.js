/**
 * Extract a user identifier from the request.
 * Uses IP address hash for anonymous users.
 * @param {Request} request
 * @returns {string} user id prefixed with "anon:" or "auth:"
 */
export function getUserId(request) {
  // Extract IP from Vercel/proxy headers
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : '127.0.0.1';

  // Simple hash for privacy (not crypto-grade, just for keying)
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash + ip.charCodeAt(i)) | 0;
  }
  return `anon:${Math.abs(hash).toString(36)}`;
}
