export const CSP = "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const PERMISSIONS_POLICY = 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()';

export function securityHeaders(headers, secure) {
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
  return headers;
}

export function withSecurityHeaders(response, secure) {
  const out = new Response(response.body, response);
  securityHeaders(out.headers, secure);
  return out;
}
