// lib/rateLimit.ts
// Fixed-window rate limiter backed by Workers KV.
// No auth on /api/trigger or /api/review — this is the abuse-prevention layer.
// Mirrors the llm_quota:{date} pattern used in src/scan-worker/pipeline.ts.

export interface RateLimitResult {
  ok:        boolean;
  limit:     number;
  remaining: number;
  resetAt:   number; // unix seconds when the window resets
}

/**
 * Check + increment a fixed-window counter for `key` within `windowSeconds`.
 * Returns ok=false once `limit` is exceeded for the current window.
 *
 * Window boundaries are aligned to epoch time (Math.floor(now / window)),
 * so the key naturally rotates and KV entries expire via TTL — no cleanup needed.
 */
export async function checkRateLimit(
  cache: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;
  const kvKey = `ratelimit:${key}:${windowStart}`;

  const raw = await cache.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    return { ok: false, limit, remaining: 0, resetAt };
  }

  const next = count + 1;
  // TTL covers the window plus a small buffer so the key expires after reset
  await cache.put(kvKey, String(next), { expirationTtl: windowSeconds + 30 });

  return { ok: true, limit, remaining: limit - next, resetAt };
}

/**
 * Best-effort client identifier for Cloudflare-fronted requests.
 * cf-connecting-ip is set by Cloudflare's edge and isn't spoofable by clients
 * (Cloudflare overwrites it), unlike x-forwarded-for.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Build a standard 429 response with Retry-After and RateLimit-* headers.
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfter = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));
  return Response.json(
    { error: 'Too many requests', retryAfter },
    {
      status: 429,
      headers: {
        'Retry-After':         String(retryAfter),
        'RateLimit-Limit':     String(result.limit),
        'RateLimit-Remaining': String(result.remaining),
        'RateLimit-Reset':     String(result.resetAt),
      },
    },
  );
}
