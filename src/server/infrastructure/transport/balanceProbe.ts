import { requestText } from './httpRequest.js';

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

/** Attempts per request on timeout/connection failure. Measured on a host
 * with ~40-50% single-connection success to these endpoints: 2 attempts lift a
 * site to roughly 75%, 3 to ~85%, at the cost of one extra timeout window in
 * the worst case (the two path variants still race in parallel). */
const QUERY_ATTEMPTS = 3;

export interface BalanceRaw {
  /** Total quota; null when the payloads are unparseable. */
  limit: number | null;
  /** Used quota; null when unparseable. */
  used: number | null;
  /** limit - used; null when either side is missing. */
  remain: number | null;
  /** ISO-4217 currency the numbers are in. NewAPI relays report USD;
   * DeepSeek's official endpoint reports CNY; subscription gateways that bill
   * in credits carry the unit name here (display-only). */
  currency: string;
  /** Per-window usage percentages, shown in place of an amount for
   * subscription gateways (opencode's rolling/weekly/monthly, GLM's 5-hour
   * and weekly windows). The client formats them. */
  quota?: Array<{ window: string; percent: number }>;
}

export interface BalanceProbeParams {
  baseUrl: string;
  /** The site's secret: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY — whichever
   * the profile carries. A profile with only an API key is a normal setup
   * (Anthropic-native gateways take x-api-key and no bearer token), so the
   * balance layer must not require one field specifically. */
  credential: string;
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
  const limit = pickNumber(subscription, 'hard_limit_usd') ?? pickNumber(subscription, 'system_hard_limit_usd') ?? 0;
  const used = (pickNumber(usage, 'total_usage') ?? 0) / divisor;
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

/** Read a money field that vendors send as either a JSON number or a decimal
 * STRING (StepFun and SiliconFlow both use strings; the official DeepSeek
 * endpoint does too). Returns null for anything that is not a finite number in
 * either spelling — never NaN, which would poison the arithmetic downstream. */
function pickNumber(obj: unknown, key: string): number | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The `data` envelope most of these vendors wrap their payload in, falling
 * back to the body itself when there is none (OpenRouter's shape differs by
 * endpoint, so the caller cannot assume). */
function unwrapData(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return (payload as Record<string, unknown>).data;
  }
  return payload;
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

function hostOf(baseUrl: string): string {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** opencode zen is a subscription gateway: no balance, but usage against
 * rolling / weekly / monthly allowances at GET <base>/v1/usage. */
export function isOpencodeZen(baseUrl: string): boolean {
  return /(^|\.)opencode\.ai$/.test(hostOf(baseUrl));
}

/** GLM Coding Plan (open.bigmodel.cn) reports its subscription quota at
 * GET /api/monitor/usage/quota/limit — credits per window, where limits[]
 * carries `unit: 3` (a 5-hour window) and `unit: 6` (weekly). */
export function isGlmCodingPlan(baseUrl: string): boolean {
  return /(^|\.)bigmodel\.cn$/.test(hostOf(baseUrl));
}

/** Vendors whose own account endpoint we know. Each is matched on HOSTNAME —
 * these APIs only exist on their own service, and a relay proxying the same
 * models under its own domain must stay on the generic path. */
export function isStepfunOfficial(baseUrl: string): boolean {
  return /(^|\.)stepfun\.(com|ai)$/.test(hostOf(baseUrl));
}

export function isSiliconflow(baseUrl: string): boolean {
  return /(^|\.)siliconflow\.(cn|com)$/.test(hostOf(baseUrl));
}

/** The `.cn` host bills in CNY, the `.com` host in USD. */
export function isSiliconflowCn(baseUrl: string): boolean {
  return hostOf(baseUrl).endsWith('siliconflow.cn');
}

export function isOpenrouter(baseUrl: string): boolean {
  return /(^|\.)openrouter\.ai$/.test(hostOf(baseUrl));
}

export function isNovita(baseUrl: string): boolean {
  return /(^|\.)novita\.ai$/.test(hostOf(baseUrl));
}

/** Kimi FOR CODING — the subscription product at api.kimi.com. The Moonshot
 * pay-as-you-go API (api.moonshot.cn) is a different service with no usage
 * endpoint, so it deliberately does not match. */
export function isKimiCoding(baseUrl: string): boolean {
  return /(^|\.)kimi\.com$/.test(hostOf(baseUrl));
}

/** Subscription-window payloads report percentages, not money. */
export function parseOpencodeUsage(payload: unknown): BalanceRaw {
  const usage = (typeof payload === 'object' && payload !== null)
    ? (payload as { usage?: unknown }).usage
    : undefined;
  const quota: Array<{ window: string; percent: number }> = [];
  if (typeof usage === 'object' && usage !== null) {
    for (const window of ['rolling', 'weekly', 'monthly']) {
      const entry = (usage as Record<string, unknown>)[window];
      const percent = (typeof entry === 'object' && entry !== null)
        ? (entry as { percent?: unknown }).percent
        : undefined;
      if (typeof percent === 'number' && Number.isFinite(percent)) quota.push({ window, percent });
    }
  }
  return { limit: null, used: null, remain: null, currency: 'USD', ...(quota.length ? { quota } : {}) };
}

/** GLM Coding Plan payload:
 *   { code: 200, data: { level: "max",
 *       limits: [ { unit: 3, currentValue, usage, remaining, percentage },   // 5h
 *                 { unit: 6, currentValue, usage, remaining, percentage } ] } } // week
 * The weekly window is the headline number (matches the console's plan view);
 * units are a vendor enum, hence the hostname branch. Values are credits, not
 * currency, so `currency` carries the unit name for display. */
export function parseGlmQuota(payload: unknown): BalanceRaw {
  const data = (typeof payload === 'object' && payload !== null)
    ? (payload as { data?: unknown }).data
    : undefined;
  const limits = (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).limits))
    ? (data as { limits: unknown[] }).limits
    : [];
  const pick = (unit: number) => limits.find((l): l is Record<string, unknown> =>
    typeof l === 'object' && l !== null && (l as Record<string, unknown>).unit === unit);
  const weekly = pick(6) ?? (limits[0] as Record<string, unknown> | undefined);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // The window list reports what the payload actually carries — the weekly
  // FALLBACK above feeds the headline numbers only. Reading the windows off
  // the fallback labelled a lone 5-hour entry as both 'weekly' and 'rolling',
  // so the same number showed up twice under two different window names.
  const quota: Array<{ window: string; percent: number }> = [];
  const weeklyPercent = num(pick(6)?.percentage);
  if (weeklyPercent !== null) quota.push({ window: 'weekly', percent: weeklyPercent });
  const fiveHourPercent = num(pick(3)?.percentage);
  if (fiveHourPercent !== null) quota.push({ window: 'rolling', percent: fiveHourPercent });
  return {
    limit: num(weekly?.usage),
    used: num(weekly?.currentValue),
    remain: num(weekly?.remaining),
    currency: 'credits',
    ...(quota.length ? { quota } : {}),
  };
}

