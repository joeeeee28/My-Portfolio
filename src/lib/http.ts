/**
 * HTTP helper with timeout, retry and simple token-bucket rate limiting.
 * Used by every provider that reaches an external system (§64).
 */
export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  retryOn?: number[];
  signal?: AbortSignal;
}

export interface HttpResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
  elapsedMs: number;
  error?: string;
}

const buckets = new Map<string, { tokens: number; last: number }>();

/** Token bucket. Returns ms to wait, or 0 when the request may proceed. */
export function rateLimitWait(key: string, perMinute: number): number {
  if (!perMinute || perMinute <= 0) return 0;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, last: now };
  const refill = ((now - b.last) / 60_000) * perMinute;
  b.tokens = Math.min(perMinute, b.tokens + refill);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return 0;
  }
  const wait = Math.ceil(((1 - b.tokens) / perMinute) * 60_000);
  buckets.set(key, b);
  return wait;
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResult<T>> {
  const started = Date.now();
  const retries = opts.retries ?? 1;
  const retryOn = opts.retryOn ?? [429, 500, 502, 503, 504];
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data: T | null = null;
      try {
        data = text ? (JSON.parse(text) as T) : null;
      } catch {
        data = null;
      }
      clearTimeout(timer);
      if (res.ok) {
        return { ok: true, status: res.status, data, text, elapsedMs: Date.now() - started };
      }
      lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      if (!retryOn.includes(res.status) || attempt === retries) {
        return { ok: false, status: res.status, data, text, elapsedMs: Date.now() - started, error: lastError };
      }
      await sleep(400 * (attempt + 1));
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === retries) {
        return { ok: false, status: 0, data: null, text: '', elapsedMs: Date.now() - started, error: lastError };
      }
      await sleep(400 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, data: null, text: '', elapsedMs: Date.now() - started, error: lastError };
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<HttpResult<string>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      signal: controller.signal,
    });
    const text = await res.text();
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, data: text, text, elapsedMs: Date.now() - started };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      data: '',
      text: '',
      elapsedMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Raw TCP/TLS probe used by the website auditor to measure response time and TLS. */
export async function probeHost(hostname: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const net = await import('net');
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: timeoutMs });
    const done = (ok: boolean, error?: string) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (e) => done(false, e.message));
  });
}

/** Inspects a live TLS certificate (issuer + expiry) — used for the SSL audit signal. */
export async function probeTls(hostname: string, timeoutMs = 8000): Promise<{
  ok: boolean;
  issuer?: string;
  validTo?: string;
  daysRemaining?: number;
  error?: string;
}> {
  const tls = await import('tls');
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: timeoutMs, rejectUnauthorized: false });
    const fail = (error: string) => {
      socket.destroy();
      resolve({ ok: false, error });
    };
    socket.once('timeout', () => fail('timeout'));
    socket.once('error', (e) => fail(e.message));
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to).toISOString() : undefined;
        const days = validTo ? Math.floor((new Date(validTo).getTime() - Date.now()) / 86_400_000) : undefined;
        const issuer = String(cert?.issuer?.O ?? cert?.issuer?.CN ?? '');
        const authorized = socket.authorized;
        socket.destroy();
        resolve({ ok: !!authorized, issuer, validTo, daysRemaining: days });
      } catch (e) {
        socket.destroy();
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  }
  return out.toString();
}
