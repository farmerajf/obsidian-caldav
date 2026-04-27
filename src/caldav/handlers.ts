import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../db.js";
import type { ResolvedCalendar } from "../config.js";
import {
  buildMultistatus,
  collectRequestedProps,
  escapeXml,
  parseCalendarMultiget,
  parseDavXml,
  type PropResponse,
} from "./xml.js";
import { renderEvent } from "./ics.js";

export interface HandlerContext {
  store: Store;
  username: string;
  calendars: ResolvedCalendar[];
  calendarsById: Map<string, ResolvedCalendar>;
  /** Empty string or `/segment` — prepended to all emitted hrefs and stripped from incoming URLs. */
  basePath: string;
}

const ALLOWED_METHODS = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT";
const DEFAULT_COLOR = "#7C3AED";

export function handleOptions(_req: FastifyRequest, reply: FastifyReply): void {
  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Allow", ALLOWED_METHODS)
    .header("Content-Length", "0")
    .code(200)
    .send();
}

// --- URL routing ---------------------------------------------------------

export type Route =
  | { kind: "root" }
  | { kind: "principal" }
  | { kind: "calendar-home" }
  | { kind: "calendar"; calendarId: string }
  | { kind: "event"; calendarId: string; uid: string }
  | { kind: "unknown" };

function calendarHomePath(ctx: HandlerContext): string {
  return `${ctx.basePath}/calendars/${encodeURIComponent(ctx.username)}/`;
}

function principalPath(ctx: HandlerContext): string {
  return `${ctx.basePath}/principals/${encodeURIComponent(ctx.username)}/`;
}

export function calendarPath(ctx: HandlerContext, calendarId: string): string {
  return `${ctx.basePath}/calendars/${encodeURIComponent(ctx.username)}/${encodeURIComponent(calendarId)}/`;
}

export function eventPath(ctx: HandlerContext, calendarId: string, uid: string): string {
  return `${ctx.basePath}/calendars/${encodeURIComponent(ctx.username)}/${encodeURIComponent(calendarId)}/${encodeURIComponent(uid)}.ics`;
}

export function resolveRoute(rawUrl: string, ctx: HandlerContext): Route {
  let url = rawUrl.split("?")[0]!;

  // Lenient prefix handling: if the configured base_path is present on the
  // incoming URL, strip it. If it isn't, fall through and match at root.
  // This lets a single config (`base_path`) work behind both proxies that
  // preserve the prefix and proxies that strip it (e.g. Tailscale Serve),
  // while always emitting hrefs WITH the prefix so clients walk back through
  // the proxy correctly.
  if (ctx.basePath !== "") {
    if (url === ctx.basePath || url === `${ctx.basePath}/`) {
      url = "/";
    } else if (url.startsWith(`${ctx.basePath}/`)) {
      url = url.slice(ctx.basePath.length);
    }
  }

  if (url === "/" || url === "") return { kind: "root" };

  const principalLocal = `/principals/${encodeURIComponent(ctx.username)}/`;
  if (url === principalLocal || url === principalLocal.replace(/\/$/, "")) {
    return { kind: "principal" };
  }

  const homeLocal = `/calendars/${encodeURIComponent(ctx.username)}/`;
  if (url === homeLocal || url === homeLocal.replace(/\/$/, "")) {
    return { kind: "calendar-home" };
  }

  // /calendars/<user>/<calId>/ or /calendars/<user>/<calId>/<uid>.ics
  const userPrefix = `/calendars/${encodeURIComponent(ctx.username)}/`;
  if (!url.startsWith(userPrefix)) return { kind: "unknown" };
  const rest = url.slice(userPrefix.length);
  const slashIdx = rest.indexOf("/");
  const calIdRaw = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const calendarId = decodeURIComponent(calIdRaw);
  if (!ctx.calendarsById.has(calendarId)) return { kind: "unknown" };

  const tail = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
  if (tail === "" || tail === "/") return { kind: "calendar", calendarId };

  const eventMatch = /^([^/]+)\.ics$/.exec(tail);
  if (eventMatch) {
    const uid = decodeURIComponent(eventMatch[1]!);
    return { kind: "event", calendarId, uid };
  }

  return { kind: "unknown" };
}

// --- Property builders ---------------------------------------------------

