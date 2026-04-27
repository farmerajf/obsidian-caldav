import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveRoute, type HandlerContext } from "./handlers.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Logger } from "../logger.js";

export async function handleDelete(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
  writer: VaultWriter,
  logger: Logger,
): Promise<void> {
  const route = resolveRoute(req.url, ctx);
  if (route.kind !== "event") {
    reply.code(404).send();
    return;
  }
  const cal = ctx.calendarsById.get(route.calendarId)!;
  const ev = ctx.store.getEventByUid(route.uid);
  if (!ev || ev.tombstoned || ev.calendar_id !== cal.id) {
    reply.code(404).send();
    return;
  }

  try {
    await writer.setDateProperty(
      cal.resolvedVaultPath,
      ev.vault_path,
      cal.property,
      null,
    );
  } catch (err) {
    logger.error(
      { err, uid: ev.uid, calendarId: cal.id, vaultPath: ev.vault_path },
      "DELETE: clearing date failed",
    );
    reply.code(500).send();
    return;
  }

  ctx.store.tombstone(ev.uid);
  ctx.store.bumpCtag(cal.id);
  logger.info(
    { uid: ev.uid, calendarId: cal.id, vaultPath: ev.vault_path },
    "event deleted (date property cleared)",
  );

  reply.code(204).send();
}
