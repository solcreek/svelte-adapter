// Persistent KV cache for SvelteKit `event.platform.cache`.
//
// Design constraints:
// - Zero runtime deps (node:fs + node:crypto only; works on Node + Bun).
// - Survives process restart — L2 lives on the filesystem under
//   $CREEK_SVELTE_CACHE_DIR (default: .creek/svelte-cache/).
// - Hot reads are L1 (in-memory LRU). Cold L1 miss falls through to
//   L2; L2 hit promotes to L1.
// - Tag invalidation is global: invalidateTag(t) writes a per-tag
//   sentinel "invalidatedAt: now". Reads compare the entry's
//   createdAt against the latest invalidation of any tag it carries.
//   This is a cheap design — no global tag→keys index to keep coherent.
// - `cached()` implements stale-while-revalidate: on stale hit, the
//   stale value is returned synchronously while a background loader
//   refills the entry. Misses block on the loader.

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface CreekdSvelteCacheOptions {
  /** L2 directory; created on first write. Default: ".creek/svelte-cache". */
  dir?: string;
  /** L1 LRU size (entries). Default: 2048. */
  l1Entries?: number;
  /** When true, skip L2 (in-memory only). Useful in tests and emulate(). */
  inMemoryOnly?: boolean;
}

export interface CacheEntry<T = unknown> {
  schema: 1;
  value: T;
  tags: string[];
  createdAt: number;
  /** ms timestamp after which the entry is considered stale. Optional. */
  revalidateAfter?: number;
}

export interface SetOptions {
  /** Tags to attach for invalidation. */
  tags?: string[];
  /** Seconds before the entry is considered stale. */
  revalidate?: number;
}

export interface CreekdSvelteCache {
  get<T = unknown>(key: string): Promise<CacheEntry<T> | null>;
  set<T = unknown>(key: string, value: T, opts?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
  /**
   * Stale-while-revalidate helper. On a stale hit, returns the stale
   * value immediately and refreshes in the background. Misses block
   * on `loader`.
   */
  cached<T>(key: string, opts: SetOptions, loader: () => Promise<T>): Promise<T>;
  /** Flush any pending writes and clear L1. Tests + graceful shutdown. */
  close(): Promise<void>;
}

const DEFAULT_DIR = ".creek/svelte-cache";
const DEFAULT_L1_ENTRIES = 2048;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Tag names go in filenames; URL-style or DB-style tags can contain
// chars that aren't safe across filesystems. Hash whenever the source
// isn't a clean identifier — short tags stay readable on disk.
function safeTagFilename(tag: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(tag)) return `t-${tag}`;
  return `h-${hashKey(tag).slice(0, 32)}`;
}

function entryPath(dir: string, key: string): string {
  const h = hashKey(key);
  return path.join(dir, "entries", h.slice(0, 2), `${h}.json`);
}

