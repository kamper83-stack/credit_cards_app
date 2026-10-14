/**
 * Returns `candidate` only if it is a same-origin, app-relative path (e.g. "/cards?x=1");
 * otherwise `fallback`. Rejects absolute URLs ("https://evil"), protocol-relative ("//evil"),
 * backslash tricks ("/\evil"), control characters, and the auth pages themselves (redirect loops).
 */
export function safeRedirectPath(candidate: unknown, fallback = '/'): string {
  if (typeof candidate !== 'string') return fallback;
  if (candidate.length === 0 || candidate.length > 2048) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  const path = candidate.split(/[?#]/)[0];
  if (path === '/login' || path === '/register') return fallback;
  return candidate;
}
