import { requestText, HttpTextOptions, HttpTextResponse } from './httpRequest.js';

const TEST_TIMEOUT = 8000;

export interface ProfileProbeParams {
  baseUrl: string;
  /** Bearer-style secret (ANTHROPIC_AUTH_TOKEN). Optional — relays may only
   * accept the x-api-key style instead. */
  authToken?: string;
  /** x-api-key-style secret (ANTHROPIC_API_KEY). Optional. */
  apiKey?: string;
  model: string;
}

/** Injectable for tests, same shape as the `query` parameter of
 * probeAllSites — the request this probe makes IS the thing under test, so the
 * test has to be able to see it without a network. */
export type ProbeRequest = (url: string, opts: HttpTextOptions) => Promise<HttpTextResponse>;

/**
 * Test a profile by sending the request Claude Code itself would send.
 *
 * Claude Code speaks exactly one protocol: Anthropic Messages, POSTed to
 * `<ANTHROPIC_BASE_URL>/v1/messages`. It has no OpenAI mode, so a gateway that
 * serves `/v1/chat/completions` but not `/v1/messages` cannot back a session
 * no matter what its model list says — and probing the OpenAI endpoint would
 * report that gateway green while every real session fails.
 *
 * That was a real false green: this probe used to guess the protocol from the
 * URL (`/\/anthropic(\/|$)/` → messages, else chat/completions), so
 * `https://api.commandcode.ai/provider` was probed at `/v1/chat/completions`
 * with a Bearer header — which that host answers 200 for its OSS models —
 * while cc's actual `POST /provider/v1/messages` came back
 * `400 … Use /provider/v1/chat/completions for OpenAI and OSS models.`
 *
 * Auth headers mirror cc as well: it sends `x-api-key` for ANTHROPIC_API_KEY
 * and `Authorization: Bearer` for ANTHROPIC_AUTH_TOKEN, both when both are
 * set. Sending only one of them would hide a profile whose second secret the
 * gateway rejects.
 */
export async function probeProfileConnection(
  params: ProfileProbeParams,
  request: ProbeRequest = requestText,
): Promise<void> {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (params.apiKey) headers['x-api-key'] = params.apiKey;
  if (params.authToken) headers.authorization = `Bearer ${params.authToken}`;
  const res = await request(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: stripContextSuffix(params.model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    timeoutMs: TEST_TIMEOUT,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${res.status} ${probeErrorMessage(res.text)}`);
  }
}

/** Claude Code accepts a `<model>[1m]` suffix meaning "1M context" and strips
 * it before the request goes out. The profile stores the suffixed form (13 of
 * the 20 profiles in the author's config do), so probing the raw string asks
 * the gateway for a model that does not exist — `503 No available channel for
 * model deepseek-v4-pro[1m]` — and reports a working profile as broken.
 *
 * Matched case-sensitively: `[1m]` is how it is written everywhere it appears,
 * and stripping a literal `[1M]` that cc passes through would trade this false
 * red for a false green. */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, '');
}

/** Relay errors arrive in several shapes: Anthropic and OpenAI both use
 * `{error:{message}}`, some relays use `{error:"…"}`, and a misconfigured
 * gateway answers with HTML. Show the sentence when there is one — the useful
 * half of `400 {"type":"error","error":{"type":"invalid_request_error",
 * "message":"Model … is not supported on this endpoint. Use …"}}` is the
 * message, and the Test button prints this string verbatim. */
function probeErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = pickMessage(parsed.error) ?? (typeof parsed.message === 'string' ? parsed.message : undefined);
    if (message) return message.slice(0, 300);
  } catch { /* not JSON — fall through to the raw body */ }
  return text.slice(0, 300);
}

function pickMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
