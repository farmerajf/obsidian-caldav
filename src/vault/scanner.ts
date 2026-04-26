import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import matter from "gray-matter";
import type { Logger } from "../logger.js";

export interface ScannedFile {
  /** Vault-relative POSIX path (forward slashes, with .md extension) */
  vaultPath: string;
  /** Absolute filesystem path */
  absPath: string;
  /** Raw value from the date frontmatter property, normalized to ISO-ish string */
  dateValue: string;
  /** mtime in ms */
  mtimeMs: number;
}

export interface ScannerOptions {
  vaultRoot: string;
  scanRoot: string;
  property: string;
  logger: Logger;
}

const IGNORE_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * gray-matter returns Date objects for YAML date values, strings for quoted
 * values. Normalize to one of:
 *   - "YYYY-MM-DD"          (all-day)
 *   - "YYYY-MM-DDTHH:MM:SS" (timed, local time)
 * Anything else we can't make sense of returns null.
 */
export function normalizeDateValue(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // gray-matter produces a Date for `2026-05-01` — treat as all-day.
    // It also produces a Date for `2026-05-01T14:00:00` — timed.
    // We can tell them apart by looking at whether time components are non-zero
    // in UTC, but that's lossy. Cleaner: re-serialize from local components if
    // any time component is set, else date-only.
    const hasTime =
      raw.getUTCHours() !== 0 ||
      raw.getUTCMinutes() !== 0 ||
      raw.getUTCSeconds() !== 0;
    const y = raw.getUTCFullYear().toString().padStart(4, "0");
    const m = (raw.getUTCMonth() + 1).toString().padStart(2, "0");
    const d = raw.getUTCDate().toString().padStart(2, "0");
    if (!hasTime) return `${y}-${m}-${d}`;
    const hh = raw.getUTCHours().toString().padStart(2, "0");
    const mm = raw.getUTCMinutes().toString().padStart(2, "0");
    const ss = raw.getUTCSeconds().toString().padStart(2, "0");
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.length === 16 ? `${s}:00` : s;
    }
    // Try Date parsing as a last resort
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return normalizeDateValue(d);
    }
    return null;
  }
  return null;
}

export function isAllDay(dateValue: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateValue);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

export async function scanVault(opts: ScannerOptions): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  for await (const absPath of walk(opts.scanRoot)) {
    try {
      const content = await readFile(absPath, "utf8");
      const parsed = matter(content);
      const raw = (parsed.data as Record<string, unknown>)[opts.property];
      const dateValue = normalizeDateValue(raw);
      if (!dateValue) continue;
      const st = await stat(absPath);
      results.push({
        vaultPath: toPosix(relative(opts.vaultRoot, absPath)),
        absPath,
        dateValue,
        mtimeMs: st.mtimeMs,
      });
    } catch (err) {
      opts.logger.warn({ absPath, err }, "skipping file (parse error)");
    }
  }
  return results;
}
