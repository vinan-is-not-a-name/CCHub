import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import * as dns from 'node:dns';

/**
 * One-shot HTTP text request built on node:http/https instead of fetch.
 *
 * `agent: false` makes every request open a FRESH connection and close it
 * when done — the deliberate opposite of keep-alive. A long-running cc-remote
 * process behind a proxy/VPN (Clash TUN, corporate gateway) accumulates
 * sockets that were silently killed when the upstream path changed; a pooled
 * client keeps reusing them and every request dies at the timeout until the
 * process restarts (observed: a 2-day-old process failing 100% of balance
 * probes while a fresh process on the same host succeeded on the same URLs).
 * Probe traffic is a handful of requests per minute, so per-request
 * connections cost nothing and are immune to that failure mode.
 *
 * `accept-encoding: identity` keeps the body plain (no gzip negotiation);
 * a server that ignores it and gzips anyway is decoded defensively.
 */
export interface HttpTextResponse {
  status: number;
  text: string;
}

export interface HttpTextOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Total attempts on TIMEOUT / connection failure (never on an HTTP status
   * response — a 4xx/5xx is an answer, not a flake). Each attempt is a fresh
   * connection; a short backoff keeps a transient routing blip from eating
   * every try at once. Measured on a host with ~40% single-connection success
   * to these endpoints, 2-3 attempts take a site from coin-flip to reliable. */
  attempts?: number;
}

export async function requestText(url: string, opts: HttpTextOptions): Promise<HttpTextResponse> {
  const attempts = Math.max(1, opts.attempts ?? 1);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestOnce(url, opts);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(150 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CCHUB_PROBE_TRACE=1 logs per-request DNS and total timing. Kept as a
 * debugging aid: on a host with a stalling resolver the timings below are how
 * you tell a name-resolution queue apart from a slow relay. */
const TRACE = process.env.CCHUB_PROBE_TRACE === '1';

/** Resolve A records first, falling back to the system's full lookup (IPv6
 * included) only when no A record exists.
 *
 * Why not the default A+AAAA lookup: on some hosts the AAAA query walks
 * unreachable IPv6 resolvers (measured: fec0:0:0:ffff::1/2 time out after
 * ~25s), and Windows serialises the outstanding queries behind that stall —
 * per-host timings showed 7.5s, then 15s, 22.6s, 28.6s as each subsequent
 * name queued behind the previous timeout. A concurrent probe (which is what
 * the balance refresh is) then loses every request to its timeout, every
 * round, for hours. A-only lookups on the same host resolve in single-digit
 * milliseconds, and every relay we probe has an A record; the fallback keeps
 * IPv6-only hosts working. */
function tracedLookup(hostname: string, options: unknown, callback: unknown): void {
  const t = Date.now();
  const cb = callback as (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
  const done = (err: NodeJS.ErrnoException | null, address: unknown, family: number) => {
    if (TRACE) console.error(`[probe-dns] ${hostname} ${Date.now() - t}ms ${err ? 'ERR ' + (err.code ?? err.message) : String(address)}`);
    cb(err, address, family);
  };
  // Merge family into the CALLER'S options rather than replacing them: node
  // passes `all: true` on some paths and then expects an address ARRAY back.
  // Dropping that flag made every request fail with "Invalid IP address:
  // undefined" (caught by the hostname test — IP-literal URLs skip lookup).
  dns.lookup(hostname, { ...(options as object), family: 4 } as never, (err4, address4, family4) => {
    if (!err4) return done(null, address4, family4);
    dns.lookup(hostname, options as never, done as never);
  });
}

function requestOnce(url: string, opts: HttpTextOptions): Promise<HttpTextResponse> {
  const target = new URL(url);
  const lib = target.protocol === 'http:' ? http : https;
  const started = Date.now();
  return new Promise<HttpTextResponse>((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method: opts.method ?? 'GET',
        headers: { 'accept-encoding': 'identity', ...opts.headers },
        agent: false,
        timeout: opts.timeoutMs,
        lookup: tracedLookup as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let body = Buffer.concat(chunks);
          if (res.headers['content-encoding'] === 'gzip') {
            try { body = zlib.gunzipSync(body); } catch { /* keep raw — the caller's JSON parse will report it */ }
          }
          if (TRACE) console.error(`[probe] ${target.hostname}${target.pathname} -> ${res.statusCode} in ${Date.now() - started}ms`);
          resolve({ status: res.statusCode ?? 0, text: body.toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    // Socket idle timeout: covers connect + transfer. destroy() surfaces it
    // through the 'error' handler below, so callers see one rejection path.
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${opts.timeoutMs}ms`)));
    req.on('error', (error) => {
      if (TRACE) console.error(`[probe] ${target.hostname}${target.pathname} -> ${error.message} in ${Date.now() - started}ms`);
      reject(error);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
