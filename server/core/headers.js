/**
 * Security headers on every answer from the web app (pages, API, the live stream, /health).
 *
 * The client is built by Vite into same-origin files: scripts (the theme boot is public/theme-boot.js, not inline),
 * stylesheets, fonts (self-hosted in client/src/theme/fonts) and logos (bundled from logos/; small ones may be inlined
 * as data: URLs). Nothing is ever loaded from another origin, and the only cross-origin thing on the page is the
 * coffee link, a plain link that CSP doesn't govern. React sets style props through the CSSOM, which CSP allows
 * without 'unsafe-inline'.
 *
 * Referrer-Policy is no-referrer: a board's URL holds its code, the key to it, and no other site may be told it.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': [
    'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'geolocation=()', 'gyroscope=()',
    'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'publickey-credentials-get=()', 'usb=()',
    'browsing-topics=()',
  ].join(', '),
  // For browsers that predate frame-ancestors.
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function securityHeaders(req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}
