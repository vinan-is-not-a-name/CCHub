import { test, expect } from '@playwright/test';
import {
  parseBalanceResponse,
  parseDeepseekBalance,
  parseOpencodeUsage,
  parseGlmQuota,
  normalizeBaseUrl,
  isOfficialAnthropic,
  isDeepseekOfficial,
  isOpencodeZen,
  isGlmCodingPlan,
  parseStepfunBalance,
  parseSiliconflowBalance,
  parseOpenrouterBalance,
  parseNovitaBalance,
  parseKimiUsage,
  isStepfunOfficial,
  isSiliconflow,
  isSiliconflowCn,
  isOpenrouter,
  isNovita,
  isKimiCoding,
  USAGE_DIVISOR,
} from '../src/server/infrastructure/transport/balanceProbe.js';
import {
  groupBalanceSites,
  previewKey,
  sortBalanceSites,
  probeAllSites,
  cachedViews,
  BalanceSiteLast,
} from '../src/server/application/balance.js';
import type { AnthropicEnvProfile, BalanceSiteView } from '../src/shared/protocol.js';

/**
 * Balance parsing / dedup / ordering — the server-side pure logic behind the
 * topbar balance dropdown. Network probing is not tested here (a live relay
 * is not a fixture); the parsing, grouping and sorting rules are.
 *
 * The one behaviour that pins the feature's shape: balance is a property of
 * (baseUrl, credential), NOT of a preset — several presets sharing one relay
 * site must collapse into a single row queried once.
 */

function profile(id: string, name: string, env: Record<string, string>): AnthropicEnvProfile {
  return { id, name, env, createdAt: 0, updatedAt: 0 };
}

function view(partial: Partial<BalanceSiteView> & { baseUrl: string }): BalanceSiteView {
  return {
    keyPreview: 'sk-a...z',
    presetNames: ['p'],
    remain: null,
    limit: null,
    used: null,
    currency: 'USD',
    at: 0,
    ...partial,
  };
}

test.describe('parseBalanceResponse', () => {
  test('hard_limit_usd minus total_usage/100', () => {
    const r = parseBalanceResponse({ hard_limit_usd: 50 }, { total_usage: 2500 });
    expect(r.limit).toBe(50);
    expect(r.used).toBe(25);
    expect(r.remain).toBe(25);
  });

  test('falls back to system_hard_limit_usd when hard_limit_usd is absent', () => {
    const r = parseBalanceResponse({ system_hard_limit_usd: 12.5 }, { total_usage: 0 });
    expect(r.limit).toBe(12.5);
  });

  test('usage divisor is 100 by default (NewAPI reports cents)', () => {
    expect(USAGE_DIVISOR).toBe(100);
  });

  test('custom divisor scales used', () => {
    const r = parseBalanceResponse({ hard_limit_usd: 10 }, { total_usage: 500 }, 1000);
    expect(r.used).toBe(0.5);
  });

  test('missing quota fields parse as zero, not NaN', () => {
    const r = parseBalanceResponse({}, {});
    expect(r.limit).toBe(0);
    expect(r.used).toBe(0);
    expect(r.remain).toBe(0);
    expect(Number.isNaN(r.remain)).toBe(false);
  });

  test('non-object payloads (HTML error page, null) are safe', () => {
    const r = parseBalanceResponse('<!DOCTYPE html>', null);
    expect(r.limit).toBe(0);
    expect(Number.isNaN(r.remain)).toBe(false);
  });
});

test.describe('vendor endpoints — hostname-matched', () => {
  test('opencode / GLM / deepseek hosts are recognised, lookalikes are not', () => {
    expect(isOpencodeZen('https://opencode.ai/zen/go')).toBe(true);
    expect(isOpencodeZen('https://fake-opencode.ai')).toBe(false);
    expect(isGlmCodingPlan('https://open.bigmodel.cn/api/anthropic')).toBe(true);
    expect(isGlmCodingPlan('https://bigmodel.cn.evil.example')).toBe(false);
    expect(isDeepseekOfficial('https://api.deepseek.com/anthropic')).toBe(true);
    expect(isDeepseekOfficial('https://api.deepseek.com.evil.example')).toBe(false);
  });

  test('a relay proxying the same models stays on the generic path', () => {
    expect(isDeepseekOfficial('https://api.ikuncode.cc')).toBe(false);
    expect(isOpencodeZen('https://api.ikuncode.cc')).toBe(false);
    expect(isGlmCodingPlan('https://api.ikuncode.cc')).toBe(false);
  });
});

