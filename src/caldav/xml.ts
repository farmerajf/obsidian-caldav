import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseDavXml(body: string): unknown {
  if (!body || body.trim() === "") return {};
  return xmlParser.parse(body);
}

/**
 * Walks an arbitrarily-nested object/array tree and yields all leaf tag names
 * found under a key matching `propPath` (e.g. ["propfind", "prop"]). Used to
 * collect the DAV property names a client asked for.
 */
export function collectRequestedProps(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const propfind = (parsed as Record<string, unknown>)["propfind"];
  if (!propfind || typeof propfind !== "object") return [];
  const prop = (propfind as Record<string, unknown>)["prop"];
  if (!prop || typeof prop !== "object") return [];
  return Object.keys(prop);
}

export interface MultigetRequest {
  hrefs: string[];
}

export function parseCalendarMultiget(parsed: unknown): MultigetRequest {
  const out: string[] = [];
  const root = (parsed as Record<string, unknown>)?.["calendar-multiget"];
  if (!root || typeof root !== "object") return { hrefs: [] };
  const hrefs = (root as Record<string, unknown>)["href"];
  if (typeof hrefs === "string") out.push(hrefs);
  else if (Array.isArray(hrefs)) {
    for (const h of hrefs) if (typeof h === "string") out.push(h);
  }
  return { hrefs: out };
}

// --- builders -------------------------------------------------------------

const NS_DAV = "DAV:";
const NS_CAL = "urn:ietf:params:xml:ns:caldav";
const NS_CS = "http://calendarserver.org/ns/";
const NS_ICAL = "http://apple.com/ns/ical/";

export interface PropResponse {
  href: string;
  /** Map of (prefix:tag) → XML inner content (already escaped). undefined = 404 */
  props: Record<string, string | undefined>;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Map a bare property name to its correct namespace prefix. Apple Calendar
 * (and most clients) match by qualified name, so getting this right matters.
 */
function prefixFor(name: string): string {
  switch (name) {
    case "calendar-data":
    case "calendar-description":
    case "calendar-home-set":
    case "calendar-timezone":
    case "supported-calendar-component-set":
    case "supported-calendar-data":
    case "max-resource-size":
    case "min-date-time":
    case "max-date-time":
    case "max-instances":
    case "max-attendees-per-instance":
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

function renderProp(name: string, value: string | undefined): string {
  const tag = `${prefixFor(name)}:${name}`;
  if (value === undefined) return `<${tag}/>`;
  return `<${tag}>${value}</${tag}>`;
}

export function buildMultistatus(responses: PropResponse[]): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<d:multistatus xmlns:d="${NS_DAV}" xmlns:c="${NS_CAL}" xmlns:cs="${NS_CS}" xmlns:ical="${NS_ICAL}">`,
  ];
  for (const r of responses) {
    lines.push(`<d:response>`);
    lines.push(`<d:href>${esc(r.href)}</d:href>`);
    const found: string[] = [];
    const missing: string[] = [];
    for (const [name, value] of Object.entries(r.props)) {
      if (value === undefined) missing.push(name);
      else found.push(renderProp(name, value));
    }
    if (found.length > 0) {
      lines.push(
        `<d:propstat><d:prop>${found.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`,
      );
    }
    if (missing.length > 0) {
      lines.push(
        `<d:propstat><d:prop>${missing
          .map((n) => `<${prefixFor(n)}:${n}/>`)
          .join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`,
      );
    }
    lines.push(`</d:response>`);
  }
  lines.push(`</d:multistatus>`);
  return lines.join("");
}

export { esc as escapeXml };