function rootProps(ctx: HandlerContext, requested: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "current-user-principal":
      case "principal-URL":
        out[name] = `<d:href>${principalPath(ctx)}</d:href>`;
        break;
      case "resourcetype":
        out[name] = `<d:collection/>`;
        break;
      case "displayname":
        out[name] = escapeXml("obsidian-caldav");
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

function principalProps(
  ctx: HandlerContext,
  requested: string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "current-user-principal":
      case "principal-URL":
        out[name] = `<d:href>${principalPath(ctx)}</d:href>`;
        break;
      case "calendar-home-set":
        out[name] = `<d:href>${calendarHomePath(ctx)}</d:href>`;
        break;
      case "displayname":
        out[name] = escapeXml(ctx.username);
        break;
      case "resourcetype":
        out[name] = `<d:collection/><d:principal/>`;
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

function calendarHomeProps(
  ctx: HandlerContext,
  requested: string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "resourcetype":
        out[name] = `<d:collection/>`;
        break;
      case "displayname":
        out[name] = escapeXml("Calendars");
        break;
      case "current-user-principal":
        out[name] = `<d:href>${principalPath(ctx)}</d:href>`;
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

function calendarProps(
  ctx: HandlerContext,
  cal: ResolvedCalendar,
  requested: string[],
): Record<string, string | undefined> {
  const ctag = ctx.store.getCtag(cal.id);
  // Stored override (set by client via PROPPATCH) > config value > default.
  const stored = (name: string): string | undefined =>
    ctx.store.getCalendarProp(cal.id, name);
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "resourcetype":
        out[name] = `<d:collection/><c:calendar/>`;
        break;
      case "displayname":
        out[name] = escapeXml(stored("displayname") ?? cal.name);
        break;
      case "calendar-description":
        out[name] = escapeXml(
          stored("calendar-description") ??
            cal.description ??
            `Tasks from ${cal.folder} (${cal.property})`,
        );
        break;
      case "supported-calendar-component-set":
        out[name] = `<c:comp name="VEVENT"/>`;
        break;
      case "getctag":
        out[name] = escapeXml(ctag);
        break;
      case "calendar-color":
        out[name] = escapeXml(stored("calendar-color") ?? cal.color ?? DEFAULT_COLOR);
        break;
      case "calendar-order": {
        const order = stored("calendar-order");
        out[name] = order !== undefined ? escapeXml(order) : undefined;
        break;
      }
      case "current-user-principal":
        out[name] = `<d:href>${principalPath(ctx)}</d:href>`;
        break;
      case "current-user-privilege-set":
        out[name] =
          `<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-properties/></d:privilege><d:privilege><d:write-content/></d:privilege>`;
        break;
      case "owner":
        out[name] = `<d:href>${principalPath(ctx)}</d:href>`;
        break;
      case "supported-report-set":
        out[name] = [
          `<d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>`,
          `<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report>`,
        ].join("");
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

function eventProps(
  etag: string,
  body: string,
  requested: string[],
  includeData: boolean,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "getetag":
        out[name] = escapeXml(etag);
        break;
      case "getcontenttype":
        out[name] = `text/calendar; charset=utf-8; component=VEVENT`;
        break;
      case "calendar-data":
        out[name] = includeData ? escapeXml(body) : "";
        break;
      case "resourcetype":
        out[name] = ``; // empty resourcetype = a non-collection resource
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

// --- Method handlers -----------------------------------------------------

export async function handlePropfind(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
): Promise<void> {
  const depth = String(req.headers["depth"] ?? "0");
  const body = typeof req.body === "string" ? req.body : "";
  const parsed = parseDavXml(body);
  let requested = collectRequestedProps(parsed);
  // Default props if client sent <propname/> or empty body
  if (requested.length === 0) {
    requested = [
      "resourcetype",
      "displayname",
      "current-user-principal",
      "calendar-home-set",
      "getctag",
    ];
  }

  const route = resolveRoute(req.url, ctx);
  const responses: PropResponse[] = [];

  switch (route.kind) {
    case "root": {
      responses.push({ href: "/", props: rootProps(ctx, requested) });
      break;
    }
    case "principal": {
      const principal = principalPath(ctx);
      responses.push({ href: principal, props: principalProps(ctx, requested) });
      break;
    }
    case "calendar-home": {
      const home = calendarHomePath(ctx);
      responses.push({ href: home, props: calendarHomeProps(ctx, requested) });
      if (depth !== "0") {
        for (const cal of ctx.calendars) {
          responses.push({
            href: calendarPath(ctx, cal.id),
            props: calendarProps(ctx, cal, requested),
          });
        }
      }
      break;
    }
    case "calendar": {
      const cal = ctx.calendarsById.get(route.calendarId)!;
      responses.push({
        href: calendarPath(ctx, cal.id),
        props: calendarProps(ctx, cal, requested),
      });
      if (depth !== "0") {
        for (const ev of ctx.store.getAllLiveEvents(cal.id)) {
          const renderedBody = renderEvent(ev, cal.vault_name);
          responses.push({
            href: eventPath(ctx, cal.id, ev.uid),
            props: eventProps(ev.etag, renderedBody, requested, false),
          });
        }
      }
      break;
    }
    case "event": {
      const ev = ctx.store.getEventByUid(route.uid);
      if (!ev || ev.tombstoned || ev.calendar_id !== route.calendarId) {
        reply.code(404).send();
        return;
      }
      const cal = ctx.calendarsById.get(route.calendarId)!;
      const renderedBody = renderEvent(ev, cal.vault_name);
      responses.push({
        href: eventPath(ctx, route.calendarId, ev.uid),
        props: eventProps(ev.etag, renderedBody, requested, false),
      });
      break;
    }
    case "unknown": {
      reply.code(404).send();
      return;
    }
  }

  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Content-Type", `application/xml; charset=utf-8`)
    .code(207)
    .send(buildMultistatus(responses));
}

export async function handleReport(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
): Promise<void> {
  const route = resolveRoute(req.url, ctx);
  if (route.kind !== "calendar") {
    reply.code(404).send();
    return;
  }
  const cal = ctx.calendarsById.get(route.calendarId)!;
  const body = typeof req.body === "string" ? req.body : "";
  const parsed = parseDavXml(body) as Record<string, unknown>;

  let hrefsToFetch: string[] | null = null;
  let requested: string[] = [];

  if (parsed["calendar-multiget"]) {
    const mg = parseCalendarMultiget(parsed);
    hrefsToFetch = mg.hrefs;
    const propsObj = (parsed["calendar-multiget"] as Record<string, unknown>)["prop"];
    if (propsObj && typeof propsObj === "object") {
      requested = Object.keys(propsObj as Record<string, unknown>);
    }
  } else if (parsed["calendar-query"]) {
    // Return all events. We ignore filter — Apple Calendar typically issues
    // a multiget after the initial query, so this is a small simplification.
    const propsObj = (parsed["calendar-query"] as Record<string, unknown>)["prop"];
    if (propsObj && typeof propsObj === "object") {
      requested = Object.keys(propsObj as Record<string, unknown>);
    }
  } else {
    reply.code(400).send("unsupported REPORT");
    return;
  }
  if (requested.length === 0) requested = ["getetag", "calendar-data"];

  const responses: PropResponse[] = [];
  if (hrefsToFetch) {
    for (const href of hrefsToFetch) {
      const m = /\/([^/]+)\/([^/]+)\.ics$/.exec(href);
      if (!m) continue;
      const hrefCalId = decodeURIComponent(m[1]!);
      if (hrefCalId !== cal.id) continue;
      const uid = decodeURIComponent(m[2]!);
      const ev = ctx.store.getEventByUid(uid);
      if (!ev || ev.tombstoned || ev.calendar_id !== cal.id) continue;
      const renderedBody = renderEvent(ev, cal.vault_name);
      responses.push({
        href,
        props: eventProps(ev.etag, renderedBody, requested, true),
      });
    }
  } else {
    for (const ev of ctx.store.getAllLiveEvents(cal.id)) {
      const renderedBody = renderEvent(ev, cal.vault_name);
      responses.push({
        href: eventPath(ctx, cal.id, ev.uid),
        props: eventProps(ev.etag, renderedBody, requested, true),
      });
    }
  }

  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Content-Type", `application/xml; charset=utf-8`)
    .code(207)
    .send(buildMultistatus(responses));
}

export async function handleGet(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
): Promise<void> {
  const route = resolveRoute(req.url, ctx);
  if (route.kind !== "event") {
    reply.code(404).send();
    return;
  }
  const ev = ctx.store.getEventByUid(route.uid);
  if (!ev || ev.tombstoned || ev.calendar_id !== route.calendarId) {
    reply.code(404).send();
    return;
  }
  const cal = ctx.calendarsById.get(route.calendarId)!;
  const body = renderEvent(ev, cal.vault_name);
  reply
    .header("ETag", ev.etag)
    .header("Content-Type", "text/calendar; charset=utf-8")
    .code(200)
    .send(body);
}
