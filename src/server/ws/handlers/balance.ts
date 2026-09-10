import { ClientMessage } from '../../../shared/protocol.js';
import { BalanceLastCache, cachedViews, groupBalanceSites, probeAllSites, sortBalanceSites } from '../../application/balance.js';
import { WsCtx } from '../connection.js';

type BalanceMessage = Extract<ClientMessage, { type: 'balance.query' }>;

/** Probe every registered profile's relay-site balance and reply with the
 * deduplicated, balance-sorted result. Per-site failures surface as `error`
 * rows (keeping the prior balance when one exists) rather than failing the
 * whole probe — probeAllSites never rejects on a bad site; the catch below
 * is only a last-resort guard against a programming error taking the
 * dropdown down.
 *
 * Two frames: when the process-wide cache has anything to show, an immediate
 * `final: false` frame renders the last-known balances (stale, with their
 * age) while the real probe runs — a page refresh used to blank the panel
 * until the probe finished, which is slow and, with a dead relay, purely
 * negative. The probe's result follows as the `final: true` frame. */
export function handleBalanceMessage(ctx: WsCtx, msg: BalanceMessage): void {
  const groups = groupBalanceSites(ctx.store.listProfiles());
  const cache: BalanceLastCache = ctx.getRecentBalanceCache?.() ?? new Map();
  const at = Date.now();
  const cached = cachedViews(groups, cache, at);
  if (cached.some((view) => view.remain !== null)) {
    ctx.send({ type: 'balance.result', requestId: msg.requestId, sites: sortBalanceSites(cached), final: false });
  }
  probeAllSites(groups, undefined, cache)
    .then((sites) => ctx.send({ type: 'balance.result', requestId: msg.requestId, sites, final: true }))
    .catch(() => ctx.send({ type: 'balance.result', requestId: msg.requestId, sites: [], final: true }));
}
