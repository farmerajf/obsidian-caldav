import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import matter from "gray-matter";
import type { Store } from "../db.js";
import type { Logger } from "../logger.js";

export interface WriterOptions {
  store: Store;
  logger: Logger;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function sanitizeFilename(name: string): string {
  // POSIX-safe; also strip Windows-illegal characters in case the user uses
  // iCloud-synced vaults that travel between machines.
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Update or remove a frontmatter property on a file. Round-trips the rest of
 * the YAML and the body via gray-matter. Records the post-write absolute path
 * so the watcher can suppress its own echo.
 */
export class VaultWriter {
  constructor(private readonly opts: WriterOptions) {}

  /** Set property to `value` (or unset if value === null). Returns true if file changed. */
  async setDateProperty(
    vaultRoot: string,
    vaultPath: string,
    property: string,
    value: string | null,
  ): Promise<boolean> {
    const absPath = join(vaultRoot, vaultPath);
    const original = await readFile(absPath, "utf8");
    const parsed = matter(original);
    const data = { ...(parsed.data as Record<string, unknown>) };

    if (value === null) {
      if (!(property in data)) return false;
      delete data[property];
    } else {
      if (data[property] === value) return false;
      data[property] = value;
    }

    const next = matter.stringify(parsed.content, data);
    if (next === original) return false;

    await writeFile(absPath, next, "utf8");
    const st = await stat(absPath);
    this.opts.store.recordPendingWrite(absPath, st.mtimeMs);
    this.opts.logger.info(
      { vaultPath, property, value },
      "wrote frontmatter property",
    );
    return true;
  }

  /**
   * Rename file to match a new title (basename without extension). Returns the
   * new vault-relative path, or null if no rename was needed.
   *
   * Throws if the target path already exists, to avoid silent overwrites.
   */
  async renameToTitle(
    vaultRoot: string,
    vaultPath: string,
    newTitle: string,
  ): Promise<string | null> {
    const sanitized = sanitizeFilename(newTitle);
    if (!sanitized) return null;
    const absOld = join(vaultRoot, vaultPath);
    const dir = dirname(absOld);
    const absNew = join(dir, `${sanitized}.md`);
    if (absOld === absNew) return null;

    // Refuse overwrites
    try {
      await stat(absNew);
      this.opts.logger.warn(
        { from: vaultPath, to: relative(vaultRoot, absNew) },
        "rename target exists, skipping",
      );
      return null;
    } catch {
      // ENOENT — good
    }

    await rename(absOld, absNew);
    const newRel = toPosix(relative(vaultRoot, absNew));
    const st = await stat(absNew);
    this.opts.store.recordPendingWrite(absNew, st.mtimeMs);
    // Also record the old absolute path so the watcher's "deleted" event is suppressed.
    this.opts.store.recordPendingWrite(absOld, 0);
    this.opts.logger.info({ from: vaultPath, to: newRel }, "renamed file");
    return newRel;
  }
}