/** StepFun's own account endpoint, GET <origin>/v1/accounts:
 *   { object, type, balance, total_cash_balance, total_voucher_balance }
 * No quota concept — `balance` is what is left. */
export function parseStepfunBalance(payload: unknown): BalanceRaw {
  return { limit: null, used: null, remain: pickNumber(payload, 'balance') ?? 0, currency: 'CNY' };
}

/** SiliconFlow, GET <origin>/v1/user/info:
 *   { code, data: { balance, chargeBalance, totalBalance, status } }
 * The `.cn` host bills in CNY, the `.com` host in USD. */
export function parseSiliconflowBalance(payload: unknown, isCn: boolean): BalanceRaw {
  return {
    limit: null,
    used: null,
    remain: pickNumber(unwrapData(payload), 'totalBalance') ?? 0,
    currency: isCn ? 'CNY' : 'USD',
  };
}

/** OpenRouter, GET https://openrouter.ai/api/v1/credits:
 *   { data: { total_credits, total_usage } }
 * The one vendor here that reports a real quota PAIR, so limit and used are
 * both filled and the panel can show a percentage. */
export function parseOpenrouterBalance(payload: unknown): BalanceRaw {
  const data = unwrapData(payload);
  const limit = pickNumber(data, 'total_credits') ?? 0;
  const used = pickNumber(data, 'total_usage') ?? 0;
  return { limit, used, remain: limit - used, currency: 'USD' };
}

