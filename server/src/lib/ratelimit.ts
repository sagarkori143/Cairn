/**
 * Spend protection for the one endpoint that costs money.
 *
 * Cairn deploys to a public URL with no login, so `/api/ask` is reachable by
 * anyone who finds it — and every miss behind it is a paid vision call. Three
 * independent limits apply, and a request has to clear all of them:
 *
 *   1. per-IP burst   — stops one client hammering it (a runaway loop, a stuck
 *                       retry, someone leaning on the button)
 *   2. per-IP hourly  — stops one client grinding steadily all afternoon
 *   3. global daily   — the actual wallet guard. Caps total spend per day no
 *                       matter how many distinct clients show up, which is the
 *                       only limit that helps against a small crowd or a spread
 *                       of addresses.
 *
 * Only *model* calls are counted. Recall hits cost nothing, so they're never
 * limited — which means the team-memory layer isn't just a latency win, it
 * takes real pressure off this budget.
 *
 * Storage mirrors TrailStore: in-memory by default so the app runs anywhere,
 * Upstash when configured. Be honest about what the memory adapter is worth on
 * serverless — counters live per instance and reset on cold start, so the real
 * ceiling is somewhat above the configured one. It stops loops and casual
 * abuse; it is not an airtight budget. Set the Upstash variables for a limit
 * that actually holds across instances.
 */

export interface RateLimitConfig {
  /** Model calls allowed per IP per minute. */
  perIpPerMinute: number;
  /** Model calls allowed per IP per hour. */
  perIpPerHour: number;
  /** Model calls allowed across everyone per day. The wallet guard. */
  globalPerDay: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Defaults are sized against a demo budget, not against production traffic.
 * At roughly 3 cents a call, 100/day caps exposure near $3/day — enough for a
 * reviewer to explore thoroughly, low enough that a scraper can't drain the
 * account overnight.
 */
export function getConfig(): RateLimitConfig {
  return {
    perIpPerMinute: envInt("RATE_LIMIT_PER_IP_PER_MINUTE", 6),
    perIpPerHour: envInt("RATE_LIMIT_PER_IP_PER_HOUR", 30),
    globalPerDay: envInt("RATE_LIMIT_GLOBAL_PER_DAY", 100),
  };
}

export interface RateLimitResult {
  allowed: boolean;
  /** Human-facing explanation. Shown directly in the UI. */
  message?: string;
  /** Seconds until the caller should try again. Sent as Retry-After. */
  retryAfter?: number;
  /** Which limit tripped — useful in logs when tuning. */
  limit?: "burst" | "hourly" | "daily";
}

/* ------------------------------------------------------------------ stores */

interface CounterStore {
  /** Increment `key`, creating it with `windowSec` TTL if absent. Returns the new count. */
  bump(key: string, windowSec: number): Promise<number>;
}

class MemoryCounterStore implements CounterStore {
  private get counters(): Map<string, { count: number; expiresAt: number }> {
    const g = globalThis as typeof globalThis & {
      __cairnRate?: Map<string, { count: number; expiresAt: number }>;
    };
    if (!g.__cairnRate) g.__cairnRate = new Map();
    return g.__cairnRate;
  }

  async bump(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const counters = this.counters;

    // Opportunistic sweep. Without it a long-lived instance accumulates one
    // entry per IP per window forever, which is a slow memory leak.
    if (counters.size > 5000) {
      for (const [k, v] of counters) if (v.expiresAt <= now) counters.delete(k);
    }

    const existing = counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      counters.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}

class UpstashCounterStore implements CounterStore {
  constructor(
    private url: string,
    private token: string,
  ) {}

  async bump(key: string, windowSec: number): Promise<number> {
    // Pipelined so INCR and EXPIRE cost one round trip rather than two.
    // EXPIRE is set every time rather than only on creation: it's idempotent
    // enough here (a fixed window that slides slightly is fine) and it avoids
    // a key that somehow lost its TTL blocking a caller forever.
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSec), "NX"],
      ]),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const body = (await res.json()) as Array<{ result: number }>;
    return body[0]?.result ?? 1;
  }
}

let cachedStore: CounterStore | null = null;

function getCounterStore(): CounterStore {
  if (cachedStore) return cachedStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cachedStore = url && token ? new UpstashCounterStore(url, token) : new MemoryCounterStore();
  return cachedStore;
}

/** True when limits are shared across instances rather than per-instance. */
export function isRateLimitDurable(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/* ------------------------------------------------------------------- check */

/** Day bucket in UTC, so the global window is deterministic across regions. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Consumes one unit against every limit. Call this only when a model call is
 * actually about to happen — never on a recall hit, which is free.
 *
 * Counters are incremented even when a later limit rejects the request. That's
 * deliberate: a client that keeps retrying through a 429 should stay blocked
 * rather than being handed a fresh allowance, and the alternative (rolling back
 * the increments) is racy for no real benefit.
 */
export async function consumeModelCall(ip: string): Promise<RateLimitResult> {
  const cfg = getConfig();
  const store = getCounterStore();

  try {
    const [minute, hour, day] = await Promise.all([
      store.bump(`cairn:rl:m:${ip}:${Math.floor(Date.now() / 60_000)}`, 60),
      store.bump(`cairn:rl:h:${ip}:${Math.floor(Date.now() / 3_600_000)}`, 3600),
      store.bump(`cairn:rl:d:${dayKey()}`, 86_400),
    ]);

    if (minute > cfg.perIpPerMinute) {
      return {
        allowed: false,
        limit: "burst",
        retryAfter: 60,
        message: "Slow down a moment — that's a lot of questions at once. Try again in a minute.",
      };
    }
    if (hour > cfg.perIpPerHour) {
      return {
        allowed: false,
        limit: "hourly",
        retryAfter: 900,
        message:
          "You've hit the hourly limit for live answers. Saved trails still work — try the Trails tab.",
      };
    }
    if (day > cfg.globalPerDay) {
      return {
        allowed: false,
        limit: "daily",
        retryAfter: 3600,
        message:
          "Cairn has reached its daily budget for live answers. Browsing and replaying trails still works.",
      };
    }

    return { allowed: true };
  } catch {
    // A limiter outage must not take the product down, and must not silently
    // remove the spend cap either. Failing open is the lesser evil here: the
    // per-request cost is bounded and small, whereas failing closed would make
    // an Upstash blip look like a broken product to a reviewer.
    return { allowed: true };
  }
}

/**
 * Best-effort client address. Vercel populates x-forwarded-for; the first entry
 * is the original client. Falls back to a shared bucket, which means unknown
 * clients throttle each other — acceptable, since the global daily cap is the
 * limit that actually protects the budget.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
