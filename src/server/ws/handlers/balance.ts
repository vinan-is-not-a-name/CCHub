import { ClientMessage } from '../../../shared/protocol.js';
import { groupBalanceSites, probeAllSites, BalanceSiteLast } from '../../application/balance.js';
import { WsCtx } from '../connection.js';

type BalanceMessage = Extract<ClientMessage, { type: 'balance.query' }>;

/** Probe every registered profile's relay-site balance and reply with the
 * deduplicated, balance-sorted result. Per-site failures surface as `error`
 * rows (keeping the prior balance when one exists) rather than failing the
 * whole probe — probeAllSites never rejects on a bad site; the catch below
 * is only a last-resort guard against a programming error taking the
 * dropdown down. */
export function handleBalanceMessage(ctx: WsCtx, msg: BalanceMessage): void {
  const groups = groupBalanceSites(ctx.store.listProfiles());
  const cache = ctx.getRecentBalanceCache?.() ?? new Map<string, BalanceSiteLast>();
  probeAllSites(groups, undefined, cache)
    .then((sites) => {
      ctx.saveRecentBalanceCache?.(cache);
      ctx.send({ type: 'balance.result', requestId: msg.requestId, sites });
    })
    .catch(() => ctx.send({ type: 'balance.result', requestId: msg.requestId, sites: [] }));
}