/** Novita AI, GET https://api.novita.ai/v3/user/balance:
 *   { availableBalance, cashBalance, creditLimit, outstandingInvoices }
 * Amounts are in 1/10000 USD, so the raw number is scaled before display. */
export function parseNovitaBalance(payload: unknown): BalanceRaw {
  const units = pickNumber(payload, 'availableBalance') ?? 0;
  return { limit: null, used: null, remain: units / 10000, currency: 'USD' };
}

/** Kimi For Coding, GET https://api.kimi.com/coding/v1/usages:
 *   { limits: [ { detail: { limit, remaining, resetTime } } ],   // 5-hour
 *     usage:  { limit, remaining, resetTime } }                  // weekly
 * Subscription windows rather than money, so this reports percentages — the
 * same shape the GLM and opencode branches use. */
export function parseKimiUsage(payload: unknown): BalanceRaw {
  const body = (typeof payload === 'object' && payload !== null) ? payload as Record<string, unknown> : {};
  const quota: Array<{ window: string; percent: number }> = [];
  const percentOf = (node: unknown): number | null => {
    const limit = pickNumber(node, 'limit');
    const remaining = pickNumber(node, 'remaining');
    if (limit === null || limit <= 0 || remaining === null) return null;
    return ((limit - remaining) / limit) * 100;
  };
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const fiveHour = percentOf((limits[0] as Record<string, unknown> | undefined)?.detail);
  if (fiveHour !== null) quota.push({ window: 'rolling', percent: fiveHour });
  const weekly = percentOf(body.usage);
  if (weekly !== null) quota.push({ window: 'weekly', percent: weekly });
  return { limit: null, used: null, remain: null, currency: 'USD', ...(quota.length ? { quota } : {}) };
}

/** Probe one site's balance. Official DeepSeek goes to /user/balance (its own
 * endpoint); everything else is treated as a NewAPI relay: bare path first,
 * then the /v1 variant (some relays mount the dashboard only there), exactly
 * like the reference dashboard. Throws with a short human-readable message on
 * failure.
 *
 * Both variants are attempted IN PARALLEL and the first success wins: they are
 * one-shot requests against hosts whose single-connection success rate can be
 * well under 50% (transient routing/GFW flakiness), so serialising them would
 * double the wall-clock of a failure without improving the odds. Each request
 * also retries internally (see fetchJson). */
