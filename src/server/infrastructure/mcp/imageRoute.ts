import type { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { statSync } from 'fs';
import { extname } from 'path';
import { FEED_IMAGE_EXTENSIONS } from '../../../shared/mcp.js';

/** A session's image registry as seen by the route. ManagedSession satisfies
 * this structurally (its `getImagePath` is the one method we need); kept narrow
 * so tests can fake it. */
export interface ImageLookup {
  get(sessionId: string): { getImagePath(index1Based: number): string | undefined } | undefined;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Build the Fastify handler for `GET /image/:sessionId/:index`. The browser
 * clicks a `[Image #...]` chip rendered into a session's terminal, JS counts
 * which lifetime-occurrence that chip is, and fetches it here. The path's
 * `:sessionId` is the same per-session capability token used by the MCP route
 * (welded into the URL we handed that session), so a request can only resolve
 * images recorded against THAT session. Cross-session reads structurally cannot
 * be expressed in the URL. */
export function makeImageRouteHandler(lookup: ImageLookup) {
  return function handle(
    request: FastifyRequest<{ Params: { sessionId: string; index: string } }>,
    reply: FastifyReply,
  ): FastifyReply {
    const { sessionId, index } = request.params;
    const session = lookup.get(sessionId);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const n = Number.parseInt(index, 10);
    const imagePath = session.getImagePath(n);
    if (!imagePath) return reply.code(404).send({ error: 'image not found' });
    let stat;
    try { stat = statSync(imagePath); } catch {
      return reply.code(410).send({ error: 'image file no longer on disk' });
    }
    if (!stat.isFile()) {
      return reply.code(410).send({ error: 'image path is not a file' });
    }
    const ext = extname(imagePath).slice(1).toLowerCase();
    // Defence in depth — paths only enter via the feeder, which already
    // whitelists extensions. Re-check so a stray `recordImage` call elsewhere
    // can never trick the route into serving an unrelated file type.
    if (!FEED_IMAGE_EXTENSIONS.includes(ext as (typeof FEED_IMAGE_EXTENSIONS)[number])) {
      return reply.code(415).send({ error: 'unsupported image type' });
    }
    return reply
      .code(200)
      .header('Content-Type', MIME[ext])
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'private, max-age=3600')
      // Belt-and-braces: paths are already extension-whitelisted upstream,
      // but nosniff instructs the browser to trust the Content-Type header
      // even if the file bytes look like something else (e.g. an HTML-y
      // PNG that a naive browser could sniff into text/html and execute).
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(imagePath));
  };
}
