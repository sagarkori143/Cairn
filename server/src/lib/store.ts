import type { Trail } from "./types";
import { SEED_TRAILS } from "./seed";

/**
 * Persistence boundary for team memory.
 *
 * Two adapters ship:
 *  - MemoryTrailStore  — zero config, seeded, resets on cold start. The default,
 *                        so the app runs anywhere with no infrastructure.
 *  - UpstashTrailStore  — real shared storage over Upstash's REST API, which
 *                        works from serverless edge functions without a
 *                        connection pool. Enabled purely by env vars.
 *
 * Everything above this interface is storage-agnostic, so promoting a demo to a
 * genuinely shared team instance is a deployment concern, not a code change.
 */
export interface TrailStore {
  list(): Promise<Trail[]>;
  get(id: string): Promise<Trail | null>;
  save(trail: Trail): Promise<void>;
  /** Bump reuse count when recall serves this trail instead of the model. */
  recordReuse(id: string): Promise<void>;
}

class MemoryTrailStore implements TrailStore {
  /**
   * Held on globalThis rather than a module-level constant: Next.js dev-mode
   * hot reload re-evaluates modules, which would otherwise wipe saved trails
   * on every file edit.
   */
  private get trails(): Map<string, Trail> {
    const g = globalThis as typeof globalThis & { __cairnTrails?: Map<string, Trail> };
    if (!g.__cairnTrails) {
      g.__cairnTrails = new Map(SEED_TRAILS.map((t) => [t.id, structuredClone(t)]));
    }
    return g.__cairnTrails;
  }

  async list(): Promise<Trail[]> {
    return [...this.trails.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<Trail | null> {
    return this.trails.get(id) ?? null;
  }

  async save(trail: Trail): Promise<void> {
    this.trails.set(trail.id, trail);
  }

  async recordReuse(id: string): Promise<void> {
    const t = this.trails.get(id);
    if (t) t.reuseCount += 1;
  }
}

const UPSTASH_KEY = "cairn:trails";

class UpstashTrailStore implements TrailStore {
  constructor(
    private url: string,
    private token: string,
  ) {}

  /**
   * Upstash's REST API takes commands as a JSON array, which keeps this
   * adapter dependency-free — important because it has to run in the edge
   * runtime where a TCP Redis client won't.
   */
  private async cmd<T>(...args: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Upstash ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { result: T };
    return body.result;
  }

  /**
   * Seeds on first use so a fresh Upstash database still demonstrates the
   * team-memory story instead of showing an empty library.
   */
  private async ensureSeeded(): Promise<void> {
    const count = await this.cmd<number>("HLEN", UPSTASH_KEY);
    if (count > 0) return;
    for (const t of SEED_TRAILS) {
      await this.cmd("HSET", UPSTASH_KEY, t.id, JSON.stringify(t));
    }
  }

  async list(): Promise<Trail[]> {
    await this.ensureSeeded();
    const raw = await this.cmd<string[]>("HVALS", UPSTASH_KEY);
    return raw
      .map((r) => JSON.parse(r) as Trail)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<Trail | null> {
    const raw = await this.cmd<string | null>("HGET", UPSTASH_KEY, id);
    return raw ? (JSON.parse(raw) as Trail) : null;
  }

  async save(trail: Trail): Promise<void> {
    await this.cmd("HSET", UPSTASH_KEY, trail.id, JSON.stringify(trail));
  }

  async recordReuse(id: string): Promise<void> {
    const t = await this.get(id);
    if (!t) return;
    t.reuseCount += 1;
    await this.save(t);
  }
}

let cached: TrailStore | null = null;

export function getStore(): TrailStore {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cached = url && token ? new UpstashTrailStore(url, token) : new MemoryTrailStore();
  return cached;
}

/** Surfaced in the UI so it's never ambiguous whether memory is shared or ephemeral. */
export function storeKind(): "shared" | "ephemeral" {
  return process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? "shared"
    : "ephemeral";
}
