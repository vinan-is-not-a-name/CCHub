/**
 * Balance aggregation for the topbar dropdown.
 *
 * Balance is a property of (baseUrl, authToken) — NOT of a provider preset.
 * Presets are just name+model wrappers around the same pair, so several of
 * them can share one relay site and must collapse into a single row (queried
 * once, listed together). groupBalanceSites is a pure function over profiles
 * so the dedup rules are unit-testable without network.
 */

import { AnthropicEnvProfile, BalanceSiteView } from '../../shared/protocol.js';
import {
  BalanceRaw,
  isOfficialAnthropic,
  normalizeBaseUrl,
  querySiteBalance,
} from '../infrastructure/transport/balanceProbe.js';

/** One distinct relay site after grouping. `authToken` stays server-side. */
export interface BalanceSiteGroup {
  baseUrl: string;
  authToken: string;
  presetNames: string[];
}

/** Group every profile that carries a baseUrl + authToken by the
 * (normalized baseUrl, authToken) pair, preserving config order per group. */
export function groupBalanceSites(profiles: AnthropicEnvProfile[]): BalanceSiteGroup[] {
  const byKey = new Map<string, BalanceSiteGroup>();
  for (const profile of profiles) {
    const baseUrl = profile.env.ANTHROPIC_BASE_URL;
    const authToken = profile.env.ANTHROPIC_AUTH_TOKEN;
    if (!baseUrl || !authToken) continue;
    const key = normalizeBaseUrl(baseUrl) + '|' + authToken;
    let group = byKey.get(key);
    if (!group) {
      group = { baseUrl: normalizeBaseUrl(baseUrl), authToken, presetNames: [] };
      byKey.set(key, group);
    }
    group.presetNames.push(profile.name);
  }
  return [...byKey.values()];
}

/** Mask a token the same way SafeAnthropicEnvProfile does — the balance row
 * shows the site's key only as a stub, never the secret. */
export function previewKey(token: string): string {
  if (token.length <= 8) return '********';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export const BALANCE_CONCURRENCY = 4;

const EMPTY_RAW: BalanceRaw = { limit: null, used: null, remain: null, currency: 'USD' };

/** Last-known balance for one distinct site. Keyed by the (normalized
 * baseUrl, authToken) pair — the SAME site probed with DIFFERENT keys is two
 * different groups and must not share a stale value (that was the
 * "same host, different key pollution" bug: a failing key A showed key B's
 * balance because the cache was keyed by baseUrl alone). */
export interface BalanceSiteLast {
  remain: number | null;
  limit: number | null;
  used: number | null;
  currency: string;
  at: number;
}

export type BalanceLastCache = Map<string, BalanceSiteLast>;

const groupKey = (g: BalanceSiteGroup) => normalizeBaseUrl(g.baseUrl) + '|' + g.authToken;

/** Probe every distinct site, bounded concurrency. A failing site becomes a
 * row with `error` rather than taking the whole response down — one dead
 * relay must not blank the panel. Official Anthropic endpoints are skipped
 * with error 'unsupported' (they have no balance API).
 *
 * `prev` is the previous successful results keyed by baseUrl — when a site
 * fails this round, its row keeps the old `remain` and is marked `stale`
 * (plus the failure `error`) instead of showing a blank "failed" cell, so
 * an intermittent relay never blanks a known balance. Sites that newly
 * appear (no prev entry) simply fail as before. */
export async function probeAllSites(
  groups: BalanceSiteGroup[],
  concurrency = BALANCE_CONCURRENCY,
  prev: BalanceLastCache = new Map(),
  query: typeof querySiteBalance = querySiteBalance,
): Promise<BalanceSiteView[]> {
  const at = Date.now();
  const views: BalanceSiteView[] = new Array(groups.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      const group = groups[i];
      if (isOfficialAnthropic(group.baseUrl)) {
        views[i] = toView(group, EMPTY_RAW, at, 'unsupported');
        continue;
      }
      try {
        const raw = await query({ baseUrl: group.baseUrl, authToken: group.authToken });
        const view = toView(group, raw, at);
        prev.set(groupKey(group), lastOf(view));
        views[i] = view;
      } catch (error) {
        views[i] = toView(
          group,
          EMPTY_RAW,
          at,
          error instanceof Error ? error.message : String(error),
          prev.get(groupKey(group)),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, groups.length)) }, worker));
  return sortBalanceSites(views);
}

function lastOf(view: BalanceSiteView): BalanceSiteLast {
  return { remain: view.remain, limit: view.limit, used: view.used, currency: view.currency, at: view.at };
}

/** Views built from the cache alone, for the immediate frame a fresh client
 * gets while the real probe runs. Cached sites show their last-known balance
 * marked stale (with the age the client renders); uncached sites carry
 * `error: 'pending'` so the row reads "…" instead of a failure. */
export function cachedViews(groups: BalanceSiteGroup[], cache: BalanceLastCache, at: number): BalanceSiteView[] {
  return groups.map((group) => {
    const base = {
      baseUrl: group.baseUrl,
      keyPreview: previewKey(group.authToken),
      presetNames: group.presetNames,
      limit: null as number | null,
      used: null as number | null,
      remain: null as number | null,
      currency: 'USD',
    };
    const last = cache.get(groupKey(group));
    if (last && last.remain != null) {
      return {
        ...base,
        remain: last.remain,
        limit: last.limit,
        used: last.used,
        currency: last.currency,
        stale: true,
        at: last.at,
      };
    }
    return { ...base, error: 'pending', at };
  });
}

/** Remaining balance descending; failures (remain null) sink to the bottom,
 * ties broken by baseUrl so the ordering is deterministic across refreshes. */
export function sortBalanceSites(sites: BalanceSiteView[]): BalanceSiteView[] {
  return [...sites].sort((a, b) => {
    const ra = a.remain ?? -Infinity;
    const rb = b.remain ?? -Infinity;
    if (ra !== rb) return rb - ra;
    return a.baseUrl.localeCompare(b.baseUrl);
  });
}

function toView(group: BalanceSiteGroup, raw: BalanceRaw, at: number, error?: string, last?: BalanceSiteLast): BalanceSiteView {
  // A failing site with a previous successful balance keeps showing the old
  // numbers, marked stale (the error rides in `error` for the hover/tooltip).
  // The probe time (`at`) stays at the PREVIOUS successful probe so the
  // client can show "5 min ago" against the stale value.
  const stale = error !== undefined && last?.remain != null;
  return {
    baseUrl: group.baseUrl,
    keyPreview: previewKey(group.authToken),
    presetNames: group.presetNames,
    remain: stale ? last!.remain : raw.remain,
    limit: stale ? last!.limit : raw.limit,
    used: stale ? last!.used : raw.used,
    currency: stale ? last!.currency : raw.currency,
    ...(error ? { error } : {}),
    ...(stale ? { stale: true } : {}),
    at: stale ? last!.at : at,
  };
}
