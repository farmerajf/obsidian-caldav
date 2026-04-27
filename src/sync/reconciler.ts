import { v7 as uuidv7 } from "uuid";
import type { Store, EventRow } from "../db.js";
import type { ScannedFile } from "../vault/scanner.js";
import { renderEvent } from "../caldav/ics.js";
import type { Logger } from "../logger.js";

export type ReconcileAction =
  | { type: "insert"; row: EventRow }
  | { type: "update"; row: EventRow; previous: EventRow }
  | { type: "rename"; row: EventRow; previousPath: string }
  | { type: "delete"; uid: string; vaultPath: string };

export interface ReconcileResult {
  actions: ReconcileAction[];
  ctagBumped: boolean;
}

export interface ReconcileOptions {
  vaultName: string;
  calendarId: string;
}

/**
 * Diff the scanner's view of one calendar's folder against the DB rows for
 * that calendar and apply changes. Other calendars' rows are untouched.
 */
export function reconcile(
  store: Store,
  scanned: ScannedFile[],
  opts: ReconcileOptions,
  logger: Logger,
): ReconcileResult {
  const byPath = new Map<string, ScannedFile>();
  for (const f of scanned) byPath.set(f.vaultPath, f);

  const existing = store.getAllLiveEvents(opts.calendarId);
  const existingByPath = new Map<string, EventRow>();
  for (const e of existing) existingByPath.set(e.vault_path, e);

  const actions: ReconcileAction[] = [];

  // --- inserts and updates ---
  for (const file of scanned) {
    const prev = existingByPath.get(file.vaultPath);
    if (prev) {
      if (prev.date_value !== file.dateValue) {
        const etag = computeEtag(prev.uid, file.vaultPath, file.dateValue, opts.vaultName);
        const next: EventRow = {
          uid: prev.uid,
          calendar_id: opts.calendarId,
          vault_path: file.vaultPath,
          date_value: file.dateValue,
          etag,
          tombstoned: 0,
          updated_at: Date.now(),
        };
        store.upsertEvent(next);
        actions.push({ type: "update", row: next, previous: prev });
      }
      // unchanged → no action
    } else {
      // Could be a rename: same UID would be on the old path. We check in the
      // "deletes" pass below. For now, only insert if no other event matches
      // the date+content "fingerprint" — but we don't have a body fingerprint,
      // so we treat unmatched-path as insert and let the deletes pass detect
      // renames by UID-less reasoning. (Renames that change *only* the path
      // appear here as insert+delete pairs; we collapse them next.)
      const uid = uuidv7();
      const etag = computeEtag(uid, file.vaultPath, file.dateValue, opts.vaultName);
      const row: EventRow = {
        uid,
        calendar_id: opts.calendarId,
        vault_path: file.vaultPath,
        date_value: file.dateValue,
        etag,
        tombstoned: 0,
        updated_at: Date.now(),
      };
      // Don't write yet — we may collapse to a rename below.
      actions.push({ type: "insert", row });
    }
  }

  // --- deletes (existing rows with no scanned counterpart) ---
  const deletedRows: EventRow[] = [];
  for (const e of existing) {
    if (!byPath.has(e.vault_path)) {
      deletedRows.push(e);
    }
  }

  // --- collapse insert+delete with matching dateValue into rename ---
  // This is best-effort: if a file is renamed AND has its date changed in
  // the same scan tick, we treat them as separate events (insert new + delete
  // old). A new UID appears in Apple Calendar — acceptable trade-off.
  const remainingDeletes: EventRow[] = [];
  for (const del of deletedRows) {
    const matchIdx = actions.findIndex(
      (a) =>
        a.type === "insert" &&
        a.row.date_value === del.date_value &&
        // file basename match makes the heuristic less wrong
        basename(a.row.vault_path) === basename(del.vault_path),
    );
    if (matchIdx >= 0) {
      const ins = actions[matchIdx]!;
      if (ins.type !== "insert") continue;
      const renamed: EventRow = {
        ...del,
        vault_path: ins.row.vault_path,
        updated_at: Date.now(),
      };
      actions[matchIdx] = {
        type: "rename",
        row: renamed,
        previousPath: del.vault_path,
      };
    } else {
      remainingDeletes.push(del);
    }
  }
  for (const del of remainingDeletes) {
    actions.push({ type: "delete", uid: del.uid, vaultPath: del.vault_path });
  }

  // --- apply ---
  for (const a of actions) {
    switch (a.type) {
      case "insert":
        store.upsertEvent({
          uid: a.row.uid,
          calendar_id: opts.calendarId,
          vault_path: a.row.vault_path,
          date_value: a.row.date_value,
          etag: a.row.etag,
        });
        logger.info(
          { uid: a.row.uid, calendarId: opts.calendarId, path: a.row.vault_path },
          "event inserted",
        );
        break;
      case "update":
        // already written above
        logger.info(
          {
            uid: a.row.uid,
            calendarId: opts.calendarId,
            path: a.row.vault_path,
            date: a.row.date_value,
          },
          "event updated",
        );
        break;
      case "rename":
        store.renamePath(a.row.uid, a.row.vault_path);
        logger.info(
          {
            uid: a.row.uid,
            calendarId: opts.calendarId,
            from: a.previousPath,
            to: a.row.vault_path,
          },
          "event renamed",
        );
        break;
      case "delete":
        store.tombstone(a.uid);
        logger.info(
          { uid: a.uid, calendarId: opts.calendarId, path: a.vaultPath },
          "event tombstoned",
        );
        break;
    }
  }

  if (actions.length > 0) {
    store.bumpCtag(opts.calendarId);
    return { actions, ctagBumped: true };
  }
  return { actions, ctagBumped: false };
}

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** Cheap content hash for ETag — ICS body is rendered the same way every time. */
export function computeEtag(
  uid: string,
  vaultPath: string,
  dateValue: string,
  vaultName: string,
): string {
  // Render the event and hash the canonical body. Any field change → new ETag.
  const ics = renderEvent({
    uid,
    calendar_id: "",
    vault_path: vaultPath,
    date_value: dateValue,
    etag: "",
    tombstoned: 0,
    updated_at: 0,
  }, vaultName);
  return `"${djb2(ics).toString(36)}"`;
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
