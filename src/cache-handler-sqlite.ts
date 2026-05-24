// bun:sqlite L2 driver for CreekdSvelteCache.
//
// Why bun:sqlite over the fs driver:
// - One open file vs. N JSON files. No per-entry mkdir + tmp + rename.
// - WAL + synchronous=NORMAL gives durable writes without per-write
//   fsync. Comparable to the fs driver's atomic-rename guarantee on
//   most filesystems, much faster in practice.
// - Concurrent reads under a write are non-blocking in WAL mode.
//
// Constraints:
// - Bun-only (bun:sqlite is a built-in Bun module). The createCache
//   "auto" path lazy-imports this file and silently falls back to fs
//   when bun:sqlite is unavailable. Importing this file on Node will
//   reject at the dynamic import inside createBunSqliteL2Driver().
// - JSON-encoded entry payload (not blob). Keeps cross-runtime
//   debuggability — `sqlite3 cache.sqlite "SELECT entry FROM entries"`
//   prints something humans can read.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { CacheEntry, L2Driver } from "./cache-handler.js";

const SCHEMA_VERSION = "1";
const DB_FILENAME = "cache.sqlite";

interface BunDatabase {
  exec(sql: string): void;
  prepare(sql: string): BunStatement;
  query(sql: string): BunStatement;
  close(): void;
}
interface BunStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

class BunSqliteL2Driver implements L2Driver {
  private readonly db: BunDatabase;
  private readonly getEntryStmt: BunStatement;
  private readonly setEntryStmt: BunStatement;
  private readonly deleteEntryStmt: BunStatement;
  private readonly getTagStmt: BunStatement;
  private readonly setTagStmt: BunStatement;

  constructor(db: BunDatabase) {
    this.db = db;
    this.getEntryStmt = db.prepare("SELECT entry FROM entries WHERE key = ?");
    this.setEntryStmt = db.prepare("INSERT OR REPLACE INTO entries(key, entry) VALUES(?, ?)");
    this.deleteEntryStmt = db.prepare("DELETE FROM entries WHERE key = ?");
    this.getTagStmt = db.prepare("SELECT invalidated_at FROM tags WHERE tag = ?");
    this.setTagStmt = db.prepare(
      "INSERT INTO tags(tag, invalidated_at) VALUES(?, ?) ON CONFLICT(tag) DO UPDATE SET invalidated_at = excluded.invalidated_at",
    );
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
    const row = this.getEntryStmt.get(key) as { entry: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.entry) as CacheEntry<T>;
      if (parsed.schema !== 1) return null;
      return parsed;
    } catch {
      // Corrupt row — treat as miss; an overwrite will heal it.
      return null;
    }
  }

  async setEntry<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.setEntryStmt.run(key, JSON.stringify(entry));
  }

  async deleteEntry(key: string): Promise<void> {
    this.deleteEntryStmt.run(key);
  }

  async getTagInvalidation(tag: string): Promise<number> {
    const row = this.getTagStmt.get(tag) as { invalidated_at: number } | null;
    return row?.invalidated_at ?? 0;
  }

  async setTagInvalidation(tag: string, invalidatedAt: number): Promise<void> {
    this.setTagStmt.run(tag, invalidatedAt);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createBunSqliteL2Driver(dir: string): Promise<L2Driver> {
  // bun:sqlite is a Bun built-in. The dynamic import throws on Node;
  // resolveL2Driver() turns that into the auto-fallback to fs.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — bun:sqlite has no TS typings shipped with Bun.
  const mod = (await import(/* @vite-ignore */ "bun:sqlite")) as {
    Database: new (filename: string, opts?: { create?: boolean }) => BunDatabase;
  };

  await fs.mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, DB_FILENAME);
  const db = new mod.Database(dbPath, { create: true });

  // WAL + NORMAL: durable on commit, no per-write fsync. Standard
  // "SQLite as a fast embedded KV" recipe.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      key TEXT PRIMARY KEY,
      entry TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      tag TEXT PRIMARY KEY,
      invalidated_at INTEGER NOT NULL
    );
  `);

  // First-run insert; existing dbs keep their stamp.
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)").run(
    SCHEMA_VERSION,
  );

  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  if (versionRow && versionRow.value !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `[@solcreek/svelte-adapter] cache.sqlite at ${dbPath} has schema_version=${versionRow.value}, expected ${SCHEMA_VERSION}. Delete the file or roll back the adapter.`,
    );
  }

  return new BunSqliteL2Driver(db);
}

// Re-export for tests; do not consume from user code.
export const __test__ = {
  SCHEMA_VERSION,
  DB_FILENAME,
};
