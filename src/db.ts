import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EventRow {
  uid: string;
  vault_path: string;
  date_value: string;
  etag: string;
  tombstoned: 0 | 1;
  updated_at: number;
}

export interface PendingWrite {
  vault_path: string;
  expected_mtime_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  uid          TEXT PRIMARY KEY,
  vault_path   TEXT NOT NULL UNIQUE,
  date_value   TEXT NOT NULL,
  etag         TEXT NOT NULL,
  tombstoned   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection (
  name   TEXT PRIMARY KEY,
  ctag   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_writes (
  vault_path        TEXT PRIMARY KEY,
  expected_mtime_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO collection(name, ctag) VALUES ('tasks', '0');
`;

export class Store {
  readonly db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "state.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  // --- collection ctag ---
  getCtag(): string {
    const row = this.db
      .prepare("SELECT ctag FROM collection WHERE name = 'tasks'")
      .get() as { ctag: string } | undefined;
    return row?.ctag ?? "0";
  }

  bumpCtag(): string {
    const next = String(Date.now());
    this.db.prepare("UPDATE collection SET ctag = ? WHERE name = 'tasks'").run(next);
    return next;
  }

  // --- events ---
  getAllLiveEvents(): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE tombstoned = 0 ORDER BY uid")
      .all() as EventRow[];
  }

  getEventByUid(uid: string): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE uid = ?")
      .get(uid) as EventRow | undefined;
  }

  getEventByPath(vaultPath: string): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE vault_path = ?")
      .get(vaultPath) as EventRow | undefined;
  }

  upsertEvent(row: Omit<EventRow, "tombstoned" | "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO events (uid, vault_path, date_value, etag, tombstoned, updated_at)
         VALUES (@uid, @vault_path, @date_value, @etag, 0, @updated_at)
         ON CONFLICT(uid) DO UPDATE SET
           vault_path = excluded.vault_path,
           date_value = excluded.date_value,
           etag       = excluded.etag,
           tombstoned = 0,
           updated_at = excluded.updated_at`,
      )
      .run({ ...row, updated_at: Date.now() });
  }

  renamePath(uid: string, newPath: string): void {
    this.db
      .prepare("UPDATE events SET vault_path = ?, updated_at = ? WHERE uid = ?")
      .run(newPath, Date.now(), uid);
  }

  tombstone(uid: string): void {
    this.db
      .prepare("UPDATE events SET tombstoned = 1, updated_at = ? WHERE uid = ?")
      .run(Date.now(), uid);
  }

  hardDelete(uid: string): void {
    this.db.prepare("DELETE FROM events WHERE uid = ?").run(uid);
  }

  // --- pending writes (loop suppression) ---
  recordPendingWrite(vaultPath: string, mtimeMs: number): void {
    this.db
      .prepare(
        `INSERT INTO pending_writes (vault_path, expected_mtime_ms)
         VALUES (?, ?)
         ON CONFLICT(vault_path) DO UPDATE SET expected_mtime_ms = excluded.expected_mtime_ms`,
      )
      .run(vaultPath, mtimeMs);
  }

  consumePendingWrite(vaultPath: string, observedMtimeMs: number): boolean {
    const row = this.db
      .prepare("SELECT expected_mtime_ms FROM pending_writes WHERE vault_path = ?")
      .get(vaultPath) as PendingWrite | undefined;
    if (!row) return false;
    // Allow a 50ms fuzz: filesystems may round mtime.
    if (Math.abs(row.expected_mtime_ms - observedMtimeMs) <= 50) {
      this.db.prepare("DELETE FROM pending_writes WHERE vault_path = ?").run(vaultPath);
      return true;
    }
    return false;
  }

  clearPendingWrite(vaultPath: string): void {
    this.db.prepare("DELETE FROM pending_writes WHERE vault_path = ?").run(vaultPath);
  }
}
