import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { reconcile } from "../src/sync/reconciler.js";
import { silentLogger as logger } from "./helpers.js";
import type { ScannedFile } from "../src/vault/scanner.js";

function makeStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ical-state-"));
  return new Store(dir);
}

function file(p: string, date: string): ScannedFile {
  return { vaultPath: p, absPath: `/abs/${p}`, dateValue: date, mtimeMs: Date.now() };
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
      { vaultName: "V" },
      logger,
    );
    expect(r.actions.filter((a) => a.type === "insert")).toHaveLength(2);
    expect(store.getAllLiveEvents()).toHaveLength(2);
    expect(r.ctagBumped).toBe(true);
  });

  it("does nothing on no-op", () => {
    reconcile(store, [file("a.md", "2026-05-01")], { vaultName: "V" }, logger);
    const r2 = reconcile(store, [file("a.md", "2026-05-01")], { vaultName: "V" }, logger);
    expect(r2.actions).toHaveLength(0);
    expect(r2.ctagBumped).toBe(false);
  });

  it("updates date when only the property changed", () => {
    reconcile(store, [file("a.md", "2026-05-01")], { vaultName: "V" }, logger);
    const r = reconcile(store, [file("a.md", "2026-05-09")], { vaultName: "V" }, logger);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("update");
    const ev = store.getEventByPath("a.md")!;
    expect(ev.date_value).toBe("2026-05-09");
  });

  it("treats a same-basename move as a rename and preserves UID", () => {
    reconcile(store, [file("Tasks/a.md", "2026-05-01")], { vaultName: "V" }, logger);
    const uid = store.getEventByPath("Tasks/a.md")!.uid;

    const r = reconcile(
      store,
      [file("Archive/a.md", "2026-05-01")],
      { vaultName: "V" },
      logger,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("rename");
    expect(store.getEventByUid(uid)?.vault_path).toBe("Archive/a.md");
    expect(store.getEventByPath("Tasks/a.md")).toBeUndefined();
  });

  it("tombstones removed files", () => {
    reconcile(
      store,
      [file("a.md", "2026-05-01"), file("b.md", "2026-05-02")],
      { vaultName: "V" },
      logger,
    );
    const r = reconcile(store, [file("b.md", "2026-05-02")], { vaultName: "V" }, logger);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("delete");
    expect(store.getAllLiveEvents()).toHaveLength(1);
  });
});
