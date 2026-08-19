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

export async function probeProfileConnection(params: ProfileProbeParams): Promise<void> {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');
  if (isAnthropicFormat(baseUrl)) {
    // The Anthropic protocol's canonical header is x-api-key — some relays
    // (e.g. opencode zen) reject `Authorization: Bearer` with 401 "Missing
    // API key" on /messages and only read x-api-key.
    await probeAnthropic(baseUrl, params.apiKey ?? params.authToken, params.model);
  } else {
    // OpenAI-compatible endpoints canonically take Bearer, which is exactly
    // what ANTHROPIC_AUTH_TOKEN produces — fall back to the api key only when
    // no Bearer secret was configured.
    await probeOpenAI(baseUrl, params.authToken ?? params.apiKey, params.model);
  }
}

export function isAnthropicFormat(url: string): boolean {
  return /\/anthropic(\/|$)/i.test(url);
}

async function probeOpenAI(baseUrl: string, token: string | undefined, model: string): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(TEST_TIMEOUT),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function probeAnthropic(baseUrl: string, token: string | undefined, model: string): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-api-key': token } : {}),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(TEST_TIMEOUT),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}
