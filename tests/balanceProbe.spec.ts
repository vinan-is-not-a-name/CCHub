import { test, expect } from '@playwright/test';
import {
  parseBalanceResponse,
  parseDeepseekBalance,
  normalizeBaseUrl,
  isOfficialAnthropic,
  isDeepseekOfficial,
  USAGE_DIVISOR,
} from '../src/server/infrastructure/transport/balanceProbe.js';
import {
  groupBalanceSites,
  previewKey,
  sortBalanceSites,
  probeAllSites,
  BalanceSiteLast,
} from '../src/server/application/balance.js';
import type { AnthropicEnvProfile, BalanceSiteView } from '../src/shared/protocol.js';

/**
 * Balance parsing / dedup / ordering — the server-side pure logic behind the
 * topbar balance dropdown. Network probing is not tested here (a live relay
 * is not a fixture); the parsing, grouping and sorting rules are.
 *
 * The one behaviour that pins the feature's shape: balance is a property of
 * (baseUrl, authToken), NOT of a preset — several presets sharing one relay
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

test.describe('groupBalanceSites', () => {
  test('same baseUrl + authToken collapse into one group listing every preset', () => {
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

  test('profiles without baseUrl or authToken are skipped', () => {
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
    { baseUrl: 'https://api.ikuncode.cc', authToken: 'sk-AAAAAAAA', presetNames: ['A'] },
    { baseUrl: 'https://api.ikuncode.cc', authToken: 'sk-BBBBBBBB', presetNames: ['B'] },
  ];
  const prevCache = new Map<string, BalanceSiteLast>([
    ['https://api.ikuncode.cc|sk-AAAAAAAA', { remain: 55, limit: 100, used: 45, currency: 'USD', at: 1000 }],
    ['https://api.ikuncode.cc|sk-BBBBBBBB', { remain: 80, limit: 100, used: 20, currency: 'USD', at: 1500 }],
  ]);

  test('a failing key keeps ITS OWN stale balance, not the other key on the same site', async () => {
    const query = async (p: { authToken: string }) => {
      if (p.authToken === 'sk-AAAAAAAA') throw new Error('boom');
      return { remain: 80, limit: 100, used: 20, currency: 'USD' };
    };
    const sites = await probeAllSites(groups, 4, prevCache, query as never);
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
    const sites = await probeAllSites(groups, 4, prevCache, query as never);
    for (const site of sites) {
      expect(site.remain).toBe(null);
      expect(site.stale).toBeUndefined(); // no prior success yet → not stale
      expect(site.error).toContain('down');
    }
  });

  test('a key that succeeds UPDATES its own cache entry', async () => {
    const query = async (p: { authToken: string }) => {
      if (p.authToken === 'sk-AAAAAAAA') throw new Error('hmm');
      return { remain: 90, limit: 100, used: 10, currency: 'USD' };
    };
    const cache = new Map(prevCache);
    await probeAllSites(groups, 4, cache, query as never);
    expect(cache.get('https://api.ikuncode.cc|sk-BBBBBBBB')!.remain).toBe(90);
    expect(cache.get('https://api.ikuncode.cc|sk-AAAAAAAA')!.remain).toBe(55); // unchanged
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