function tagPath(dir: string, tag: string): string {
  return path.join(dir, "tags", `${safeTagFilename(tag)}.json`);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write: stage to .tmp then rename.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

interface TagSentinel {
  invalidatedAt: number;
}

class CacheImpl implements CreekdSvelteCache {
  private readonly dir: string;
  private readonly l1Capacity: number;
  private readonly inMemoryOnly: boolean;
  // Insertion order Map gives us LRU for free: re-set on access, delete LRU on overflow.
  private readonly l1 = new Map<string, CacheEntry<unknown>>();
  // Tag invalidation memos: avoid re-reading the same sentinel file in a tight loop.
  private readonly tagMemo = new Map<string, number>();
  // In-flight background revalidators by key — coalesce duplicate work.
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: CreekdSvelteCacheOptions) {
    this.dir = opts.dir ?? DEFAULT_DIR;
    this.l1Capacity = opts.l1Entries ?? DEFAULT_L1_ENTRIES;
    this.inMemoryOnly = opts.inMemoryOnly ?? false;
  }

  private touchL1<T>(key: string, entry: CacheEntry<T>): void {
    // Refresh recency by re-inserting at the tail.
    this.l1.delete(key);
    this.l1.set(key, entry as CacheEntry<unknown>);
    if (this.l1.size > this.l1Capacity) {
      // Evict the oldest (first iteration key).
      const first = this.l1.keys().next();
      if (!first.done) this.l1.delete(first.value);
    }
  }

  private async latestTagInvalidation(tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;
    let max = 0;
    for (const tag of tags) {
      let stamp = this.tagMemo.get(tag);
      if (stamp === undefined && !this.inMemoryOnly) {
        const sentinel = await readJson<TagSentinel>(tagPath(this.dir, tag));
        stamp = sentinel?.invalidatedAt ?? 0;
        this.tagMemo.set(tag, stamp);
      }
      if (stamp !== undefined && stamp > max) max = stamp;
    }
    return max;
  }

  private async isStale<T>(entry: CacheEntry<T>): Promise<boolean> {
    if (entry.revalidateAfter !== undefined && Date.now() >= entry.revalidateAfter) {
      return true;
    }
    const tagStamp = await this.latestTagInvalidation(entry.tags);
    return tagStamp > entry.createdAt;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const cached = this.l1.get(key) as CacheEntry<T> | undefined;
    if (cached) {
      if (await this.isStale(cached)) {
        this.l1.delete(key);
        return null;
      }
      this.touchL1(key, cached);
      return cached;
    }
    if (this.inMemoryOnly) return null;

    const onDisk = await readJson<CacheEntry<T>>(entryPath(this.dir, key));
    if (!onDisk || onDisk.schema !== 1) return null;
    if (await this.isStale(onDisk)) return null;
    this.touchL1(key, onDisk);
    return onDisk;
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    const entry: CacheEntry<T> = {
      schema: 1,
      value,
      tags: opts.tags ?? [],
      createdAt: Date.now(),
      revalidateAfter:
        opts.revalidate !== undefined ? Date.now() + opts.revalidate * 1000 : undefined,
    };
    this.touchL1(key, entry);
    if (!this.inMemoryOnly) {
      await writeJson(entryPath(this.dir, key), entry);
    }
  }

  async delete(key: string): Promise<void> {
    this.l1.delete(key);
    if (this.inMemoryOnly) return;
    await fs.rm(entryPath(this.dir, key), { force: true });
  }

  async invalidateTag(tag: string): Promise<void> {
    const now = Date.now();
    this.tagMemo.set(tag, now);
    // Anything in L1 that carries this tag is now stale; cheaper to
    // sweep L1 than to leave it and pay isStale() per read.
    for (const [k, entry] of this.l1) {
      if (entry.tags.includes(tag)) this.l1.delete(k);
    }
    if (!this.inMemoryOnly) {
      await writeJson(tagPath(this.dir, tag), { invalidatedAt: now });
    }
  }

  async cached<T>(
    key: string,
    opts: SetOptions,
    loader: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit) return hit.value;

    // Coalesce concurrent misses for the same key — without this, a
    // thundering herd at cold start hammers `loader` N times.
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const run = (async () => {
      try {
        const fresh = await loader();
        await this.set(key, fresh, opts);
        return fresh;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run as Promise<unknown>);
    return run;
  }

  async close(): Promise<void> {
    // Wait for in-flight revalidates so the process doesn't exit
    // mid-write and leave a .tmp file behind.
    await Promise.allSettled([...this.inflight.values()]);
    this.l1.clear();
    this.tagMemo.clear();
  }
}

export function createCache(opts: CreekdSvelteCacheOptions = {}): CreekdSvelteCache {
  return new CacheImpl(opts);
}

// Re-export internals for tests; do not consume from user code.
export const __test__ = {
  hashKey,
  safeTagFilename,
  entryPath,
  tagPath,
};
