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
      `obsidian-ical — CalDAV server for Obsidian frontmatter dates\n\nUsage: obsidian-ical [--config <path>]\n\nDefault config path: ${defaultConfigPath()}\nOverride with --config or OBSIDIAN_ICAL_CONFIG.\n\nPassword precedence: OBSIDIAN_ICAL_PASSWORD env > server.password (inline) > server.password_file.`,
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
      vault: config.resolvedVaultPath,
      folder: config.vault.folder || "(whole vault)",
      property: config.property,
      stateDir: config.resolvedStateDir,
    },
    "loaded config",
  );

  if (!existsSync(config.resolvedFolderAbs)) {
    logger.error(
      { path: config.resolvedFolderAbs },
      "vault folder does not exist",
    );
    process.exit(1);
  }

  const store = new Store(config.resolvedStateDir);
  const writer = new VaultWriter({
    vaultRoot: config.resolvedVaultPath,
    property: config.property,
    store,
    logger,
  });
  const watcher = new VaultWatcher({
    vaultRoot: config.resolvedVaultPath,
    scanRoot: config.resolvedFolderAbs,
    property: config.property,
    vaultName: config.vault.name,
    store,
    logger,
  });
  await watcher.start();

  const server = await buildServer({
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    password: config.password,
    store,
    vaultName: config.vault.name,
    writer,
    logger,
  });

  await server.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    { url: `http://${config.server.host}:${config.server.port}/` },
    "CalDAV server listening",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await server.close();
      await watcher.stop();
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