test.describe('parseOpencodeUsage', () => {
  test('maps the rolling/weekly/monthly percent windows', () => {
    const raw = parseOpencodeUsage({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: 'x' },
        weekly: { status: 'ok', percent: 11, resetsAt: 'y' },
        monthly: { status: 'ok', percent: 59, resetsAt: 'z' },
      },
    });
    expect(raw.remain).toBe(null);
    expect(raw.quota).toEqual([
      { window: 'rolling', percent: 0 },
      { window: 'weekly', percent: 11 },
      { window: 'monthly', percent: 59 },
    ]);
  });

  test('survives a malformed payload (no quota, no throw)', () => {
    expect(parseOpencodeUsage(null).quota).toBeUndefined();
    expect(parseOpencodeUsage({ usage: { monthly: { percent: 'nope' } } }).quota).toBeUndefined();
  });
});

test.describe('parseGlmQuota', () => {
  const payload = {
    code: 200,
    data: {
      level: 'max',
      limits: [
        { unit: 3, currentValue: 12, usage: 100, remaining: 88, percentage: 12 },
        { unit: 6, currentValue: 340, usage: 2000, remaining: 1660, percentage: 17 },
      ],
    },
  };

  test('weekly window drives remain/limit/used, unit=3 becomes the rolling window', () => {
    const raw = parseGlmQuota(payload);
    expect(raw.remain).toBe(1660);
    expect(raw.limit).toBe(2000);
    expect(raw.used).toBe(340);
    expect(raw.currency).toBe('credits');
    expect(raw.quota).toEqual([
      { window: 'weekly', percent: 17 },
      { window: 'rolling', percent: 12 },
    ]);
  });

  test('a missing weekly window falls back to the first entry', () => {
    const raw = parseGlmQuota({ code: 200, data: { limits: [{ unit: 3, currentValue: 1, usage: 10, remaining: 9, percentage: 10 }] } });
    expect(raw.remain).toBe(9);
    expect(raw.quota).toEqual([{ window: 'rolling', percent: 10 }]);
  });

  test('a business error payload (no coding plan) yields nulls, never NaN', () => {
    const raw = parseGlmQuota({ code: 500, msg: '当前用户不存在coding plan', success: false });
    expect(raw.remain).toBe(null);
    expect(raw.limit).toBe(null);
    expect(raw.quota).toBeUndefined();
  });
});

