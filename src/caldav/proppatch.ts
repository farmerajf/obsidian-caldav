import type { FastifyReply, FastifyRequest } from "fastify";
import {
  resolveRoute,
  calendarPath,
  type HandlerContext,
} from "./handlers.js";
import { parseDavXml } from "./xml.js";
import type { Logger } from "../logger.js";

/** Properties clients are allowed to override via PROPPATCH. Anything else → 403. */
const WRITABLE_PROPS = new Set([
  "calendar-color",
  "displayname",
  "calendar-description",
  "calendar-order",
]);

interface PropChange {
  name: string;
  /** undefined = remove */
  value: string | undefined;
}

/**
 * Walk the parsed PROPPATCH body and produce a flat list of property changes.
 * Handles both <d:set> and <d:remove>, each potentially appearing multiple
 * times (fast-xml-parser surfaces those as arrays).
 */
function extractChanges(parsed: unknown): PropChange[] {
  const changes: PropChange[] = [];
  const root = (parsed as Record<string, unknown> | undefined)?.["propertyupdate"];
  if (!root || typeof root !== "object") return changes;

  const collectFrom = (group: unknown, isRemove: boolean) => {
    if (!group) return;
    const groups = Array.isArray(group) ? group : [group];
    for (const g of groups) {
      const prop = (g as Record<string, unknown>)["prop"];
      if (!prop || typeof prop !== "object") continue;
      for (const [name, raw] of Object.entries(prop as Record<string, unknown>)) {
        if (isRemove) {
          changes.push({ name, value: undefined });
        } else {
          changes.push({ name, value: extractText(raw) });
        }
      }
    }
  };

  collectFrom((root as Record<string, unknown>)["set"], false);
  collectFrom((root as Record<string, unknown>)["remove"], true);
  return changes;
}

/**
 * fast-xml-parser surfaces a leaf element as a bare string, but if the
 * element has attributes (Apple Calendar sends `symbolic-color="custom"` on
 * <calendar-color>), it surfaces as an object with the text under "#text".
 * Recover the text in either case.
 */
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (raw && typeof raw === "object") {
    const text = (raw as Record<string, unknown>)["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number" || typeof text === "boolean") return String(text);
  }
  return "";
}

interface PropResult {
  name: string;
  status: 200 | 403 | 422;
}

/**
 * RFC 4918 §9.2 PROPPATCH. Returns 207 Multi-Status with one propstat per
 * status code, listing which properties got that status.
 */
export async function handleProppatch(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
  logger: Logger,
): Promise<void> {
  const route = resolveRoute(req.url, ctx);
  if (route.kind !== "calendar") {
    reply.code(404).send();
    return;
  }
  const cal = ctx.calendarsById.get(route.calendarId)!;

  const body = typeof req.body === "string" ? req.body : "";
  const parsed = parseDavXml(body);
  const changes = extractChanges(parsed);

  const results: PropResult[] = [];
  for (const change of changes) {
    if (!WRITABLE_PROPS.has(change.name)) {
      results.push({ name: change.name, status: 403 });
      continue;
    }
    if (change.value === undefined) {
      ctx.store.deleteCalendarProp(cal.id, change.name);
    } else if (change.name === "calendar-color" && !isHexColor(change.value)) {
      // Reject obviously bogus color values rather than persist them.
      results.push({ name: change.name, status: 422 });
      continue;
    } else {
      ctx.store.setCalendarProp(cal.id, change.name, change.value);
    }
    results.push({ name: change.name, status: 200 });
  }

  // Bump ctag so clients refresh on next poll.
  if (results.some((r) => r.status === 200)) {
    ctx.store.bumpCtag(cal.id);
  }

  logger.info(
    { calendarId: cal.id, changes: results },
    "calendar properties updated",
  );

  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Content-Type", "application/xml; charset=utf-8")
    .code(207)
    .send(buildResponse(calendarPath(ctx, cal.id), results));
}

/** Match #RGB, #RRGGBB, #RRGGBBAA — Apple Calendar emits 8-char hex with alpha. */
function isHexColor(s: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(s.trim());
}

const STATUS_TEXT: Record<number, string> = {
  200: "HTTP/1.1 200 OK",
  403: "HTTP/1.1 403 Forbidden",
  422: "HTTP/1.1 422 Unprocessable Entity",
};

const NS_DAV = "DAV:";
const NS_CAL = "urn:ietf:params:xml:ns:caldav";
const NS_CS = "http://calendarserver.org/ns/";
const NS_ICAL = "http://apple.com/ns/ical/";

function prefixFor(name: string): string {
  switch (name) {
    case "calendar-data":
    case "calendar-description":
    case "calendar-home-set":
    case "calendar-timezone":
    case "supported-calendar-component-set":
      return "c";
    case "getctag":
      return "cs";
    case "calendar-color":
    case "calendar-order":
      return "ical";
    default:
      return "d";
  }
}

function buildResponse(href: string, results: PropResult[]): string {
  const byStatus = new Map<number, string[]>();
  for (const r of results) {
    const arr = byStatus.get(r.status) ?? [];
    arr.push(r.name);
    byStatus.set(r.status, arr);
  }

  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<d:multistatus xmlns:d="${NS_DAV}" xmlns:c="${NS_CAL}" xmlns:cs="${NS_CS}" xmlns:ical="${NS_ICAL}">`,
    `<d:response>`,
    `<d:href>${escapeHref(href)}</d:href>`,
  ];
  for (const [status, names] of byStatus) {
    lines.push(`<d:propstat><d:prop>`);
    for (const n of names) lines.push(`<${prefixFor(n)}:${n}/>`);
    lines.push(`</d:prop><d:status>${STATUS_TEXT[status]}</d:status></d:propstat>`);
  }
  lines.push(`</d:response>`);
  lines.push(`</d:multistatus>`);
  return lines.join("");
}

function escapeHref(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
