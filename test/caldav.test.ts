import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Store } from "../src/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { buildServer } from "../src/caldav/server.js";
import { reconcile } from "../src/sync/reconciler.js";
import { scanVault } from "../src/vault/scanner.js";
import { silentLogger as logger } from "./helpers.js";

const USER = "test";
const PASS = "pw";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

interface Harness {
  app: FastifyInstance;
  store: Store;
  vault: string;
}

async function setup(): Promise<Harness> {
  const vault = mkdtempSync(join(tmpdir(), "ical-e2e-vault-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ical-e2e-state-"));
  writeFileSync(join(vault, "ship.md"), `---\ndue: 2026-05-15\n---\n# Ship\n`);
  writeFileSync(join(vault, "meet.md"), `---\ndue: 2026-05-16T14:00:00\n---\n`);

  const store = new Store(stateDir);
  const writer = new VaultWriter({ vaultRoot: vault, property: "due", store, logger });
  const scanned = await scanVault({
    vaultRoot: vault,
    scanRoot: vault,
    property: "due",
    logger,
  });
  reconcile(store, scanned, { vaultName: "TestVault" }, logger);

  const app = await buildServer({
    host: "127.0.0.1",
    port: 0,
    username: USER,
    password: PASS,
    store,
    vaultName: "TestVault",
    writer,
    logger,
  });
  return { app, store, vault };
}

describe("CalDAV server", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
    h.store.db.close();
  });

  it("OPTIONS advertises CalDAV", async () => {
    const res = await h.app.inject({ method: "OPTIONS", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["dav"]).toMatch(/calendar-access/);
  });

  it("requires auth on PROPFIND", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: "/",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/Basic/);
  });

  it("PROPFIND on / returns current-user-principal", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: "/",
      headers: { authorization: AUTH, depth: "0", "content-type": "application/xml" },
      payload: `<?xml version="1.0"?>
        <d:propfind xmlns:d="DAV:">
          <d:prop><d:current-user-principal/></d:prop>
        </d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain(`/principals/${USER}/`);
  });

  it("PROPFIND on the calendar lists events at depth 1", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/calendars/${USER}/tasks/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<?xml version="1.0"?>
        <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:prop><d:getetag/><cs:getctag/></d:prop>
        </d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain(`<cs:getctag>`);
    // Two events
    const responses = res.body.match(/<d:response>/g) ?? [];
    expect(responses.length).toBe(3); // collection + 2 events
  });

  it("REPORT calendar-multiget returns calendar-data", async () => {
    const events = h.store.getAllLiveEvents();
    const href = `/calendars/${USER}/tasks/${encodeURIComponent(events[0]!.uid)}.ics`;
    const res = await h.app.inject({
      method: "REPORT" as never,
      url: `/calendars/${USER}/tasks/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<?xml version="1.0"?>
        <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop><d:getetag/><c:calendar-data/></d:prop>
          <d:href>${href}</d:href>
        </c:calendar-multiget>`,
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain("BEGIN:VEVENT");
    expect(res.body).toContain(events[0]!.uid);
  });

  it("GET an event returns its ICS body", async () => {
    const events = h.store.getAllLiveEvents();
    const res = await h.app.inject({
      method: "GET",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(events[0]!.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN:VEVENT");
    expect(res.headers["etag"]).toBeDefined();
  });

  it("PUT a new date writes back to the file", async () => {
    const ev = h.store.getAllLiveEvents().find((e) => e.vault_path === "ship.md")!;
    const newBody = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-ical`,
      "SUMMARY:ship",
      "DTSTART;VALUE=DATE:20260601",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = await h.app.inject({
      method: "PUT",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH, "content-type": "text/calendar" },
      payload: newBody,
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["etag"]).toBeDefined();

    const after = readFileSync(join(h.vault, "ship.md"), "utf8");
    expect(after).toMatch(/due:\s*'?2026-06-01'?/);
    expect(h.store.getEventByUid(ev.uid)?.date_value).toBe("2026-06-01");
  });

  it("PUT with new SUMMARY renames the file", async () => {
    const ev = h.store.getAllLiveEvents().find((e) => e.vault_path === "ship.md")!;
    const newBody = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-ical`,
      "SUMMARY:ship it now",
      "DTSTART;VALUE=DATE:20260515",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = await h.app.inject({
      method: "PUT",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH, "content-type": "text/calendar" },
      payload: newBody,
    });
    expect(res.statusCode).toBe(204);
    expect(h.store.getEventByUid(ev.uid)?.vault_path).toBe("ship it now.md");
  });

  it("DELETE clears the date property and tombstones the event", async () => {
    const ev = h.store.getAllLiveEvents().find((e) => e.vault_path === "ship.md")!;
    const res = await h.app.inject({
      method: "DELETE",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(204);

    const after = readFileSync(join(h.vault, "ship.md"), "utf8");
    expect(after).not.toMatch(/due:/);
    expect(h.store.getEventByUid(ev.uid)?.tombstoned).toBe(1);
  });

  it("ctag bumps after a write", async () => {
    const before = h.store.getCtag();
    const ev = h.store.getAllLiveEvents()[0]!;
    await h.app.inject({
      method: "DELETE",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    const after = h.store.getCtag();
    expect(after).not.toBe(before);
  });
});
