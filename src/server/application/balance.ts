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

/** Probe every distinct site, bounded concurrency. A failing site becomes a
 * row with `error` rather than taking the whole response down — one dead
 * relay must not blank the panel. Official Anthropic endpoints are skipped
 * with error 'unsupported' (they have no balance API). */
export async function probeAllSites(
  groups: BalanceSiteGroup[],
  concurrency = BALANCE_CONCURRENCY,
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
        const raw = await querySiteBalance({ baseUrl: group.baseUrl, authToken: group.authToken });
        views[i] = toView(group, raw, at);
      } catch (error) {
        views[i] = toView(
          group,
          EMPTY_RAW,
          at,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, groups.length)) }, worker));
  return sortBalanceSites(views);
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

function toView(group: BalanceSiteGroup, raw: BalanceRaw, at: number, error?: string): BalanceSiteView {
  return {
    baseUrl: group.baseUrl,
    keyPreview: previewKey(group.authToken),
    presetNames: group.presetNames,
    remain: raw.remain,
    limit: raw.limit,
    used: raw.used,
    currency: raw.currency,
    ...(error ? { error } : {}),
    at,
  };
}
