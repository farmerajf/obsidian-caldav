import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  vault: z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    folder: z.string().default(""),
  }),
  property: z.string().min(1),
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(5232),
    username: z.string().min(1),
    password: z.string().optional(),
    password_file: z.string().optional(),
  }),
  state_dir: z.string().default("./state"),
});

export type Config = z.infer<typeof ConfigSchema> & {
  password: string;
  resolvedStateDir: string;
  resolvedVaultPath: string;
  resolvedFolderAbs: string;
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function readPassword(
  inline: string | undefined,
  passwordFile: string | undefined,
): string {
  const fromEnv = process.env.OBSIDIAN_ICAL_PASSWORD;
  if (fromEnv) return fromEnv;
  if (inline) return inline;
  if (passwordFile) return readFileSync(expandHome(passwordFile), "utf8").trim();
  throw new Error(
    "No password configured: set server.password (inline), server.password_file, or OBSIDIAN_ICAL_PASSWORD env var",
  );
}

export function loadConfig(path: string): Config {
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), expandHome(path));
  const raw = JSON.parse(readFileSync(absPath, "utf8"));
  const parsed = ConfigSchema.parse(raw);

  const vaultPath = expandHome(parsed.vault.path);
  if (!isAbsolute(vaultPath)) {
    throw new Error(`vault.path must be absolute: ${parsed.vault.path}`);
  }

  const folderAbs = parsed.vault.folder
    ? resolve(vaultPath, parsed.vault.folder)
    : vaultPath;

  return {
    ...parsed,
    password: readPassword(parsed.server.password, parsed.server.password_file),
    resolvedStateDir: expandHome(parsed.state_dir),
    resolvedVaultPath: vaultPath,
    resolvedFolderAbs: folderAbs,
  };
}

export function defaultConfigPath(): string {
  if (process.env.OBSIDIAN_ICAL_CONFIG) return process.env.OBSIDIAN_ICAL_CONFIG;
  // Prefer ./config.json in the working directory if it exists, otherwise
  // fall back to the XDG-style location under ~/.config.
  const local = resolve(process.cwd(), "config.json");
  try {
    statSync(local);
    return local;
  } catch {
    return resolve(homedir(), ".config/obsidian-ical/config.json");
  }
}
