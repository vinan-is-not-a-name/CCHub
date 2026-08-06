/**
 * Relay-site balance probe for the topbar balance dropdown.
 *
 * NewAPI / one-api style relays expose the OpenAI-compatible billing endpoints
 * `/dashboard/billing/subscription` (total quota) and `/dashboard/billing/usage`
 * (usage so far). Both return USD *cents* for `total_usage`, so usage is scaled
 * by USAGE_DIVISOR; the quota (`hard_limit_usd` / `system_hard_limit_usd`) is
 * already in dollars. The two `/v1/...` variants exist because some relays
 * mount the dashboard only under /v1. This mirrors the reference dashboard at
 * llm-api-console/index.html — same paths, same field names, same divisor.
 *
 * parseBalanceResponse is a pure function so the parsing rules are unit-tested
 * without network (see tests/balanceProbe.spec.ts).
 */

export const USAGE_DIVISOR = 100;

const QUERY_TIMEOUT_MS = 6000;

export interface BalanceRaw {
  /** Total quota; null when the payloads are unparseable. */
  limit: number | null;
  /** Used quota; null when unparseable. */
  used: number | null;
  /** limit - used; null when either side is missing. */
  remain: number | null;
  /** ISO-4217 currency the numbers are in. NewAPI relays report USD;
   * DeepSeek's official endpoint reports CNY. */
  currency: string;
}

export interface BalanceProbeParams {
  baseUrl: string;
  authToken: string;
}

/** The subscription payloads are untyped JSON — validate defensively and never
 * let a weird shape (missing fields, strings, HTML error page) throw or
 * produce NaN. A relay that returns no quota at all still yields
 * `{ limit: 0, used: 0, remain: 0 }` — the dashboard shows "$0.00", honest
 * about "this site reports no quota", rather than a phantom error. */
export function parseBalanceResponse(
  subscription: unknown,
  usage: unknown,
  divisor = USAGE_DIVISOR,
): BalanceRaw {
  const limit = pickUsd(subscription, 'hard_limit_usd') ?? pickUsd(subscription, 'system_hard_limit_usd') ?? 0;
  const used = (pickUsd(usage, 'total_usage') ?? 0) / divisor;
  return { limit, used, remain: limit - used, currency: 'USD' };
}

/** DeepSeek's official OpenAI-compatible API has its own balance endpoint,
 * GET /user/balance, which NewAPI's /dashboard/billing does not exist on (that
 * 404 is what started this branch). Response shape, measured 2026-08-06 with a
 * live key:
 *   { "is_available": true,
 *     "balance_infos": [{ "currency": "CNY", "total_balance": "18.46",
 *                         "granted_balance": "0.00", "topped_up_balance": "18.46" }] }
 * There is no quota concept — only what remains — so limit/used stay null and
 * remain carries the total. `total_balance` is a decimal string, hence the
 * String→Number coercion. */
export function parseDeepseekBalance(payload: unknown): BalanceRaw {
  const infos = (typeof payload === 'object' && payload !== null && Array.isArray((payload as Record<string, unknown>).balance_infos))
    ? (payload as { balance_infos: unknown[] }).balance_infos
    : [];
  let remain: number | null = 0;
  let currency = 'CNY';
  for (const info of infos) {
    if (typeof info !== 'object' || info === null) continue;
    const rec = info as Record<string, unknown>;
    const total = typeof rec.total_balance === 'string' ? Number(rec.total_balance) : NaN;
    if (Number.isFinite(total)) remain += total;
    if (typeof rec.currency === 'string') currency = rec.currency;
  }
  return { limit: null, used: null, remain, currency };
}

function pickUsd(obj: unknown, key: string): number | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/** Strip trailing slashes so the same host with/without a slash groups as one
 * site in the client-side dedup. */
export function normalizeBaseUrl(url: string): string {
  return String(url).trim().replace(/\/+$/, '');
}

/** The official Anthropic API has no balance endpoint — skip it rather than
 * surface a 404 page as a per-site error. Matches on the hostname so a relay
 * that happens to serve an `/anthropic` *path* still gets probed. */
export function isOfficialAnthropic(baseUrl: string): boolean {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(normalizeBaseUrl(baseUrl)).hostname);
  } catch {
    return false;
  }
}

/** Official DeepSeek (api.deepseek.com) has no /dashboard/billing — its own
 * /user/balance endpoint carries the balance instead. Matched on hostname so a
 * relay proxying DeepSeek models under its own domain is not affected. */
export function isDeepseekOfficial(baseUrl: string): boolean {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Probe one site's balance. Official DeepSeek goes to /user/balance (its own
 * endpoint); everything else is treated as a NewAPI relay: bare path first,
 * then the /v1 variant (some relays mount the dashboard only there), exactly
 * like the reference dashboard. Throws with a short human-readable message on
 * failure. */
export async function querySiteBalance(params: BalanceProbeParams): Promise<BalanceRaw> {
  const base = normalizeBaseUrl(params.baseUrl);
  if (isDeepseekOfficial(base)) {
    // /user/balance lives at the API root, NOT under the anthropic-compat
    // path the cc profile points at (…/anthropic) — appending to `base` would
    // hit a 404. Build from the origin instead.
    const origin = new URL(base).origin;
    const paths = ['/user/balance', '/v1/user/balance'];
    let lastError: unknown;
    for (const p of paths) {
      try {
        return parseDeepseekBalance(await fetchJson(`${origin}${p}`, params.authToken));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  const paths = [
    '/dashboard/billing/subscription',
    '/v1/dashboard/billing/subscription',
  ];
  let lastError: unknown;
  for (const subPath of paths) {
    const usePath = subPath.replace('/subscription', '/usage');
    try {
      const [sub, use] = await Promise.all([
        fetchJson(`${base}${subPath}`, params.authToken),
        fetchJson(`${base}${usePath}`, params.authToken),
      ]);
      return parseBalanceResponse(sub, use);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${text.slice(0, 120)}`);
  }
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}`);
  }
  return data;
}
