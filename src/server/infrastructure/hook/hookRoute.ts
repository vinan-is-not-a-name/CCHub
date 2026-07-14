import type { FastifyRequest, FastifyReply } from 'fastify';

/** Returns true if the session is known (exists in the manager). */
export type HookSessionLookup = (sessionId: string) => boolean;

export interface HookRouteDeps {
  lookup: HookSessionLookup;
  authToken: string;
  dispatch: (sessionId: string, kind: string) => void;
}

/**
 * Factory for the POST /hook/:sessionId route handler.
 *
 * Auth: Bearer token must match `authToken` (unless authToken is empty, which
 * means auth is disabled — dev/test mode).
 *
 * Kind: the CC hook event name (`user_prompt_submit`, `notification`, `stop`,
 * `stop_failure`). It may arrive either as a `?kind=` query param or as a
 * `{ kind }` JSON body. The query form exists because on Windows the hook runs
 * under PowerShell/cmd, where escaping a JSON body's inner quotes is unreliable;
 * a query param sidesteps all shell quoting. We don't validate the specific
 * value — future CC versions may add new events and we don't want to reject them.
 */
export function makeHookRoute(deps: HookRouteDeps) {
  return async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
    if (deps.authToken) {
      const header = request.headers.authorization;
      if (header !== `Bearer ${deps.authToken}`) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }
    }

    const { sessionId } = request.params;
    if (!deps.lookup(sessionId)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    const body = request.body as Record<string, unknown> | undefined;
    const query = request.query as { kind?: string } | undefined;
    const queryKind = typeof query?.kind === 'string' ? query.kind : '';
    const bodyKind = body && typeof body === 'object' && typeof body.kind === 'string' ? body.kind : '';
    const kind = queryKind || bodyKind;
    if (!kind) {
      reply.code(400).send({ error: 'missing or invalid "kind" field' });
      return;
    }

    deps.dispatch(sessionId, kind);
    reply.code(200).send({ ok: true });
  };
}
