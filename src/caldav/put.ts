import type { FastifyReply, FastifyRequest } from "fastify";
import type { HandlerContext } from "./handlers.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Logger } from "../logger.js";
import { parseEvent, renderEvent } from "./ics.js";
import { computeEtag } from "../sync/reconciler.js";

export async function handlePut(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
  writer: VaultWriter,
  logger: Logger,
): Promise<void> {
  const url = req.url.split("?")[0]!;
  const m = /^\/calendars\/[^/]+\/tasks\/([^/]+)\.ics$/.exec(url);
  if (!m) {
    reply.code(404).send();
    return;
  }
  const uidFromPath = decodeURIComponent(m[1]!);
  const body = typeof req.body === "string" ? req.body : "";
  const parsed = parseEvent(body);

  // Apple Calendar always preserves the existing UID on edit. For brand-new
  // events created from the calendar UI (which we don't currently support),
  // the UID would not be in our store. We treat unknown UIDs as 404 — the
  // user creates events by adding files in Obsidian, not the other way.
  const ev = ctx.store.getEventByUid(uidFromPath);
  if (!ev || ev.tombstoned) {
    logger.warn({ uid: uidFromPath, url }, "PUT for unknown event");
    reply.code(404).send();
    return;
  }

  const newDate = parsed.dateValue ?? ev.date_value;
  const newSummary = parsed.summary?.trim() ?? null;

  let vaultPath = ev.vault_path;

  // 1) Handle title change → rename file
  if (newSummary && newSummary !== basenameNoExt(vaultPath)) {
    try {
      const renamed = await writer.renameToTitle(vaultPath, newSummary);
      if (renamed) {
        vaultPath = renamed;
        ctx.store.renamePath(ev.uid, vaultPath);
      }
    } catch (err) {
      logger.error({ err, vaultPath, newSummary }, "rename failed");
      reply.code(409).send();
      return;
    }
  }

  // 2) Handle date change → update frontmatter
  if (newDate !== ev.date_value) {
    try {
      await writer.setDateProperty(vaultPath, newDate);
    } catch (err) {
      logger.error({ err, vaultPath, newDate }, "frontmatter write failed");
      reply.code(500).send();
      return;
    }
  }

  // 3) Update DB row to reflect what we just wrote
  const etag = computeEtag(ev.uid, vaultPath, newDate, ctx.vaultName);
  ctx.store.upsertEvent({
    uid: ev.uid,
    vault_path: vaultPath,
    date_value: newDate,
    etag,
  });
  ctx.store.bumpCtag();

  // Render and return ETag — Apple Calendar uses this to know the body it
  // sent matched what we stored.
  const finalEv = ctx.store.getEventByUid(ev.uid)!;
  const rendered = renderEvent(finalEv, ctx.vaultName);
  void rendered;

  reply.header("ETag", etag).code(204).send();
}

function basenameNoExt(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}