export async function querySiteBalance(params: BalanceProbeParams): Promise<BalanceRaw> {
  const base = normalizeBaseUrl(params.baseUrl);
  const origin = new URL(base).origin;
  // Vendor endpoints, matched by hostname: balance APIs are NOT standardised,
  // so each of these only exists on its own service.
  if (isDeepseekOfficial(base)) {
    // /user/balance lives at the API root, NOT under the anthropic-compat
    // path the cc profile points at (…/anthropic) — appending to `base` would
    // hit a 404.
    const paths = ['/user/balance', '/v1/user/balance'];
    return firstSuccessful(paths.map((p) => async () => parseDeepseekBalance(await fetchJson(`${origin}${p}`, params.credential))));
  }
  if (isOpencodeZen(base)) {
    // Subscription gateway: usage windows, no balance. /v1/usage hangs off the
    // profile's own base path (…/zen/go).
    const paths = [`${base}/v1/usage`, `${origin}/v1/usage`];
    return firstSuccessful(paths.map((p) => async () => parseOpencodeUsage(await fetchJson(p, params.credential))));
  }
  if (isGlmCodingPlan(base)) {
    // A non-plan key still answers HTTP 200, with {code:500, msg:"…no coding
    // plan…"}. Surface that message rather than a row of empty numbers.
    const paths = ['/api/monitor/usage/quota/limit'];
    return firstSuccessful(paths.map((p) => async () => {
      const payload = await fetchJson(`${origin}${p}`, params.credential);
      const raw = parseGlmQuota(payload);
      if (raw.remain === null && !raw.quota) {
        const msg = (typeof payload === 'object' && payload !== null)
          ? (payload as Record<string, unknown>).msg
          : undefined;
        throw new Error(typeof msg === 'string' && msg ? msg : 'unexpected quota payload');
      }
      return raw;
    }));
  }
  // Vendors whose account endpoint lives on the same host as the profile but at
  // its own path, so `origin` + the path is the whole URL.
  if (isStepfunOfficial(base)) {
    return firstSuccessful(['/v1/accounts'].map((p) => async () =>
      parseStepfunBalance(await fetchJson(`${origin}${p}`, params.credential))));
  }
  if (isSiliconflow(base)) {
    const isCn = isSiliconflowCn(base);
    return firstSuccessful(['/v1/user/info'].map((p) => async () =>
      parseSiliconflowBalance(await fetchJson(`${origin}${p}`, params.credential), isCn)));
  }
  if (isOpenrouter(base)) {
    return firstSuccessful(['/api/v1/credits'].map((p) => async () =>
      parseOpenrouterBalance(await fetchJson(`${origin}${p}`, params.credential))));
  }
  if (isNovita(base)) {
    return firstSuccessful(['/v3/user/balance'].map((p) => async () =>
      parseNovitaBalance(await fetchJson(`${origin}${p}`, params.credential))));
  }
  if (isKimiCoding(base)) {
    return firstSuccessful(['/coding/v1/usages'].map((p) => async () =>
      parseKimiUsage(await fetchJson(`${origin}${p}`, params.credential))));
  }
  // Everything else: the one-api / new-api relay convention (bare path first,
  // then the /v1 variant — some relays mount the dashboard only there).
  const paths = [
    '/dashboard/billing/subscription',
    '/v1/dashboard/billing/subscription',
  ];
  return firstSuccessful(paths.map((subPath) => {
    const usePath = subPath.replace('/subscription', '/usage');
    return async () => {
      const [sub, use] = await Promise.all([
        fetchJson(`${base}${subPath}`, params.credential),
        fetchJson(`${base}${usePath}`, params.credential),
      ]);
      return parseBalanceResponse(sub, use);
    };
  }));
}

/** Race the attempts, resolve with the first success, reject with the last
 * error once all have failed. (Promise.any would do the same but loses the
 * "last error" detail we surface in the UI.) */
async function firstSuccessful<T>(attempts: Array<() => Promise<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = attempts.length;
    let lastError: unknown = new Error('no attempt');
    for (const attempt of attempts) {
      attempt().then(resolve, (error) => {
        lastError = error;
        pending -= 1;
        if (pending === 0) reject(lastError instanceof Error ? lastError : new Error(String(lastError)));
      });
    }
  });
}

async function fetchJson(url: string, credential: string): Promise<unknown> {
  // requestText, not fetch: every attempt opens a fresh connection
  // (agent:false) so a long-running process can't keep reusing sockets a
  // proxy/VPN killed, and transient connection failures are retried — see
  // httpRequest.ts.
  //
  // Both auth headers are sent: NewAPI-style relays read `Authorization:
  // Bearer`, Anthropic-native gateways read `x-api-key` and reject the other.
  // Each server ignores the header it does not use, so one request works for
  // either secret style.
  const res = await requestText(url, {
    headers: { authorization: `Bearer ${credential}`, 'x-api-key': credential },
    timeoutMs: QUERY_TIMEOUT_MS,
    attempts: QUERY_ATTEMPTS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${res.status} ${res.text.slice(0, 120)}`);
  }
  let data: unknown = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`non-JSON response from ${url}`);
  }
  return data;
}
