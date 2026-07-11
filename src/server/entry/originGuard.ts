import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/** True for `Origin` values that correspond to a page cchub itself served —
 * `http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`. Anything else
 * is a browser tab loaded from a different origin, and any request it makes
 * (WS or HTTP) is either CORS-blocked at the fetch layer or, for endpoints
 * we serve, a CSWSH / cross-origin-POST attack we need to refuse ourselves. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // WHATWG URL parses `http://[::1]:3000` with hostname `"[::1]"` — brackets
    // preserved. Compare against both forms so IPv6 loopback works either way.
    const host = u.hostname;
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  } catch {
    return false;
  }
}

/** Register an onRequest hook that rejects browser Cross-Site WebSocket Hijacking
 * attempts before they reach a WS upgrade / MCP / image handler. The socket-level
 * loopback guard is not enough on its own: a page served from evil.example that
 * runs `new WebSocket('ws://127.0.0.1:3000/ws')` still connects from the user's
 * own machine, so `request.socket.remoteAddress` is 127.0.0.1 and the loopback
 * check passes. The browser, however, faithfully sends `Origin: https://evil.example`
 * on the upgrade — this hook is where that gets caught.
 *
 * Requests without an `Origin` header are passed through: curl, native ws
 * clients, `<img>` tag GETs, and same-window navigation don't send one, and
 * CSWSH-style attacks are a browser-only vector. Downstream auth checks
 * (Bearer / query token) still apply for the endpoints that require them. */
export function registerOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    if (isLoopbackOrigin(origin)) return;
    request.log.info({ origin, url: request.url }, 'rejecting non-loopback origin');
    await reply.code(403).send({ error: 'origin not allowed' });
  });
}
