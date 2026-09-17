import { test, expect } from '@playwright/test';
import { probeProfileConnection, stripContextSuffix } from '../src/server/infrastructure/transport/profileProbe.js';
import type { HttpTextOptions, HttpTextResponse } from '../src/server/infrastructure/transport/httpRequest.js';

/**
 * The connection-test button behind a profile card. What it has to get right
 * is not "does this URL answer" — it is "will a Claude Code session started
 * with this profile work", which means the probe must send the request cc
 * sends and read the answer the same way.
 *
 * Two measured false verdicts pin that:
 *  - FALSE GREEN: commandcode's Provider API answers `/v1/chat/completions`
 *    200 for its OSS models but `400 … not supported on this endpoint` on
 *    `/v1/messages`, the only endpoint cc speaks. Probing by URL shape
 *    (`/anthropic` present?) sent the probe to the OpenAI endpoint and
 *    reported green while every session failed.
 *  - FALSE RED: cc strips a `[1m]` suffix off the model; probing the raw
 *    string asked relays for `deepseek-v4-pro[1m]` and got
 *    `503 No available channel for model deepseek-v4-pro[1m]` on profiles
 *    that work.
 */

interface Call {
  url: string;
  opts: HttpTextOptions;
}

function recording(response: Partial<HttpTextResponse> = {}) {
  const calls: Call[] = [];
  const request = async (url: string, opts: HttpTextOptions): Promise<HttpTextResponse> => {
    calls.push({ url, opts });
    return { status: 200, text: '{}', ...response };
  };
  return { calls, request };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(call.opts.body ?? '{}') as Record<string, unknown>;
}

test.describe('probeProfileConnection — sends what cc sends', () => {
  test('POSTs /v1/messages even when the base URL has no /anthropic in it', async () => {
    // The commandcode shape: a gateway whose path says nothing about protocol.
    // cc still posts to <base>/v1/messages — so the probe must too.
    const { calls, request } = recording();
    await probeProfileConnection(
      { baseUrl: 'https://api.commandcode.ai/provider', apiKey: 'k', model: 'deepseek/deepseek-v4.1-flash' },
      request,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.commandcode.ai/provider/v1/messages');
  });

  test('a trailing slash on the base URL does not double up', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev///', apiKey: 'k', model: 'm' }, request);
    expect(calls[0].url).toBe('https://api.relay.dev/v1/messages');
  });

  test('an API-key profile sends x-api-key and no Authorization', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev', apiKey: 'key-1', model: 'm' }, request);
    expect(calls[0].opts.headers?.['x-api-key']).toBe('key-1');
    expect(calls[0].opts.headers?.authorization).toBeUndefined();
  });

  test('an auth-token profile sends Bearer and no x-api-key', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev', authToken: 'tok-1', model: 'm' }, request);
    expect(calls[0].opts.headers?.authorization).toBe('Bearer tok-1');
    expect(calls[0].opts.headers?.['x-api-key']).toBeUndefined();
  });

  test('both secrets on one profile send both headers, like cc', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev', authToken: 'tok-1', apiKey: 'key-1', model: 'm' }, request);
    expect(calls[0].opts.headers?.authorization).toBe('Bearer tok-1');
    expect(calls[0].opts.headers?.['x-api-key']).toBe('key-1');
  });

  test('the model is sent with the [1m] suffix cc would have stripped', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev', authToken: 't', model: 'deepseek-v4-pro[1m]' }, request);
    expect(body(calls[0]).model).toBe('deepseek-v4-pro');
  });

  test('the request is an Anthropic Messages body', async () => {
    const { calls, request } = recording();
    await probeProfileConnection({ baseUrl: 'https://api.relay.dev', authToken: 't', model: 'm' }, request);
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers?.['anthropic-version']).toBe('2023-06-01');
    const payload = body(calls[0]);
    expect(payload.max_tokens).toBe(1);
    expect(payload.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // The OpenAI shape cc never sends.
    expect(payload).not.toHaveProperty('stream');
  });
});

test.describe('probeProfileConnection — reading the answer', () => {
  test('2xx resolves', async () => {
    const { request } = recording({ status: 200, text: '{"content":[]}' });
    await expect(probeProfileConnection({ baseUrl: 'https://r.dev', apiKey: 'k', model: 'm' }, request)).resolves.toBeUndefined();
  });

  test('the vendor sentence is surfaced, not the surrounding JSON', async () => {
    // Verbatim commandcode answer — the whole point is that the button shows
    // the sentence naming the fix, not a 300-char JSON blob.
    const { request } = recording({
      status: 400,
      text: '{"type":"error","error":{"type":"invalid_request_error","message":"Model \\"deepseek/deepseek-v4.1-flash\\" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models."}}',
    });
    await expect(probeProfileConnection({ baseUrl: 'https://r.dev', apiKey: 'k', model: 'm' }, request))
      .rejects.toThrow(/^400 Model "deepseek\/deepseek-v4\.1-flash" is not supported on this endpoint\./);
  });

  test('a non-JSON body (HTML error page) still surfaces as text', async () => {
    const { request } = recording({ status: 502, text: '<html><body>Bad Gateway</body></html>' });
    await expect(probeProfileConnection({ baseUrl: 'https://r.dev', apiKey: 'k', model: 'm' }, request))
      .rejects.toThrow(/^502 <html>/);
  });

  test('a JSON body without a message field falls back to the raw text', async () => {
    const { request } = recording({ status: 500, text: '{"ok":false}' });
    await expect(probeProfileConnection({ baseUrl: 'https://r.dev', apiKey: 'k', model: 'm' }, request))
      .rejects.toThrow(/^500 \{"ok":false\}/);
  });
});

test.describe('stripContextSuffix', () => {
  test('removes the documented suffix only at the end', () => {
    expect(stripContextSuffix('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
    expect(stripContextSuffix('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(stripContextSuffix('[1m]deepseek')).toBe('[1m]deepseek');
  });
});
