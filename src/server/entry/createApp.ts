import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ConfigService } from '../domain/config/index.js';
import { SessionManager } from '../application/session.js';
import { handleWs } from '../ws/connection.js';
import { SessionTarget } from '../../shared/protocol.js';
import { SessionFeeder } from '../infrastructure/mcp/feedImage.js';
import { makeMcpRouteHandler } from '../infrastructure/mcp/mcpRoute.js';
import { makeImageRouteHandler } from '../infrastructure/mcp/imageRoute.js';
import { makePasteImageRouteHandler } from '../infrastructure/mcp/pasteImageRoute.js';
import { FEED_IMAGE_MAX_BYTES } from '../../shared/mcp.js';
import { registerLoopbackGuard } from './loopbackGuard.js';
import { registerOriginGuard } from './originGuard.js';
import { MetricsCollector } from '../infrastructure/metrics/metricsCollector.js';
import { makeHookRoute } from '../infrastructure/hook/hookRoute.js';

export interface AppDeps {
  manager: SessionManager;
  store: ConfigService;
  authToken: string;
  defaultTarget: SessionTarget;
  /** When present, the image-feed MCP endpoint is mounted at POST /mcp/:sessionId.
   * Absent → endpoint not registered (feature disabled by the entry security rule). */
  feeder?: SessionFeeder;
  /** Host-resource collector for the topbar pill. Optional so runtime.ts can
   * disable it in test/embedded setups; production wires a real one. Started
   * inside buildApp() so its lifecycle matches the Fastify instance. */
  metrics?: MetricsCollector;
  /** Dispatches Claude Code hook events from POST /hook/:sessionId into the
   * corresponding ManagedSession. Optional for tests that don't mount hooks. */
  dispatchHook?: (sessionId: string, kind: string) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const app = Fastify();
  // Single-user local-first: register before any route so every entry point
  // — static assets, /ws, /mcp/*, /image/*, /paste-image/* — is gated by
  // the same loopback check.
  registerLoopbackGuard(app);
  // Defence-in-depth against browser CSWSH: the loopback check passes for
  // any request originating from 127.0.0.1, including a WS upgrade fired by
  // a page served from a different origin. Only the `Origin` header reveals
  // that, so we gate on it too.
  registerOriginGuard(app);
  await app.register(fastifyStatic, {
    root: resolve(__dirname, '../../client'),
  });
  await app.register(fastifyWebsocket);
  // Default body parser is JSON-only; we need raw bytes for pasted images.
  // Cap to the feed_image size limit so a malicious paste can't OOM the server
  // (the route also re-checks the resulting Buffer length).
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: FEED_IMAGE_MAX_BYTES }, (_req, body, done) => {
    done(null, body);
  });
  if (deps.metrics) deps.metrics.start();
  const handleHook = makeHookRoute({
    lookup: (sessionId) => !!deps.manager.get(sessionId),
    authToken: deps.authToken,
    dispatch: deps.dispatchHook ?? ((sessionId, kind) => deps.manager.get(sessionId)?.emitHook(kind)),
  });
  app.post<{ Params: { sessionId: string } }>('/hook/:sessionId', handleHook);
  app.get('/ws', { websocket: true }, (socket) => {
    handleWs(socket, deps.manager, deps.store, {
      authToken: deps.authToken,
      defaultTarget: deps.defaultTarget,
      metrics: deps.metrics,
    });
  });
  if (deps.feeder) {
    const handle = makeMcpRouteHandler(deps.feeder);
    app.post<{ Params: { sessionId: string } }>('/mcp/:sessionId', (request, reply) => {
      // Mirror the WS auth gate: an empty configured token means no auth; a set
      // token requires a matching Bearer (the value baked into the session's
      // own --mcp-config, so its claude presents it automatically).
      if (deps.authToken) {
        const header = request.headers.authorization;
        if (header !== `Bearer ${deps.authToken}`) {
          reply.code(401).send({ error: 'unauthorized' });
          return reply;
        }
      }
      return handle(request, reply);
    });

    // Browser-side `[Image #N]` chip → /image/:sessionId/:index. Same Bearer
    // auth as /mcp/:sessionId; sessionId in the URL acts as the per-session
    // capability token so a request can only read images recorded against that
    // session. Lookup goes through the manager — there's no separate registry.
    const imageHandle = makeImageRouteHandler({
      get: (id) => deps.manager.get(id),
    });
    app.get<{ Params: { sessionId: string; index: string } }>('/image/:sessionId/:index', (request, reply) => {
      if (deps.authToken) {
        // The browser can't use Authorization on an <img> request, so accept
        // the same token via a `token` query param OR a Bearer header. Token
        // is the session-storage value the WS handshake already proves the
        // user holds; treating it as a capability cookie equivalent.
        const header = request.headers.authorization;
        const queryToken = (request.query as { token?: string } | undefined)?.token;
        const ok = header === `Bearer ${deps.authToken}` || queryToken === deps.authToken;
        if (!ok) {
          reply.code(401).send({ error: 'unauthorized' });
          return reply;
        }
      }
      return imageHandle(request, reply);
    });

    // Browser-side image paste (Ctrl+V / right-click with image blob on the
    // clipboard) → write bytes to a session-scoped tmp file, then route through
    // the same SessionFeeder the MCP `feed_image` tool uses. Bearer-only — no
    // query-param fallback, the client always uses fetch() which can set headers.
    const pasteHandle = makePasteImageRouteHandler(deps.feeder);
    app.post<{ Params: { sessionId: string } }>('/paste-image/:sessionId', (request, reply) => {
      if (deps.authToken) {
        const header = request.headers.authorization;
        if (header !== `Bearer ${deps.authToken}`) {
          reply.code(401).send({ error: 'unauthorized' });
          return reply;
        }
      }
      return pasteHandle(request, reply);
    });
  }
  app.addHook('onClose', async () => {
    deps.metrics?.stop();
    deps.manager.destroyAll();
  });
  return app;
}
