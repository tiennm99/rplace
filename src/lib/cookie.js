/**
 * Minimal cookie helpers — no external dependency.
 * Used to issue and read the opaque rplace_id rate-limit identity cookie.
 */

/**
 * Parse a Cookie header into a Map<name, value>. Tolerant of missing header,
 * malformed pairs, and surrounding whitespace.
 * @param {string|null|undefined} header
 * @returns {Map<string, string>}
 */
export function parseCookie(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}

/**
 * Format a Set-Cookie header value.
 * @param {string} name
 * @param {string} value
 * @param {object} [opts]
 * @param {boolean} [opts.httpOnly]
 * @param {boolean} [opts.secure]
 * @param {'Strict'|'Lax'|'None'} [opts.sameSite]
 * @param {string} [opts.path]
 * @param {number} [opts.maxAge] — seconds
 * @returns {string}
 */
export function formatSetCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}
