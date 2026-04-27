import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EventRow {
  uid: string;
  calendar_id: string;
  vault_path: string;
  date_value: string;
  etag: string;
  tombstoned: 0 | 1;
  updated_at: number;
}

export interface PendingWrite {
  abs_path: string;
  expected_mtime_ms: number;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  uid          TEXT PRIMARY KEY,
  calendar_id  TEXT NOT NULL DEFAULT 'tasks',
  vault_path   TEXT NOT NULL,
  date_value   TEXT NOT NULL,
  etag         TEXT NOT NULL,
  tombstoned   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_calendar_idx ON events(calendar_id, tombstoned);
CREATE UNIQUE INDEX IF NOT EXISTS events_calendar_path_idx ON events(calendar_id, vault_path);

CREATE TABLE IF NOT EXISTS collection (
  name   TEXT PRIMARY KEY,
  ctag   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_writes (
  abs_path          TEXT PRIMARY KEY,
  expected_mtime_ms INTEGER NOT NULL
);
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
    this.migrate();
  }

  /**
   * Apply schema migrations idempotently. Creates fresh schemas at
   * SCHEMA_VERSION; upgrades older databases in-place.
   */
  private migrate(): void {
    // Detect a pre-existing pre-versioning database: events table present but
    // no schema_version row. Treat that as version 0.
    const hasEvents = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='events'`,
      )
      .get();
    const hasVersionTable = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
      )
      .get();

    let current: number;
    if (!hasEvents && !hasVersionTable) {
      this.db.exec(SCHEMA);
      this.db.prepare(`INSERT INTO schema_version(version) VALUES (?)`).run(SCHEMA_VERSION);
      return;
    }
    if (hasVersionTable) {
      const row = this.db.prepare(`SELECT version FROM schema_version`).get() as
        | { version: number }
        | undefined;
      current = row?.version ?? 0;
    } else {
      current = 0;
    }

    if (current < 1) this.upgradeToV1();
    if (current < 2) this.upgradeToV2();

    // Make sure schema_version reflects the final version (covers the case
    // where we just created it during upgradeToV1).
    this.db.exec(`DELETE FROM schema_version`);
    this.db.prepare(`INSERT INTO schema_version(version) VALUES (?)`).run(SCHEMA_VERSION);
  }

  /**
   * v0 → v1: add calendar_id column. Pre-versioned rows belonged to the
   * single hardcoded 'tasks' calendar, so default to that.
   */
  private upgradeToV1(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(events)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "calendar_id")) {
      this.db.exec(
        `ALTER TABLE events ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'tasks'`,
      );
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS events_calendar_idx ON events(calendar_id, tombstoned)`,
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  }

  /**
   * v1 → v2: per-calendar vault support.
   * - Drop UNIQUE(vault_path) — different vaults can share relative paths.
   * - Add UNIQUE(calendar_id, vault_path) — still unique within a calendar.
   * - Rekey pending_writes by absolute path (vault-relative collides across vaults).
   */
  private upgradeToV2(): void {
    const tx = this.db.transaction(() => {
      // Rebuild events to drop the UNIQUE on vault_path.
      this.db.exec(`
        CREATE TABLE events_new (
          uid          TEXT PRIMARY KEY,
          calendar_id  TEXT NOT NULL DEFAULT 'tasks',
          vault_path   TEXT NOT NULL,
          date_value   TEXT NOT NULL,
          etag         TEXT NOT NULL,
          tombstoned   INTEGER NOT NULL DEFAULT 0,
          updated_at   INTEGER NOT NULL
        );
        INSERT INTO events_new (uid, calendar_id, vault_path, date_value, etag, tombstoned, updated_at)
          SELECT uid, calendar_id, vault_path, date_value, etag, tombstoned, updated_at FROM events;
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
        CREATE INDEX IF NOT EXISTS events_calendar_idx ON events(calendar_id, tombstoned);
        CREATE UNIQUE INDEX IF NOT EXISTS events_calendar_path_idx ON events(calendar_id, vault_path);
      `);

      // pending_writes is ephemeral — drop & recreate with the new key.
      this.db.exec(`
        DROP TABLE IF EXISTS pending_writes;
        CREATE TABLE pending_writes (
          abs_path          TEXT PRIMARY KEY,
          expected_mtime_ms INTEGER NOT NULL
        );
      `);
    });
    tx();
  }

  /** Ensure a ctag row exists for each known calendar id. Idempotent. */
  ensureCalendars(calendarIds: string[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO collection(name, ctag) VALUES (?, '0')`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id);
    });
    tx(calendarIds);
  }

  // --- collection ctag ---
  getCtag(calendarId: string): string {
    const row = this.db
      .prepare("SELECT ctag FROM collection WHERE name = ?")
      .get(calendarId) as { ctag: string } | undefined;
    return row?.ctag ?? "0";
  }

  bumpCtag(calendarId: string): string {
    const next = String(Date.now());
    this.db
      .prepare("UPDATE collection SET ctag = ? WHERE name = ?")
      .run(next, calendarId);
    return next;
  }

  // --- events ---
  getAllLiveEvents(calendarId: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE calendar_id = ? AND tombstoned = 0 ORDER BY uid",
      )
      .all(calendarId) as EventRow[];
  }

  getEventByUid(uid: string): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE uid = ?")
      .get(uid) as EventRow | undefined;
  }

  getEventByPath(calendarId: string, vaultPath: string): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE calendar_id = ? AND vault_path = ?")
      .get(calendarId, vaultPath) as EventRow | undefined;
  }

  upsertEvent(row: Omit<EventRow, "tombstoned" | "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO events (uid, calendar_id, vault_path, date_value, etag, tombstoned, updated_at)
         VALUES (@uid, @calendar_id, @vault_path, @date_value, @etag, 0, @updated_at)
         ON CONFLICT(uid) DO UPDATE SET
           calendar_id = excluded.calendar_id,
           vault_path  = excluded.vault_path,
           date_value  = excluded.date_value,
           etag        = excluded.etag,
           tombstoned  = 0,
           updated_at  = excluded.updated_at`,
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
  recordPendingWrite(absPath: string, mtimeMs: number): void {
    this.db
      .prepare(
        `INSERT INTO pending_writes (abs_path, expected_mtime_ms)
         VALUES (?, ?)
         ON CONFLICT(abs_path) DO UPDATE SET expected_mtime_ms = excluded.expected_mtime_ms`,
      )
      .run(absPath, mtimeMs);
  }

  consumePendingWrite(absPath: string, observedMtimeMs: number): boolean {
    const row = this.db
      .prepare("SELECT expected_mtime_ms FROM pending_writes WHERE abs_path = ?")
      .get(absPath) as PendingWrite | undefined;
    if (!row) return false;
    // Allow a 50ms fuzz: filesystems may round mtime.
    if (Math.abs(row.expected_mtime_ms - observedMtimeMs) <= 50) {
      this.db.prepare("DELETE FROM pending_writes WHERE abs_path = ?").run(absPath);
      return true;
    }
    return false;
  }

  clearPendingWrite(absPath: string): void {
    this.db.prepare("DELETE FROM pending_writes WHERE abs_path = ?").run(absPath);
  }
}
