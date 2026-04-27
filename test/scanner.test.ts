import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDateValue, isAllDay, scanVault } from "../src/vault/scanner.js";
import { silentLogger as logger } from "./helpers.js";

describe("normalizeDateValue", () => {
  it("normalizes YAML Date (date-only) to YYYY-MM-DD", () => {
    // gray-matter parses bare `2026-05-01` as a UTC midnight Date
    const d = new Date("2026-05-01T00:00:00Z");
    expect(normalizeDateValue(d)).toBe("2026-05-01");
  });

  it("normalizes YAML datetime to YYYY-MM-DDTHH:MM:SS", () => {
    const d = new Date("2026-05-01T14:30:00Z");
    expect(normalizeDateValue(d)).toBe("2026-05-01T14:30:00");
  });

  it("accepts string YYYY-MM-DD", () => {
    expect(normalizeDateValue("2026-05-01")).toBe("2026-05-01");
  });

  it("accepts string YYYY-MM-DDTHH:MM and pads seconds", () => {
    expect(normalizeDateValue("2026-05-01T09:00")).toBe("2026-05-01T09:00:00");
  });

  it("returns null for nonsense", () => {
    expect(normalizeDateValue("hello")).toBeNull();
    expect(normalizeDateValue(null)).toBeNull();
    expect(normalizeDateValue(undefined)).toBeNull();
    expect(normalizeDateValue(42)).toBeNull();
  });
});

describe("isAllDay", () => {
  it("detects all-day vs timed", () => {
    expect(isAllDay("2026-05-01")).toBe(true);
    expect(isAllDay("2026-05-01T14:00:00")).toBe(false);
  });
});

describe("scanVault", () => {
  function fixtureVault(): string {
    const root = mkdtempSync(join(tmpdir(), "caldav-vault-"));
    const tasks = join(root, "Tasks");
    mkdirSync(tasks, { recursive: true });
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    mkdirSync(join(root, ".trash"), { recursive: true });

    writeFileSync(
      join(tasks, "ship-feature.md"),
      `---\ndue: 2026-05-15\nstatus: open\n---\n\nDo the thing.\n`,
    );
    writeFileSync(
      join(tasks, "meeting.md"),
      `---\ndue: 2026-05-16T14:00:00\n---\n`,
    );
    writeFileSync(
      join(tasks, "no-date.md"),
      `---\nstatus: open\n---\n`,
    );
    writeFileSync(
      join(tasks, "no-frontmatter.md"),
      `Just a plain note.\n`,
    );
    writeFileSync(
      join(tasks, "malformed.md"),
      `---\nthis is: not: valid: yaml: ::\n---\n`,
    );
    // Inside .obsidian — must be ignored
    writeFileSync(
      join(root, ".obsidian", "config.md"),
      `---\ndue: 2026-05-20\n---\n`,
    );
    return root;
  }

  it("finds files with the configured date property and ignores special dirs", async () => {
    const root = fixtureVault();
    const files = await scanVault({
      vaultRoot: root,
      scanRoot: join(root, "Tasks"),
      property: "due",
      logger,
    });

    const paths = files.map((f) => f.vaultPath).sort();
    expect(paths).toEqual(["Tasks/meeting.md", "Tasks/ship-feature.md"]);

    const ship = files.find((f) => f.vaultPath === "Tasks/ship-feature.md")!;
    expect(ship.dateValue).toBe("2026-05-15");

    const meeting = files.find((f) => f.vaultPath === "Tasks/meeting.md")!;
    expect(meeting.dateValue).toBe("2026-05-16T14:00:00");
  });

  it("respects a different property name", async () => {
    const root = mkdtempSync(join(tmpdir(), "caldav-vault-"));
    writeFileSync(
      join(root, "a.md"),
      `---\nscheduled: 2026-06-01\n---\n`,
    );
    const files = await scanVault({
      vaultRoot: root,
      scanRoot: root,
      property: "scheduled",
      logger,
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.dateValue).toBe("2026-06-01");
  });
});
