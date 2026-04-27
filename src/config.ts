import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";

const CALENDAR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CalendarSchema = z.object({
  id: z
    .string()
    .regex(
      CALENDAR_ID_RE,
      "calendar.id must be lowercase alphanumeric with hyphens, 1-64 chars, starting with [a-z0-9]",
    ),
  name: z.string().min(1),
  vault_path: z.string().min(1),
  vault_name: z.string().min(1),
  folder: z.string().min(1),
  property: z.string().min(1),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB")
    .optional(),
  description: z.string().optional(),
  /**
   * Optional frontmatter key whose value is mapped to a SUMMARY prefix via
   * `status_icons`. Matching is case-insensitive after trim.
   */
  status_property: z.string().min(1).optional(),
  status_icons: z.record(z.string(), z.string().min(1)).optional(),
});

export type CalendarConfig = z.infer<typeof CalendarSchema>;

const ConfigSchema = z.object({
  calendars: z.array(CalendarSchema).min(1),
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(5232),
    username: z.string().min(1),
    password: z.string().optional(),
    password_file: z.string().optional(),
    /**
     * Optional URL prefix for serving behind a reverse proxy that does not
     * strip the prefix (e.g. Tailscale Serve at "/obsidian-caldav"). Empty
     * string = serve at root.
     */
    base_path: z.string().default(""),
  }),
  state_dir: z.string().default("./state"),
});

export interface ResolvedCalendar extends CalendarConfig {
  /** Absolute path to the calendar's vault root. */
  resolvedVaultPath: string;
  /** Absolute path to the calendar's folder on disk. */
  resolvedFolderAbs: string;
}

export type Config = Omit<z.infer<typeof ConfigSchema>, "calendars"> & {
  password: string;
  resolvedStateDir: string;
  calendars: ResolvedCalendar[];
  /** Normalized: empty string or `/segment` (no trailing slash). */
  basePath: string;
};

/** "" | "/" | undefined → ""; "/foo/" | "foo" | "/foo" → "/foo". */
function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(withLeading)) {
    throw new Error(
      `server.base_path must be one or more "/segment" parts (URL-safe chars only): got "${raw}"`,
    );
  }
  return withLeading;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function readPassword(
  inline: string | undefined,
  passwordFile: string | undefined,
): string {
  const fromEnv = process.env.OBSIDIAN_CALDAV_PASSWORD;
  if (fromEnv) return fromEnv;
  if (inline) return inline;
  if (passwordFile) return readFileSync(expandHome(passwordFile), "utf8").trim();
  throw new Error(
    "No password configured: set server.password (inline), server.password_file, or OBSIDIAN_CALDAV_PASSWORD env var",
  );
}

/**
 * Reject configs where two calendars share the same vault and have folders
 * that overlap or are duplicates. Cross-vault overlap is fine — same relative
 * path in two different vaults is two different files.
 */
function checkFolderDisjointness(calendars: ResolvedCalendar[]): void {
  const seenIds = new Set<string>();
  for (const c of calendars) {
    if (seenIds.has(c.id)) {
      throw new Error(`Duplicate calendar id "${c.id}"`);
    }
    seenIds.add(c.id);
  }

  // Group by resolved vault path; check disjointness within each vault.
  const byVault = new Map<string, ResolvedCalendar[]>();
  for (const c of calendars) {
    const key = c.resolvedVaultPath;
    const arr = byVault.get(key);
    if (arr) arr.push(c);
    else byVault.set(key, [c]);
  }

  for (const group of byVault.values()) {
    if (group.length < 2) continue;
    const normalized = group.map((c) => ({
      id: c.id,
      folder: c.folder.replace(/^\/+|\/+$/g, ""),
    }));
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        const a = normalized[i]!;
        const b = normalized[j]!;
        if (a.folder === b.folder) {
          throw new Error(
            `Calendars "${a.id}" and "${b.id}" share folder "${a.folder}" in the same vault`,
          );
        }
        const aPrefix = a.folder === "" ? "" : a.folder + "/";
        const bPrefix = b.folder === "" ? "" : b.folder + "/";
        if (
          b.folder === "" ||
          a.folder === "" ||
          (b.folder + "/").startsWith(aPrefix) ||
          (a.folder + "/").startsWith(bPrefix)
        ) {
          throw new Error(
            `Calendar folders overlap in the same vault: "${a.id}" → "${a.folder}", "${b.id}" → "${b.folder}"`,
          );
        }
      }
    }
  }
}

export function loadConfig(path: string): Config {
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), expandHome(path));
  const raw = JSON.parse(readFileSync(absPath, "utf8"));
  const parsed = ConfigSchema.parse(raw);

  const resolvedCalendars: ResolvedCalendar[] = parsed.calendars.map((c) => {
    const vaultPath = expandHome(c.vault_path);
    if (!isAbsolute(vaultPath)) {
      throw new Error(
        `vault_path on calendar "${c.id}" must be absolute: ${c.vault_path}`,
      );
    }
    return {
      ...c,
      resolvedVaultPath: vaultPath,
      resolvedFolderAbs: resolve(vaultPath, c.folder),
    };
  });

  checkFolderDisjointness(resolvedCalendars);

  return {
    ...parsed,
    password: readPassword(parsed.server.password, parsed.server.password_file),
    resolvedStateDir: expandHome(parsed.state_dir),
    calendars: resolvedCalendars,
    basePath: normalizeBasePath(parsed.server.base_path),
  };
}

export function defaultConfigPath(): string {
  if (process.env.OBSIDIAN_CALDAV_CONFIG) return process.env.OBSIDIAN_CALDAV_CONFIG;
  // Prefer ./config.json in the working directory if it exists, otherwise
  // fall back to the XDG-style location under ~/.config.
  const local = resolve(process.cwd(), "config.json");
  try {
    statSync(local);
    return local;
  } catch {
    return resolve(homedir(), ".config/obsidian-caldav/config.json");
  }
}
