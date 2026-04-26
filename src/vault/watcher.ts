import chokidar, { type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import type { Store } from "../db.js";
import type { Logger } from "../logger.js";
import { scanVault } from "./scanner.js";
import { reconcile } from "../sync/reconciler.js";

export interface WatcherOptions {
  vaultRoot: string;
  scanRoot: string;
  property: string;
  vaultName: string;
  store: Store;
  logger: Logger;
  /** Coalesce bursts of fs events into a single rescan. */
  debounceMs?: number;
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;

  constructor(private readonly opts: WatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 250;
  }

  async start(): Promise<void> {
    // Initial full scan + reconcile so DB matches vault state on boot.
    await this.runReconcile("initial");

    this.watcher = chokidar.watch(this.opts.scanRoot, {
      ignored: (path: string) =>
        path.includes("/.obsidian/") ||
        path.includes("/.git/") ||
        path.includes("/.trash/"),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      persistent: true,
    });

    const onEvent = (eventType: string) => async (path: string) => {
      if (!path.endsWith(".md")) return;
      const suppressed = await this.shouldSuppress(path, eventType);
      if (suppressed) {
        this.opts.logger.debug({ path, eventType }, "fs event suppressed (loop)");
        return;
      }
      this.opts.logger.debug({ path, eventType }, "fs event");
      this.scheduleRescan();
    };

    this.watcher
      .on("add", onEvent("add"))
      .on("change", onEvent("change"))
      .on("unlink", onEvent("unlink"));
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.watcher?.close();
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.runReconcile("watcher").catch((err) => {
        this.opts.logger.error({ err }, "reconcile failed");
      });
    }, this.debounceMs);
  }

  private async runReconcile(reason: string): Promise<void> {
    const t0 = Date.now();
    const scanned = await scanVault({
      vaultRoot: this.opts.vaultRoot,
      scanRoot: this.opts.scanRoot,
      property: this.opts.property,
      logger: this.opts.logger,
    });
    const result = reconcile(
      this.opts.store,
      scanned,
      { vaultName: this.opts.vaultName },
      this.opts.logger,
    );
    this.opts.logger.info(
      {
        reason,
        scannedCount: scanned.length,
        actions: result.actions.length,
        ms: Date.now() - t0,
      },
      "reconciled",
    );
  }

  /**
   * Decide whether an fs event was caused by our own write. For change events
   * we compare mtime (with 50ms fuzz) against pending_writes. For unlink, we
   * just check whether the path is in pending_writes at all.
   */
  private async shouldSuppress(absPath: string, eventType: string): Promise<boolean> {
    const vaultRel = this.toVaultPath(absPath);
    if (!vaultRel) return false;

    if (eventType === "unlink") {
      // No mtime to compare; consume any pending write for this path.
      const consumed = this.opts.store.consumePendingWrite(vaultRel, 0);
      if (consumed) return true;
      // Also clear any stale entry to avoid leakage.
      this.opts.store.clearPendingWrite(vaultRel);
      return false;
    }

    try {
      const st = await stat(absPath);
      return this.opts.store.consumePendingWrite(vaultRel, st.mtimeMs);
    } catch {
      return false;
    }
  }

  private toVaultPath(absPath: string): string | null {
    const root = this.opts.vaultRoot.endsWith("/")
      ? this.opts.vaultRoot
      : this.opts.vaultRoot + "/";
    if (!absPath.startsWith(root)) return null;
    return absPath.slice(root.length);
  }
}
