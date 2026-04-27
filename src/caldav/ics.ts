import type { EventRow } from "../db.js";
import { isAllDay } from "../vault/scanner.js";

const CRLF = "\r\n";
const PRODID = "-//obsidian-caldav//EN";

/**
 * Zero-width space inserted between the status icon and the filename in the
 * rendered SUMMARY. On the way back in (PUT), we slice off everything up to
 * and including the SEP to recover the bare filename — so the icon prefix
 * never leaks into the .md filename even if the user later changes the
 * configured icon. The user almost certainly won't type a U+200B themselves.
 */
const SEP = "​";

export interface ParsedEvent {
  uid: string;
  summary: string | null;
  /** ISO-ish: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS" (local) */
  dateValue: string | null;
}

function basenameNoExt(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, "0");
}

/** "20260501" or "20260501T140000" depending on isAllDay */
function formatDtstart(dateValue: string): { value: string; allDay: boolean } {
  if (isAllDay(dateValue)) {
    return { value: dateValue.replaceAll("-", ""), allDay: true };
  }
  // dateValue is "YYYY-MM-DDTHH:MM:SS" local time. Emit as floating local.
  const [d, t] = dateValue.split("T");
  return { value: `${d!.replaceAll("-", "")}T${t!.replaceAll(":", "")}`, allDay: false };
}

function plusOneDay(yyyymmdd: string): string {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

function plusOneHour(stamp: string): string {
  // stamp is "YYYYMMDDTHHMMSS"
  const y = parseInt(stamp.slice(0, 4), 10);
  const mo = parseInt(stamp.slice(4, 6), 10) - 1;
  const d = parseInt(stamp.slice(6, 8), 10);
  const h = parseInt(stamp.slice(9, 11), 10);
  const mi = parseInt(stamp.slice(11, 13), 10);
  const se = parseInt(stamp.slice(13, 15), 10);
  const dt = new Date(y, mo, d, h, mi, se);
  dt.setHours(dt.getHours() + 1);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}

/**
 * Strip a leading icon-prefix from a SUMMARY received via PUT. We rendered
 * `<icon> <SEP><name>` outbound; if SEP is present, slice everything up to
 * and including it. If not (no icon was rendered, or the user retyped the
 * whole title from scratch), return the SUMMARY unchanged.
 */
export function stripSummaryPrefix(summary: string): string {
  const idx = summary.indexOf(SEP);
  if (idx < 0) return summary;
  return summary.slice(idx + SEP.length);
}

export function obsidianUrl(vaultName: string, vaultPath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(
    vaultPath,
  )}`;
}

/**
 * Render a single VEVENT. We pin DTSTAMP to a stable value derived from the
 * event so the body is deterministic — this lets us hash it for ETag.
 *
 * `statusIcon` (if provided) is prepended to SUMMARY with a single space.
 */
export function renderEvent(
  row: EventRow,
  vaultName: string,
  statusIcon?: string,
): string {
  const baseSummary = basenameNoExt(row.vault_path);
  // Visible space between icon and name; ZWSP marks the boundary so PUT can
  // strip the prefix back off without needing to know which icon was used.
  const summary = statusIcon ? `${statusIcon} ${SEP}${baseSummary}` : baseSummary;
  const url = obsidianUrl(vaultName, row.vault_path);
  const dtstart = formatDtstart(row.date_value);
  const stableDtstamp = "19700101T000000Z"; // deterministic for ETag stability

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${row.uid}@obsidian-caldav`,
    `DTSTAMP:${stableDtstamp}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (dtstart.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dtstart.value}`);
    lines.push(`DTEND;VALUE=DATE:${plusOneDay(dtstart.value)}`);
  } else {
    lines.push(`DTSTART:${dtstart.value}`);
    lines.push(`DTEND:${plusOneHour(dtstart.value)}`);
  }
  lines.push(`URL:${url}`);
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

/**
 * Unfold lines per RFC 5545 §3.1: a CRLF followed by a single space or tab is
 * a continuation of the prior line.
 */
function unfold(body: string): string[] {
  const raw = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface IcsLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): IcsLine | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(";");
  const name = parts[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf("=");
    if (eq < 0) continue;
    params[parts[i]!.slice(0, eq).toUpperCase()] = parts[i]!.slice(eq + 1);
  }
  return { name, params, value };
}

/**
 * "20260501" (allDay) → "2026-05-01"
 * "20260501T140000"  → "2026-05-01T14:00:00"
 * "20260501T140000Z" → "2026-05-01T14:00:00" (treat Z as local — Apple Calendar
 *    sends UTC for floating events sometimes; we accept and store as wall clock).
 *    A more correct version would convert to local TZ; for personal use
 *    floating-as-stored is fine.
 */
function parseIcsDateTime(value: string, allDay: boolean): string | null {
  if (allDay) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

export function parseEvent(body: string): ParsedEvent {
  const lines = unfold(body);
  let inEvent = false;
  let uid: string | null = null;
  let summary: string | null = null;
  let dateValue: string | null = null;

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN" && line.value === "VEVENT") {
      inEvent = true;
      continue;
    }
    if (line.name === "END" && line.value === "VEVENT") {
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    switch (line.name) {
      case "UID": {
        // Strip "@obsidian-caldav" suffix if present so we can look up by raw UID.
        const v = line.value.replace(/@obsidian-caldav$/, "");
        uid = v;
        break;
      }
      case "SUMMARY":
        summary = stripSummaryPrefix(unescapeText(line.value));
        break;
      case "DTSTART": {
        const allDay = line.params["VALUE"] === "DATE";
        dateValue = parseIcsDateTime(line.value, allDay);
        break;
      }
    }
  }

  return { uid: uid ?? "", summary, dateValue };
}

/** Compose a multi-event VCALENDAR (used by some REPORT responses, optional). */
export function renderCalendar(rows: EventRow[], vaultName: string): string {
  if (rows.length === 0) {
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${PRODID}`,
      "CALSCALE:GREGORIAN",
      "END:VCALENDAR",
      "",
    ].join(CRLF);
  }
  const inner = rows.map((r) => {
    const single = renderEvent(r, vaultName);
    // strip outer VCALENDAR wrappers
    const ls = single.split(CRLF);
    const start = ls.indexOf("BEGIN:VEVENT");
    const end = ls.indexOf("END:VEVENT");
    return ls.slice(start, end + 1).join(CRLF);
  });
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${PRODID}`,
      "CALSCALE:GREGORIAN",
      ...inner,
      "END:VCALENDAR",
      "",
    ].join(CRLF)
  );
}
