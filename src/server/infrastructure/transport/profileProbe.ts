const TEST_TIMEOUT = 8000;

export interface ProfileProbeParams {
  baseUrl: string;
  authToken: string;
  model: string;
}

export async function probeProfileConnection(params: ProfileProbeParams): Promise<void> {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');
  if (isAnthropicFormat(baseUrl)) {
    await probeAnthropic(baseUrl, params.authToken, params.model);
  } else {
    await probeOpenAI(baseUrl, params.authToken, params.model);
  }
}

export function isAnthropicFormat(url: string): boolean {
  return /\/anthropic(\/|$)/i.test(url);
}

async function probeOpenAI(baseUrl: string, token: string, model: string): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(TEST_TIMEOUT),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function probeAnthropic(baseUrl: string, token: string, model: string): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(TEST_TIMEOUT),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}
