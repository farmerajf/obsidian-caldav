import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { silentLogger as logger } from "./helpers.js";

function tmp(): { vault: string; store: Store } {
  const vault = mkdtempSync(join(tmpdir(), "caldav-writer-vault-"));
  const stateDir = mkdtempSync(join(tmpdir(), "caldav-writer-state-"));
  return { vault, store: new Store(stateDir) };
}

describe("VaultWriter.setDateProperty", () => {
  it("updates the date property and preserves other frontmatter and body", async () => {
    const { vault, store } = tmp();
    const file = join(vault, "task.md");
    writeFileSync(
      file,
      `---\ndue: 2026-05-01\nstatus: open\ntags: [work, urgent]\n---\n\n# Title\n\nBody content.\n`,
    );
    const w = new VaultWriter({ store, logger });

    const changed = await w.setDateProperty(vault, "task.md", "due", "2026-05-15");
    expect(changed).toBe(true);

    const after = readFileSync(file, "utf8");
    expect(after).toMatch(/due:\s*'?2026-05-15'?/);
    expect(after).toMatch(/status:\s*open/);
    expect(after).toMatch(/tags:[\s\S]*work/);
    expect(after).toMatch(/# Title/);
    expect(after).toMatch(/Body content\./);
  });

  it("removes the property when value is null", async () => {
    const { vault, store } = tmp();
    const file = join(vault, "task.md");
    writeFileSync(file, `---\ndue: 2026-05-01\nstatus: open\n---\n`);
    const w = new VaultWriter({ store, logger });

    await w.setDateProperty(vault, "task.md", "due", null);
    const after = readFileSync(file, "utf8");
    expect(after).not.toMatch(/due:/);
    expect(after).toMatch(/status:\s*open/);
  });

  it("returns false (no write) when value is unchanged", async () => {
    const { vault, store } = tmp();
    const file = join(vault, "task.md");
    writeFileSync(file, `---\ndue: '2026-05-01'\n---\n`);
    const w = new VaultWriter({ store, logger });

    const changed = await w.setDateProperty(vault, "task.md", "due", "2026-05-01");
    expect(changed).toBe(false);
  });

  it("records pending write so the watcher can suppress its own echo", async () => {
    const { vault, store } = tmp();
    const file = join(vault, "task.md");
    writeFileSync(file, `---\ndue: 2026-05-01\n---\n`);
    const w = new VaultWriter({ store, logger });

    await w.setDateProperty(vault, "task.md", "due", "2026-05-09");
    const stat = (await import("node:fs/promises")).stat;
    const st = await stat(file);
    expect(store.consumePendingWrite(file, st.mtimeMs)).toBe(true);
  });
});

describe("VaultWriter.renameToTitle", () => {
  it("renames to sanitized title within the same directory", async () => {
    const { vault, store } = tmp();
    const file = join(vault, "Tasks", "old.md");
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(vault, "Tasks"));
    writeFileSync(file, `---\ndue: 2026-05-01\n---\n`);
    const w = new VaultWriter({ store, logger });

    const newPath = await w.renameToTitle(vault, "Tasks/old.md", "New / Title?");
    expect(newPath).toBe("Tasks/New - Title-.md");
    const exists = await fs
      .stat(join(vault, "Tasks/New - Title-.md"))
      .then(() => true);
    expect(exists).toBe(true);
  });

  it("refuses to overwrite an existing target", async () => {
    const { vault, store } = tmp();
    const fs = await import("node:fs/promises");
    writeFileSync(join(vault, "a.md"), `---\ndue: 2026-05-01\n---\n`);
    writeFileSync(join(vault, "b.md"), `---\ndue: 2026-05-02\n---\n`);
    const w = new VaultWriter({ store, logger });

    const result = await w.renameToTitle(vault, "a.md", "b");
    expect(result).toBeNull();
    // Both files still exist
    expect(await fs.stat(join(vault, "a.md")).then(() => true)).toBe(true);
    expect(await fs.stat(join(vault, "b.md")).then(() => true)).toBe(true);
  });
});
