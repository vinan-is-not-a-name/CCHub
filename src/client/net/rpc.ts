import type { Connection } from '../connection.js';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';

type RpcResultMessage = Extract<ServerMessage, { requestId: string }>;
type RpcResultType = RpcResultMessage['type'];

interface PendingEntry {
  resultType: RpcResultType;
  resolve: (result: RpcResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RpcRequestOptions {
  /** Reject after this many ms with an `rpc timeout` Error. Default 10_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Pair requestId-bearing requests with their result message into a single
 * Promise. Rejects on timeout, on `cancelAll`, and clears the pending Map so
 * we don't leak entries after a disconnect.
 */
export class Rpc {
  private pending = new Map<string, PendingEntry>();

  constructor(private conn: Connection<ServerMessage, ClientMessage>) {}

  request<T extends RpcResultType>(
    resultType: T,
    build: (requestId: string) => ClientMessage,
    opts: RpcRequestOptions = {},
  ): Promise<Extract<RpcResultMessage, { type: T }>> {
    return new Promise<Extract<RpcResultMessage, { type: T }>>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`rpc timeout: ${resultType}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resultType,
        resolve: resolve as (r: RpcResultMessage) => void,
        reject,
        timer,
      });
      this.conn.send(build(requestId));
    });
  }

  /** Feed every server message; returns true if it was matched & dispatched. */
  dispatch(msg: ServerMessage): boolean {
    if (!('requestId' in msg) || typeof msg.requestId !== 'string') return false;
    const entry = this.pending.get(msg.requestId);
    if (!entry || entry.resultType !== msg.type) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(msg.requestId);
    entry.resolve(msg);
    return true;
  }

  /**
   * Reject every in-flight request. Called by Connection on close so callers
   * see a deterministic error instead of a forever-pending Promise (and the
   * pending Map doesn't leak entries across reconnects).
   */
  cancelAll(reason: string): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Test hook — exposes the live pending count. */
  pendingSize(): number { return this.pending.size; }
}

export type { RpcResultType };
