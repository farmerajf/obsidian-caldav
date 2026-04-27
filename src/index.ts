import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultConfigPath, loadConfig } from "./config.js";
import { Store } from "./db.js";
import { logger } from "./logger.js";
import { VaultWatcher } from "./vault/watcher.js";
import { VaultWriter } from "./vault/writer.js";
import { buildServer } from "./caldav/server.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      `obsidian-caldav — CalDAV server for Obsidian frontmatter dates\n\nUsage: obsidian-caldav [--config <path>]\n\nDefault config path: ${defaultConfigPath()}\nOverride with --config or OBSIDIAN_CALDAV_CONFIG.\n\nPassword precedence: OBSIDIAN_CALDAV_PASSWORD env > server.password (inline) > server.password_file.`,
    );
    return;
  }

  const configPath = values.config ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    logger.error({ configPath }, "config file not found");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  logger.info(
    {
      calendars: config.calendars.map((c) => ({
        id: c.id,
        name: c.name,
        vault: c.vault_name,
        folder: c.folder,
        property: c.property,
      })),
      stateDir: config.resolvedStateDir,
    },
    "loaded config",
  );

  for (const cal of config.calendars) {
    if (!existsSync(cal.resolvedVaultPath)) {
      logger.error(
        { calendarId: cal.id, path: cal.resolvedVaultPath },
        "vault path does not exist",
      );
      process.exit(1);
    }
    if (!existsSync(cal.resolvedFolderAbs)) {
      logger.error(
        { calendarId: cal.id, path: cal.resolvedFolderAbs },
        "calendar folder does not exist",
      );
      process.exit(1);
    }
  }

  const store = new Store(config.resolvedStateDir);
  store.ensureCalendars(config.calendars.map((c) => c.id));

  const writer = new VaultWriter({ store, logger });

  const watchers: VaultWatcher[] = [];
  for (const cal of config.calendars) {
    const watcher = new VaultWatcher({
      vaultRoot: cal.resolvedVaultPath,
      scanRoot: cal.resolvedFolderAbs,
      property: cal.property,
      statusProperty: cal.status_property,
      statusIcons: cal.status_icons,
      calendarId: cal.id,
      vaultName: cal.vault_name,
      store,
      logger,
    });
    await watcher.start();
    watchers.push(watcher);
  }

  const server = await buildServer({
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    password: config.password,
    store,
    calendars: config.calendars,
    writer,
    logger,
    basePath: config.basePath,
  });

  await server.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    {
      url: `http://${config.server.host}:${config.server.port}${config.basePath}/`,
      basePath: config.basePath || "(root)",
    },
    "CalDAV server listening",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await server.close();
      for (const w of watchers) await w.stop();
      store.db.close();
    } catch (err) {
      logger.error({ err }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
