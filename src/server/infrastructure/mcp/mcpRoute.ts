import type { FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MCP_SERVER_NAME, FEED_IMAGE_TOOL } from '../../../shared/mcp.js';
import { SessionFeeder } from './feedImage.js';

/**
 * Builds the Fastify handler for `POST /mcp/:sessionId`. The caller's identity
 * is the `:sessionId` path segment — welded into the per-session config URL we
 * handed that session, so the agent never self-reports it and the UUID doubles
 * as the capability token. The feed_image tool takes only `{ path }`; it always
 * feeds the calling session (no cross-session target) and always submits.
 *
 * A fresh stateless McpServer + transport is built per request
 * (sessionIdGenerator: undefined, enableJsonResponse: true) and torn down when
 * the response closes — no MCP session state is retained between calls.
 */
export function makeMcpRouteHandler(feeder: SessionFeeder) {
  return async function handle(
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { sessionId } = request.params;

    const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
    server.registerTool(
      FEED_IMAGE_TOOL,
      {
        description:
          '**ASYNC TOOL — STOP after calling. The image is delivered as the NEXT ' +
          'user-turn message, NOT in this tool\'s result.** The result you get back ' +
          'is only an ack saying the paste was queued.\n\n' +
          'Attach a local image into THIS Claude Code session so you can see it. ' +
          'Pass the absolute path to a png/jpg/jpeg/gif/webp file; it is pasted and ' +
          'submitted automatically. Use it to view a screenshot you just produced ' +
          '(e.g. a rendered UI) and continue working from what you see.\n\n' +
          'How to use correctly:\n' +
          '1. Call feed_image with an absolute path.\n' +
          '2. You will receive "Image fed to session: <path>" — this is an ACK, NOT ' +
          'the image. Do not act on it.\n' +
          '3. End your turn. Do not reason, plan, or call other tools.\n' +
          '4. The image arrives as a separate user-turn message. Resume work then.\n\n' +
          'Treat the ack the same way you would treat handing control back to the ' +
          'user. Welded to THIS session via the request URL — there is no parameter ' +
          'to feed another session. To feed a different session, the agent running ' +
          'inside that session must call its own per-session feed_image.',
        inputSchema: { path: z.string().describe('Absolute path to the image file to attach.') },
      },
      async ({ path }) => {
        try {
          await feeder.feed(sessionId, path);
          return { content: [{ type: 'text' as const, text: `Image fed to session: ${path}` }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `feed_image failed: ${message}` }], isError: true };
        }
      },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // Fastify must release the response so the transport can own it directly.
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };
}
