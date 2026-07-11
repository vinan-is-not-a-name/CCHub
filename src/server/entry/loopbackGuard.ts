import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/** True for the three shapes Node.js reports for the loopback interface:
 * IPv4 `127.0.0.1`, IPv6 `::1`, and the IPv4-mapped IPv6 form
 * `::ffff:127.0.0.1` that shows up on dual-stack sockets. Missing address
 * (which happens for some synthetic requests during tests) is treated as
 * non-loopback so the guard errs safe. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** HTML page returned to non-loopback callers. Small, no external assets so
 * the guard is self-contained; explains the deployment model in one paragraph
 * and gives users the SSH tunnel recipe inline. Uses the exact heading users
 * can search for so they land on this page and know what to do next. */
export function loopbackGuardHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cchub — local access only</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1.5rem; color: #202124; line-height: 1.55; }
  h1 { font-size: 1.3rem; margin-bottom: 0.5rem; }
  code, pre { font-family: ui-monospace, "SF Mono", Consolas, monospace; background: #f1f3f4; padding: 0.15em 0.35em; border-radius: 4px; }
  pre { padding: 0.75rem 1rem; overflow: auto; }
  p { margin: 0.8rem 0; }
  a { color: #1a73e8; }
</style></head>
<body>
<h1>cchub refuses non-loopback requests</h1>
<p><strong>cchub is a single-user, local-first tool.</strong> The server only accepts requests coming from the same machine it's running on (<code>127.0.0.1</code> / <code>::1</code>). It is not designed to be exposed on a LAN or the internet — there are no user accounts, and every client that reaches the port can drive every session and read every stored credential.</p>
<p>To use cchub from another device (phone, tablet, laptop), open an SSH tunnel from that device to the server, then browse to the tunneled port locally:</p>
<pre>ssh -L 3000:127.0.0.1:3000 you@your-workstation
# then in the client browser:
http://127.0.0.1:3000</pre>
<p>The request arrives at the server as <code>127.0.0.1</code> and the guard lets it through. SSH handles authentication and transport encryption for you; no port needs to be exposed.</p>
</body></html>
`;
}

/** Register a Fastify onRequest hook that rejects every non-loopback caller
 * with 403 + the explanatory HTML page. Must run before any route handler so
 * WS upgrades, static files, image endpoints — every entry point — go through
 * one place. cchub is single-user local-first; enforcing that at the socket
 * makes accidentally SaaS-ifying it hard on purpose. */
export function registerLoopbackGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isLoopbackAddress(request.socket.remoteAddress)) return;
    // Log at info (not warn/error) — this is expected traffic when someone
    // scans the port or forgets the tunnel; it's not a bug in the server.
    request.log.info({ remoteAddress: request.socket.remoteAddress, url: request.url },
      'rejecting non-loopback request');
    reply
      .code(403)
      .header('content-type', 'text/html; charset=utf-8')
      .send(loopbackGuardHtml());
  });
}
