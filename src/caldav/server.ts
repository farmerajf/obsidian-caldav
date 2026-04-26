import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "../db.js";
import type { Logger } from "../logger.js";
import {
  handleGet,
  handleOptions,
  handlePropfind,
  handleReport,
  type HandlerContext,
} from "./handlers.js";
import { handlePut } from "./put.js";
import { handleDelete } from "./delete.js";
import type { VaultWriter } from "../vault/writer.js";

export interface ServerOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  store: Store;
  vaultName: string;
  writer: VaultWriter;
  logger: Logger;
}

function checkBasicAuth(header: string | undefined, user: string, pass: string): boolean {
  if (!header || !header.toLowerCase().startsWith("basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expected = `${user}:${pass}`;
  const a = Buffer.from(decoded);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  // Fastify only knows standard HTTP methods by default; CalDAV needs these.
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });

  // Treat all DAV bodies as raw text — fast-xml-parser handles parsing later.
  app.addContentTypeParser(
    ["application/xml", "text/xml", "text/calendar"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Some CalDAV clients send no Content-Type on PROPFIND; catch-all parser.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  const ctx: HandlerContext = {
    store: opts.store,
    username: opts.username,
    vaultName: opts.vaultName,
  };

  app.addHook("onRequest", async (req, reply) => {
    opts.logger.debug(
      { method: req.method, url: req.url, depth: req.headers["depth"] },
      "request",
    );
    // OPTIONS pre-flight for discovery doesn't need auth in some clients,
    // but Apple Calendar always sends Authorization once configured. We
    // still allow OPTIONS without auth so initial probe succeeds.
    if (req.method === "OPTIONS") return;
    if (!checkBasicAuth(req.headers.authorization, opts.username, opts.password)) {
      reply
        .header("WWW-Authenticate", `Basic realm="obsidian-ical"`)
        .code(401)
        .send();
    }
  });

  // Single catch-all route across all methods we accept. Registering HEAD
  // separately conflicts with Fastify's auto-HEAD-from-GET, so omit it.
  app.route({
    method: ["PROPFIND", "REPORT", "OPTIONS", "GET", "PUT", "DELETE"] as never,
    url: "/*",
    handler: async (req, reply) => {
      switch (req.method) {
        case "OPTIONS":
          return handleOptions(req, reply);
        case "PROPFIND":
          return handlePropfind(req, reply, ctx);
        case "REPORT":
          return handleReport(req, reply, ctx);
        case "GET":
        case "HEAD":
          return handleGet(req, reply, ctx);
        case "PUT":
          return handlePut(req, reply, ctx, opts.writer, opts.logger);
        case "DELETE":
          return handleDelete(req, reply, ctx, opts.writer, opts.logger);
        default:
          reply.code(405).send();
      }
    },
  });

  return app;
}
