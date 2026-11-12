export const CSP = "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const ACTIVITY_CSP = "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors https://www.yapin.gg https://yapin.gg https://www.yapper.website https://yapper.website; base-uri 'none'; form-action 'none'";

export const PERMISSIONS_POLICY = 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()';

export function isActivityPath(pathname) {
  return pathname === '/activity' || String(pathname).startsWith('/activity/');
}

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

export function activityHeaders(headers, secure) {
  headers.set('Content-Security-Policy', ACTIVITY_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  headers.delete('X-Frame-Options');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
  else headers.delete('Strict-Transport-Security');
  return headers;
}

export function withSecurityHeaders(response, secure, pathname = '') {
  const out = new Response(response.body, response);
  if (isActivityPath(pathname)) activityHeaders(out.headers, secure);
  else securityHeaders(out.headers, secure);
  return out;
}
