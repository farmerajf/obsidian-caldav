import type { FastifyReply, FastifyRequest } from "fastify";
import type { HandlerContext } from "./handlers.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Logger } from "../logger.js";

export async function handleDelete(
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
  const uid = decodeURIComponent(m[1]!);
  const ev = ctx.store.getEventByUid(uid);
  if (!ev || ev.tombstoned) {
    reply.code(404).send();
    return;
  }

  try {
    await writer.setDateProperty(ev.vault_path, null);
  } catch (err) {
    logger.error({ err, uid, vaultPath: ev.vault_path }, "DELETE: clearing date failed");
    reply.code(500).send();
    return;
  }

  ctx.store.tombstone(uid);
  ctx.store.bumpCtag();
  logger.info({ uid, vaultPath: ev.vault_path }, "event deleted (date property cleared)");

  reply.code(204).send();
}