test.describe('groupBalanceSites', () => {
  test('same baseUrl + credential collapse into one group listing every preset', () => {
    const groups = groupBalanceSites([
      profile('p1', 'Relay Fast', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p2', 'Relay Sonnet', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p3', 'Relay Haiku', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].presetNames).toEqual(['Relay Fast', 'Relay Sonnet', 'Relay Haiku']);
  });

  test('trailing-slash baseUrl variants group as one site', () => {
    const groups = groupBalanceSites([
      profile('p1', 'A', { ANTHROPIC_BASE_URL: 'https://api.relay.dev/', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p2', 'B', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseUrl).toBe('https://api.relay.dev');
  });

  test('same baseUrl with a different token is a different site', () => {
    const groups = groupBalanceSites([
      profile('p1', 'A', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p2', 'B', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-bbb' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  test('a profile with ONLY an api key still forms a site', () => {
    // Anthropic-native gateways take ANTHROPIC_API_KEY (x-api-key) and carry
    // no ANTHROPIC_AUTH_TOKEN at all. Requiring a token silently dropped
    // those sites from the dropdown — the reported "a provider is missing".
    const groups = groupBalanceSites([
      profile('p1', 'byKey A', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_API_KEY: 'sk-key1' }),
      profile('p2', 'byKey B', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_API_KEY: 'sk-key1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].credential).toBe('sk-key1');
    expect(groups[0].presetNames).toEqual(['byKey A', 'byKey B']);
  });

  test('a token and an api key on one site stay distinct (no merge)', () => {
    const groups = groupBalanceSites([
      profile('p1', 'byToken', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p2', 'byKey', { ANTHROPIC_BASE_URL: 'https://api.relay.dev', ANTHROPIC_API_KEY: 'sk-bbb' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  test('profiles without a baseUrl or a credential are skipped', () => {
    const groups = groupBalanceSites([
      profile('p1', 'NoUrl', { ANTHROPIC_AUTH_TOKEN: 'sk-aaa' }),
      profile('p2', 'NoToken', { ANTHROPIC_BASE_URL: 'https://api.relay.dev' }),
      profile('p3', 'Neither', {}),
    ]);
    expect(groups).toHaveLength(0);
  });

  test('groups keep the first-seen profile order', () => {
    const groups = groupBalanceSites([
      profile('p1', 'B Site', { ANTHROPIC_BASE_URL: 'https://b.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-b' }),
      profile('p2', 'A Site', { ANTHROPIC_BASE_URL: 'https://a.relay.dev', ANTHROPIC_AUTH_TOKEN: 'sk-a' }),
    ]);
    expect(groups.map((g) => g.baseUrl)).toEqual(['https://b.relay.dev', 'https://a.relay.dev']);
  });
});

test.describe('previewKey', () => {
  test('long tokens show head + tail', () => {
    expect(previewKey('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('sk-a...3456');
  });

  test('short tokens are fully masked', () => {
    expect(previewKey('sk-1234')).toBe('********');
  });
});

test.describe('probeAllSites — stale cache per key', () => {
  const groups = [
    { baseUrl: 'https://api.ikuncode.cc', credential: 'sk-AAAAAAAA', presetNames: ['A'] },
    { baseUrl: 'https://api.ikuncode.cc', credential: 'sk-BBBBBBBB', presetNames: ['B'] },
  ];
  // A fresh cache per test: probeAllSites WRITES successful results back into
  // the map it is handed, so sharing one instance across tests leaks state
  // (test 1's success made test 2's "never succeeded" site look stale).
  const freshCache = () => new Map<string, BalanceSiteLast>([
    ['https://api.ikuncode.cc|sk-AAAAAAAA', { remain: 55, limit: 100, used: 45, currency: 'USD', at: 1000 }],
    ['https://api.ikuncode.cc|sk-BBBBBBBB', { remain: 80, limit: 100, used: 20, currency: 'USD', at: 1500 }],
  ]);

  test('a failing key keeps ITS OWN stale balance, not the other key on the same site', async () => {
    const query = async (p: { credential: string }) => {
      if (p.credential === 'sk-AAAAAAAA') throw new Error('boom');
      return { remain: 80, limit: 100, used: 20, currency: 'USD' };
    };
    const sites = await probeAllSites(groups, 4, freshCache(), query as never);
    const a = sites.find((s) => s.keyPreview === 'sk-A...AAAA')!;
    const b = sites.find((s) => s.keyPreview === 'sk-B...BBBB')!;
    // A failed → stale with A's own prior balance (55), not B's (80).
    expect(a.remain).toBe(55);
    expect(a.stale).toBe(true);
    expect(a.error).toBe('boom');
    expect(a.at).toBe(1000);
    // B succeeded → fresh 80, no stale flags.
    expect(b.remain).toBe(80);
    expect(b.stale).toBeUndefined();
    expect(b.at).toBeGreaterThan(1500);
  });

  test('sites that never succeeded stay failed (no cross-contamination from another key)', async () => {
    const query = async () => { throw new Error('down'); };
    const emptyCache = new Map<string, BalanceSiteLast>();
    const sites = await probeAllSites(groups, 4, emptyCache, query as never);
    for (const site of sites) {
      expect(site.remain).toBe(null);
      expect(site.stale).toBeUndefined(); // no prior success yet → not stale
      expect(site.error).toContain('down');
    }
  });

  test('a 404 / non-JSON answer is reported as unsupported, not as a raw error', async () => {
    // An unrecognised host (no balance API we know) should read "no balance
    // API on this site" in the panel — not an HTML error page dump.
    const notFound = async () => { throw new Error('404 <!DOCTYPE html>'); };
    const sites404 = await probeAllSites(groups, 4, new Map(), notFound as never);
    for (const site of sites404) expect(site.error).toBe('unsupported');

    const html = async () => { throw new Error('non-JSON response from https://x.dev/usage'); };
    const sitesHtml = await probeAllSites(groups, 4, new Map(), html as never);
    for (const site of sitesHtml) expect(site.error).toBe('unsupported');

    // A timeout is transient, not "unsupported" — it stays raw so the stale
    // value (if any) is what the row shows.
    const timeout = async () => { throw new Error('request timed out after 6000ms'); };
    const sitesTimeout = await probeAllSites(groups, 4, new Map(), timeout as never);
    for (const site of sitesTimeout) expect(site.error).toContain('timed out');
  });

  test('a key that succeeds UPDATES its own cache entry', async () => {
    const query = async (p: { credential: string }) => {
      if (p.credential === 'sk-AAAAAAAA') throw new Error('hmm');
      return { remain: 90, limit: 100, used: 10, currency: 'USD' };
    };
    const cache = freshCache();
    await probeAllSites(groups, 4, cache, query as never);
    expect(cache.get('https://api.ikuncode.cc|sk-BBBBBBBB')!.remain).toBe(90);
    expect(cache.get('https://api.ikuncode.cc|sk-AAAAAAAA')!.remain).toBe(55); // unchanged
  });
});

test.describe('cachedViews — the immediate frame', () => {
  const groups = [
    { baseUrl: 'https://a.dev', credential: 'sk-AAAAAAAA', presetNames: ['A'] },
    { baseUrl: 'https://b.dev', credential: 'sk-BBBBBBBB', presetNames: ['B'] },
  ];

  test('cached site renders its own last value, stale, with the cached age', () => {
    const cache = new Map<string, BalanceSiteLast>([
      ['https://a.dev|sk-AAAAAAAA', { remain: 42, limit: 100, used: 58, currency: 'USD', at: 5000 }],
    ]);
    const views = cachedViews(groups, cache, 9999);
    const a = views.find((v) => v.baseUrl === 'https://a.dev')!;
    expect(a.remain).toBe(42);
    expect(a.stale).toBe(true);
    expect(a.at).toBe(5000); // the cached probe time, not now
    expect(a.error).toBeUndefined();
  });

  test('uncached site is pending, not failed', () => {
    const views = cachedViews(groups, new Map(), 9999);
    for (const view of views) {
      expect(view.remain).toBe(null);
      expect(view.error).toBe('pending');
      expect(view.stale).toBeUndefined();
    }
  });

  test('same host, different key: each cached entry stays its own', () => {
    const sameHost = [
      { baseUrl: 'https://x.dev', credential: 'sk-AAAAAAAA', presetNames: ['A'] },
      { baseUrl: 'https://x.dev', credential: 'sk-BBBBBBBB', presetNames: ['B'] },
    ];
    const cache = new Map<string, BalanceSiteLast>([
      ['https://x.dev|sk-AAAAAAAA', { remain: 11, limit: null, used: null, currency: 'USD', at: 1 }],
    ]);
    const views = cachedViews(sameHost, cache, 9999);
    expect(views.find((v) => v.presetNames[0] === 'A')!.remain).toBe(11);
    expect(views.find((v) => v.presetNames[0] === 'B')!.error).toBe('pending');
  });
});

test.describe('sortBalanceSites', () => {
  test('remaining balance descending', () => {
    const sites = [
      view({ baseUrl: 'https://low.dev', remain: 1 }),
      view({ baseUrl: 'https://high.dev', remain: 90 }),
      view({ baseUrl: 'https://mid.dev', remain: 50 }),
    ];
    expect(sortBalanceSites(sites).map((s) => s.baseUrl)).toEqual([
      'https://high.dev', 'https://mid.dev', 'https://low.dev',
    ]);
  });

  test('failures (remain null) sink below successes', () => {
    const sites = [
      view({ baseUrl: 'https://dead.dev', remain: null, error: '500' }),
      view({ baseUrl: 'https://alive.dev', remain: 2 }),
    ];
    expect(sortBalanceSites(sites).map((s) => s.baseUrl)).toEqual([
      'https://alive.dev', 'https://dead.dev',
    ]);
  });

  test('ties break by baseUrl for deterministic order', () => {
    const sites = [
      view({ baseUrl: 'https://b.dev', remain: 5 }),
      view({ baseUrl: 'https://a.dev', remain: 5 }),
    ];
    expect(sortBalanceSites(sites).map((s) => s.baseUrl)).toEqual(['https://a.dev', 'https://b.dev']);
  });
});

test.describe('parseDeepseekBalance', () => {
  test('official /user/balance payload yields CNY remain, no quota concept', () => {
    const r = parseDeepseekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '18.46', granted_balance: '0.00', topped_up_balance: '18.46' },
      ],
    });
    expect(r.remain).toBe(18.46);
    expect(r.limit).toBeNull();
    expect(r.used).toBeNull();
    expect(r.currency).toBe('CNY');
  });

  test('multiple balance_infos sum up', () => {
    const r = parseDeepseekBalance({
      balance_infos: [
        { currency: 'CNY', total_balance: '1.50' },
        { currency: 'CNY', total_balance: '2.25' },
      ],
    });
    expect(r.remain).toBe(3.75);
  });

  test('non-string total_balance is skipped, not coerced', () => {
    // The live endpoint reports decimal STRINGS; a number here is a shape we
    // haven't seen, so it must not silently feed the sum (a change of payload
    // shape is worth surfacing as a 0 rather than trusting a Number() guess).
    const r = parseDeepseekBalance({
      balance_infos: [{ currency: 'CNY', total_balance: 5 }],
    });
    expect(r.remain).toBe(0);
  });

  test('unparseable payloads degrade to zero, not NaN', () => {
    const r = parseDeepseekBalance('not json');
    expect(r.remain).toBe(0);
    expect(Number.isNaN(r.remain)).toBe(false);
  });
});

// The vendor endpoints below were transcribed from cc-switch's own balance
// service (services/balance.rs, services/coding_plan.rs) rather than guessed,
// so a wrong field name here would be a wrong field name there too.
test.describe('vendor balance parsers', () => {
  test('StepFun reads `balance`, in CNY, with no quota concept', () => {
    const r = parseStepfunBalance({
      object: 'account', type: 'prepaid', balance: 42.5,
      total_cash_balance: 40, total_voucher_balance: 2.5,
    });
    expect(r.remain).toBe(42.5);
    expect(r.limit).toBeNull();
    expect(r.used).toBeNull();
    expect(r.currency).toBe('CNY');
  });

  test('StepFun accepts a decimal string, like the live endpoint sends', () => {
    expect(parseStepfunBalance({ balance: '18.46' }).remain).toBe(18.46);
  });

  test('SiliconFlow reads data.totalBalance and picks the currency from the host', () => {
    const payload = { code: 20000, data: { balance: '1', chargeBalance: '1', totalBalance: '7.25', status: 'ok' } };
    expect(parseSiliconflowBalance(payload, true).remain).toBe(7.25);
    expect(parseSiliconflowBalance(payload, true).currency).toBe('CNY');
    expect(parseSiliconflowBalance(payload, false).currency).toBe('USD');
  });

  test('OpenRouter is the one that reports a real quota pair', () => {
    const r = parseOpenrouterBalance({ data: { total_credits: 20, total_usage: 6.5 } });
    expect(r.limit).toBe(20);
    expect(r.used).toBe(6.5);
    expect(r.remain).toBe(13.5);
    expect(r.currency).toBe('USD');
  });

  test('Novita scales 1/10000-USD units into dollars', () => {
    const r = parseNovitaBalance({ availableBalance: 123456, cashBalance: 100000, creditLimit: 0 });
    expect(r.remain).toBe(12.3456);
    expect(r.currency).toBe('USD');
  });

  test('Kimi reports the 5-hour and weekly windows as percentages', () => {
    const r = parseKimiUsage({
      limits: [{ detail: { limit: 100, remaining: 70, resetTime: 'x' } }],
      usage: { limit: 1000, remaining: 400, resetTime: 'y' },
    });
    expect(r.quota).toEqual([
      { window: 'rolling', percent: 30 },
      { window: 'weekly', percent: 60 },
    ]);
    expect(r.remain).toBeNull();
  });

  test('Kimi survives a payload with neither window', () => {
    expect(parseKimiUsage({}).quota).toBeUndefined();
    expect(parseKimiUsage(null).quota).toBeUndefined();
    // A zero limit would divide by zero — it must be skipped, not turned into
    // NaN or Infinity (both of which would render as garbage in the panel).
    expect(parseKimiUsage({ usage: { limit: 0, remaining: 0 } }).quota).toBeUndefined();
  });

  test('unparseable payloads degrade to zero, never NaN', () => {
    for (const r of [
      parseStepfunBalance('nope'), parseSiliconflowBalance(null, true),
      parseOpenrouterBalance({}), parseNovitaBalance(undefined),
    ]) {
      expect(Number.isNaN(r.remain as number)).toBe(false);
    }
  });
});

test.describe('vendor host detection', () => {
  test('each vendor host is recognised', () => {
    expect(isStepfunOfficial('https://api.stepfun.com/v1')).toBe(true);
    expect(isSiliconflow('https://api.siliconflow.cn')).toBe(true);
    expect(isSiliconflowCn('https://api.siliconflow.cn')).toBe(true);
    expect(isSiliconflowCn('https://api.siliconflow.com')).toBe(false);
    expect(isOpenrouter('https://openrouter.ai/api/v1')).toBe(true);
    expect(isNovita('https://api.novita.ai/v3/openai')).toBe(true);
    expect(isKimiCoding('https://api.kimi.com/coding')).toBe(true);
  });

  test('lookalike hosts are not treated as the vendor', () => {
    // The same anchor the other detectors rely on: a phishing or relay host
    // that merely ENDS in the vendor's name must reach the generic path, not
    // be handed a request with someone else's credential format.
    expect(isOpenrouter('https://openrouter.ai.evil.example')).toBe(false);
    expect(isNovita('https://fake-novita.ai.evil.example')).toBe(false);
    expect(isKimiCoding('https://api.kimi.com.evil.example')).toBe(false);
    expect(isSiliconflow('https://siliconflow.cn.evil.example')).toBe(false);
  });

  test('the Moonshot pay-as-you-go API is not the Kimi coding plan', () => {
    // Same company, different product: api.moonshot.cn has no usage endpoint,
    // so it must fall through to the relay path and report "unsupported".
    expect(isKimiCoding('https://api.moonshot.cn/anthropic')).toBe(false);
  });

  test('a relay serving the same models stays generic', () => {
    for (const host of ['https://api.ikuncode.cc', 'https://token-hub.lol']) {
      expect(isStepfunOfficial(host)).toBe(false);
      expect(isSiliconflow(host)).toBe(false);
      expect(isOpenrouter(host)).toBe(false);
      expect(isNovita(host)).toBe(false);
      expect(isKimiCoding(host)).toBe(false);
    }
  });
});

test.describe('isDeepseekOfficial', () => {
  test('api.deepseek.com is official', () => {
    expect(isDeepseekOfficial('https://api.deepseek.com')).toBe(true);
    expect(isDeepseekOfficial('https://api.deepseek.com/anthropic')).toBe(true);
  });

  test('relays are not affected', () => {
    expect(isDeepseekOfficial('https://relay.deepseek.pro')).toBe(false);
  });

  test('lookalike hosts ending in .deepseek.com are not official', () => {
    // Exact-hostname match exists precisely so fake.deepseek.com isn't routed
    // to the official /user/balance endpoint with a stranger's token.
    expect(isDeepseekOfficial('https://fake.deepseek.com')).toBe(false);
  });
});

test.describe('isOfficialAnthropic', () => {
  test('anthropic.com hosts are skipped', () => {
    expect(isOfficialAnthropic('https://api.anthropic.com')).toBe(true);
    expect(isOfficialAnthropic('https://www.anthropic.com/')).toBe(true);
  });

  test('lookalike hosts ending in anthropic.com are not official', () => {
    // The (^|\.) anchor exists precisely so a phishing host like
    // evilanthropic.com isn't skipped and then silently left un-probed.
    expect(isOfficialAnthropic('https://evilanthropic.com')).toBe(false);
    expect(isOfficialAnthropic('https://notanthropic.com')).toBe(false);
  });

  test('relay hosts are probed even when serving an /anthropic path', () => {
    expect(isOfficialAnthropic('https://api.relay.dev/anthropic')).toBe(false);
  });
});

test.describe('normalizeBaseUrl', () => {
  test('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.relay.dev///')).toBe('https://api.relay.dev');
  });
});
