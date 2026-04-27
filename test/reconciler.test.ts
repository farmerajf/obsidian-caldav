import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { reconcile } from "../src/sync/reconciler.js";
import { silentLogger as logger } from "./helpers.js";
import type { ScannedFile } from "../src/vault/scanner.js";

const CAL = "tasks";

function makeStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "caldav-state-"));
  const store = new Store(dir);
  store.ensureCalendars([CAL, "events"]);
  return store;
}

function file(p: string, date: string, statusValue: string | null = null): ScannedFile {
  return {
    vaultPath: p,
    absPath: `/abs/${p}`,
    dateValue: date,
    statusValue,
    mtimeMs: Date.now(),
  };
}

describe("reconcile", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("inserts new files", () => {
    const r = reconcile(
      store,
      [file("Tasks/a.md", "2026-05-01"), file("Tasks/b.md", "2026-05-02")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    expect(r.actions.filter((a) => a.type === "insert")).toHaveLength(2);
    expect(store.getAllLiveEvents(CAL)).toHaveLength(2);
    expect(r.ctagBumped).toBe(true);
  });

  it("does nothing on no-op", () => {
    reconcile(store, [file("a.md", "2026-05-01")], { vaultName: "V", calendarId: CAL }, logger);
    const r2 = reconcile(
      store,
      [file("a.md", "2026-05-01")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    expect(r2.actions).toHaveLength(0);
    expect(r2.ctagBumped).toBe(false);
  });

  it("updates date when only the property changed", () => {
    reconcile(store, [file("a.md", "2026-05-01")], { vaultName: "V", calendarId: CAL }, logger);
    const r = reconcile(
      store,
      [file("a.md", "2026-05-09")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("update");
    const ev = store.getEventByPath(CAL, "a.md")!;
    expect(ev.date_value).toBe("2026-05-09");
  });

  it("treats a same-basename move as a rename and preserves UID", () => {
    reconcile(
      store,
      [file("Tasks/a.md", "2026-05-01")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    const uid = store.getEventByPath(CAL, "Tasks/a.md")!.uid;

    const r = reconcile(
      store,
      [file("Archive/a.md", "2026-05-01")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("rename");
    expect(store.getEventByUid(uid)?.vault_path).toBe("Archive/a.md");
    expect(store.getEventByPath(CAL, "Tasks/a.md")).toBeUndefined();
  });

  it("tombstones removed files", () => {
    reconcile(
      store,
      [file("a.md", "2026-05-01"), file("b.md", "2026-05-02")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    const r = reconcile(
      store,
      [file("b.md", "2026-05-02")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("delete");
    expect(store.getAllLiveEvents(CAL)).toHaveLength(1);
  });

  it("status change without date change still triggers an update", () => {
    const icons = { "Not started": "◎", Complete: "◉" };
    reconcile(
      store,
      [file("a.md", "2026-05-01", "Not started")],
      { vaultName: "V", calendarId: CAL, statusIcons: icons },
      logger,
    );
    const r = reconcile(
      store,
      [file("a.md", "2026-05-01", "Complete")],
      { vaultName: "V", calendarId: CAL, statusIcons: icons },
      logger,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("update");
    expect(store.getEventByPath(CAL, "a.md")?.status_value).toBe("Complete");
  });

  it("scopes its diff to the given calendar (other calendars untouched)", () => {
    reconcile(
      store,
      [file("Tasks/a.md", "2026-05-01")],
      { vaultName: "V", calendarId: CAL },
      logger,
    );
    reconcile(
      store,
      [file("Events/x.md", "2026-06-01")],
      { vaultName: "V", calendarId: "events" },
      logger,
    );

    // Reconciling 'tasks' with empty list should tombstone Tasks/a.md but
    // leave Events/x.md alone.
    const r = reconcile(store, [], { vaultName: "V", calendarId: CAL }, logger);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("delete");
    expect(store.getAllLiveEvents(CAL)).toHaveLength(0);
    expect(store.getAllLiveEvents("events")).toHaveLength(1);
  });
});
