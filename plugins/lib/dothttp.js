/**
 * dothttp — tiny HTTP primitives for the dot's event surface.
 *
 * Same constraints as dotstore: Node builtins only, never throw on bad input,
 * and every function is pure or stream-local so it can be unit-tested without
 * a running web server. Rendering helpers escape ALL interpolated data — the
 * journal may carry attacker-supplied webhook payloads, and the dashboard is
 * served back to the operator's browser.
 */

/** Read a request body with a hard byte cap; overflow destroys the socket. */
export async function readBody(req, limitBytes) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        return { ok: false, error: 'too-large', text: '' };
      }
      chunks.push(chunk);
    }
    return { ok: true, error: null, text: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), text: '' };
  }
}

/** Parse a request URL into pathname + flat query map (last value wins). */
export function parseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl ?? '/', 'http://dot.local');
  } catch {
    return { pathname: '/', query: {} };
  }
  const query = {};
  for (const [key, value] of parsed.searchParams) query[key] = value;
  return { pathname: parsed.pathname.replace(/\/+$/, '') || '/', query };
}

/**
 * Gate a request when a shared secret is configured. `null` secret means the
 * surface is open (the loopback-only default bind is the boundary). Accepts
 * either the `x-dot-secret` header or a `?secret=` query parameter so dumb
 * senders (cron + curl) work without header support.
 */
export function checkSecret(secret, req, query) {
  if (secret === null) return true;
  const header = req.headers ? req.headers['x-dot-secret'] : undefined;
  const presented = typeof header === 'string' ? header : query?.secret;
  return presented === secret;
}

export function sendJson(res, code, value) {
  const text = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

export function sendHtml(res, code, html) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** First `max` chars of a stringified field, or ''. */
export function clip(value, max = 300) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}
