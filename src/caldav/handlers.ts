import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../db.js";
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
  vaultName: string;
}

const ALLOWED_METHODS = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT";

export function handleOptions(_req: FastifyRequest, reply: FastifyReply): void {
  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Allow", ALLOWED_METHODS)
    .header("Content-Length", "0")
    .code(200)
    .send();
}

function calendarHomePath(user: string): string {
  return `/calendars/${encodeURIComponent(user)}/`;
}

function principalPath(user: string): string {
  return `/principals/${encodeURIComponent(user)}/`;
}

function calendarPath(user: string): string {
  return `/calendars/${encodeURIComponent(user)}/tasks/`;
}

function eventPath(user: string, uid: string): string {
  return `/calendars/${encodeURIComponent(user)}/tasks/${encodeURIComponent(uid)}.ics`;
}

function rootProps(ctx: HandlerContext, requested: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "current-user-principal":
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
        break;
      case "principal-URL":
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
        break;
      case "resourcetype":
        out[name] = `<d:collection/>`;
        break;
      case "displayname":
        out[name] = escapeXml("obsidian-ical");
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
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
        break;
      case "calendar-home-set":
        out[name] = `<d:href>${calendarHomePath(ctx.username)}</d:href>`;
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
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
        break;
      default:
        out[name] = undefined;
    }
  }
  return out;
}

function calendarProps(
  ctx: HandlerContext,
  requested: string[],
): Record<string, string | undefined> {
  const ctag = ctx.store.getCtag();
  const out: Record<string, string | undefined> = {};
  for (const name of requested) {
    switch (name) {
      case "resourcetype":
        out[name] = `<d:collection/><c:calendar/>`;
        break;
      case "displayname":
        out[name] = escapeXml("Obsidian Tasks");
        break;
      case "calendar-description":
        out[name] = escapeXml("Tasks from Obsidian frontmatter dates");
        break;
      case "supported-calendar-component-set":
        out[name] = `<c:comp name="VEVENT"/>`;
        break;
      case "getctag":
        out[name] = escapeXml(ctag);
        break;
      case "calendar-color":
        out[name] = `#7C3AED`;
        break;
      case "current-user-principal":
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
        break;
      case "current-user-privilege-set":
        out[name] =
          `<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-properties/></d:privilege><d:privilege><d:write-content/></d:privilege>`;
        break;
      case "owner":
        out[name] = `<d:href>${principalPath(ctx.username)}</d:href>`;
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
  uid: string,
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
    void uid;
  }
  return out;
}

export async function handlePropfind(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: HandlerContext,
): Promise<void> {
  const depth = String(req.headers["depth"] ?? "0");
  const url = req.url.split("?")[0]!;
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

  const responses: PropResponse[] = [];
  const calRoot = calendarPath(ctx.username);
  const calHome = calendarHomePath(ctx.username);
  const principal = principalPath(ctx.username);

  if (url === "/" || url === "") {
    responses.push({ href: "/", props: rootProps(ctx, requested) });
  } else if (url === principal || url === principal.replace(/\/$/, "")) {
    responses.push({ href: principal, props: principalProps(ctx, requested) });
  } else if (url === calHome || url === calHome.replace(/\/$/, "")) {
    responses.push({ href: calHome, props: calendarHomeProps(ctx, requested) });
    if (depth !== "0") {
      responses.push({ href: calRoot, props: calendarProps(ctx, requested) });
    }
  } else if (url === calRoot || url === calRoot.replace(/\/$/, "")) {
    responses.push({ href: calRoot, props: calendarProps(ctx, requested) });
    if (depth !== "0") {
      for (const ev of ctx.store.getAllLiveEvents()) {
        const body = renderEvent(ev, ctx.vaultName);
        responses.push({
          href: eventPath(ctx.username, ev.uid),
          props: eventProps(ev.uid, ev.etag, body, requested, false),
        });
      }
    }
  } else {
    // Possibly an event resource
    const m = /^\/calendars\/[^/]+\/tasks\/([^/]+)\.ics$/.exec(url);
    if (m) {
      const uid = decodeURIComponent(m[1]!);
      const ev = ctx.store.getEventByUid(uid);
      if (!ev || ev.tombstoned) {
        reply.code(404).send();
        return;
      }
      const body = renderEvent(ev, ctx.vaultName);
      responses.push({
        href: eventPath(ctx.username, ev.uid),
        props: eventProps(ev.uid, ev.etag, body, requested, false),
      });
    } else {
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
  const url = req.url.split("?")[0]!;
  const calRoot = calendarPath(ctx.username);
  if (url !== calRoot && url !== calRoot.replace(/\/$/, "")) {
    reply.code(404).send();
    return;
  }
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
      const m = /\/tasks\/([^/]+)\.ics$/.exec(href);
      if (!m) continue;
      const uid = decodeURIComponent(m[1]!);
      const ev = ctx.store.getEventByUid(uid);
      if (!ev || ev.tombstoned) continue;
      const body = renderEvent(ev, ctx.vaultName);
      responses.push({
        href,
        props: eventProps(ev.uid, ev.etag, body, requested, true),
      });
    }
  } else {
    for (const ev of ctx.store.getAllLiveEvents()) {
      const body = renderEvent(ev, ctx.vaultName);
      responses.push({
        href: eventPath(ctx.username, ev.uid),
        props: eventProps(ev.uid, ev.etag, body, requested, true),
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
  const body = renderEvent(ev, ctx.vaultName);
  reply
    .header("ETag", ev.etag)
    .header("Content-Type", "text/calendar; charset=utf-8")
    .code(200)
    .send(body);
}
