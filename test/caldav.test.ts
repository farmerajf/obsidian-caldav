import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Store } from "../src/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { buildServer } from "../src/caldav/server.js";
import { reconcile } from "../src/sync/reconciler.js";
import { scanVault } from "../src/vault/scanner.js";
import type { ResolvedCalendar } from "../src/config.js";
import { silentLogger as logger } from "./helpers.js";

const USER = "test";
const PASS = "pw";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

interface Harness {
  app: FastifyInstance;
  store: Store;
  vaults: string[];
  calendars: ResolvedCalendar[];
}

async function setupSingleCalendarWithBasePath(basePath: string): Promise<Harness> {
  const vault = mkdtempSync(join(tmpdir(), "caldav-e2e-base-"));
  const stateDir = mkdtempSync(join(tmpdir(), "caldav-e2e-base-state-"));
  writeFileSync(join(vault, "ship.md"), `---\ndue: 2026-05-15\n---\n`);

  const calendars: ResolvedCalendar[] = [
    {
      id: "tasks",
      name: "Tasks",
      vault_path: vault,
      vault_name: "Base",
      folder: "",
      property: "due",
      resolvedVaultPath: vault,
      resolvedFolderAbs: vault,
    },
  ];

  const store = new Store(stateDir);
  store.ensureCalendars(calendars.map((c) => c.id));
  const writer = new VaultWriter({ store, logger });
  const scanned = await scanVault({ vaultRoot: vault, scanRoot: vault, property: "due", logger });
  reconcile(store, scanned, { vaultName: "Base", calendarId: "tasks" }, logger);

  const app = await buildServer({
    host: "127.0.0.1",
    port: 0,
    username: USER,
    password: PASS,
    store,
    calendars,
    writer,
    logger,
    basePath,
  });
  return { app, store, vaults: [vault], calendars };
}

async function setupSingleCalendar(): Promise<Harness> {
  const vault = mkdtempSync(join(tmpdir(), "caldav-e2e-vault-"));
  const stateDir = mkdtempSync(join(tmpdir(), "caldav-e2e-state-"));
  writeFileSync(join(vault, "ship.md"), `---\ndue: 2026-05-15\n---\n# Ship\n`);
  writeFileSync(join(vault, "meet.md"), `---\ndue: 2026-05-16T14:00:00\n---\n`);

  const calendars: ResolvedCalendar[] = [
    {
      id: "tasks",
      name: "Tasks",
      vault_path: vault,
      vault_name: "TestVault",
      folder: "",
      property: "due",
      resolvedVaultPath: vault,
      resolvedFolderAbs: vault,
    },
  ];

  const store = new Store(stateDir);
  store.ensureCalendars(calendars.map((c) => c.id));
  const writer = new VaultWriter({ store, logger });
  const scanned = await scanVault({
    vaultRoot: vault,
    scanRoot: vault,
    property: "due",
    logger,
  });
  reconcile(store, scanned, { vaultName: "TestVault", calendarId: "tasks" }, logger);

  const app = await buildServer({
    host: "127.0.0.1",
    port: 0,
    username: USER,
    password: PASS,
    store,
    calendars,
    writer,
    logger,
    basePath: "",
  });
  return { app, store, vaults: [vault], calendars };
}

async function setupTwoCalendars(): Promise<Harness> {
  const vault = mkdtempSync(join(tmpdir(), "caldav-e2e-multi-"));
  const stateDir = mkdtempSync(join(tmpdir(), "caldav-e2e-multi-state-"));
  mkdirSync(join(vault, "Tasks"));
  mkdirSync(join(vault, "Events"));
  writeFileSync(join(vault, "Tasks", "ship.md"), `---\ndue: 2026-05-15\n---\n`);
  writeFileSync(join(vault, "Tasks", "meet.md"), `---\ndue: 2026-05-16\n---\n`);
  writeFileSync(join(vault, "Events", "launch.md"), `---\nscheduled: 2026-06-01\n---\n`);

  const calendars: ResolvedCalendar[] = [
    {
      id: "tasks",
      name: "Tasks",
      vault_path: vault,
      vault_name: "Multi",
      folder: "Tasks",
      property: "due",
      color: "#FF0000",
      resolvedVaultPath: vault,
      resolvedFolderAbs: join(vault, "Tasks"),
    },
    {
      id: "events",
      name: "Events",
      vault_path: vault,
      vault_name: "Multi",
      folder: "Events",
      property: "scheduled",
      color: "#00FF00",
      resolvedVaultPath: vault,
      resolvedFolderAbs: join(vault, "Events"),
    },
  ];

  const store = new Store(stateDir);
  store.ensureCalendars(calendars.map((c) => c.id));
  const writer = new VaultWriter({ store, logger });
  for (const cal of calendars) {
    const scanned = await scanVault({
      vaultRoot: cal.resolvedVaultPath,
      scanRoot: cal.resolvedFolderAbs,
      property: cal.property,
      logger,
    });
    reconcile(store, scanned, { vaultName: cal.vault_name, calendarId: cal.id }, logger);
  }

  const app = await buildServer({
    host: "127.0.0.1",
    port: 0,
    username: USER,
    password: PASS,
    store,
    calendars,
    writer,
    logger,
    basePath: "",
  });
  return { app, store, vaults: [vault], calendars };
}

async function setupTwoVaults(): Promise<Harness> {
  const vaultA = mkdtempSync(join(tmpdir(), "caldav-e2e-vaultA-"));
  const vaultB = mkdtempSync(join(tmpdir(), "caldav-e2e-vaultB-"));
  const stateDir = mkdtempSync(join(tmpdir(), "caldav-e2e-2vault-state-"));
  // Same relative path "Tasks/foo.md" lives in both vaults — this is the
  // collision case the per-calendar UNIQUE constraint exists to allow.
  mkdirSync(join(vaultA, "Tasks"));
  mkdirSync(join(vaultB, "Tasks"));
  writeFileSync(join(vaultA, "Tasks", "foo.md"), `---\ndue: 2026-05-01\n---\n`);
  writeFileSync(join(vaultB, "Tasks", "foo.md"), `---\ndue: 2026-06-01\n---\n`);

  const calendars: ResolvedCalendar[] = [
    {
      id: "personal",
      name: "Personal",
      vault_path: vaultA,
      vault_name: "Personal",
      folder: "Tasks",
      property: "due",
      resolvedVaultPath: vaultA,
      resolvedFolderAbs: join(vaultA, "Tasks"),
    },
    {
      id: "work",
      name: "Work",
      vault_path: vaultB,
      vault_name: "Work",
      folder: "Tasks",
      property: "due",
      resolvedVaultPath: vaultB,
      resolvedFolderAbs: join(vaultB, "Tasks"),
    },
  ];

  const store = new Store(stateDir);
  store.ensureCalendars(calendars.map((c) => c.id));
  const writer = new VaultWriter({ store, logger });
  for (const cal of calendars) {
    const scanned = await scanVault({
      vaultRoot: cal.resolvedVaultPath,
      scanRoot: cal.resolvedFolderAbs,
      property: cal.property,
      logger,
    });
    reconcile(store, scanned, { vaultName: cal.vault_name, calendarId: cal.id }, logger);
  }

  const app = await buildServer({
    host: "127.0.0.1",
    port: 0,
    username: USER,
    password: PASS,
    store,
    calendars,
    writer,
    logger,
    basePath: "",
  });
  return { app, store, vaults: [vaultA, vaultB], calendars };
}

describe("CalDAV server (single calendar)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupSingleCalendar();
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
    const responses = res.body.match(/<d:response>/g) ?? [];
    expect(responses.length).toBe(3); // collection + 2 events
  });

  it("REPORT calendar-multiget returns calendar-data", async () => {
    const events = h.store.getAllLiveEvents("tasks");
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
    const events = h.store.getAllLiveEvents("tasks");
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
    const ev = h.store.getAllLiveEvents("tasks").find((e) => e.vault_path === "ship.md")!;
    const newBody = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-caldav`,
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

    const after = readFileSync(join(h.vaults[0]!, "ship.md"), "utf8");
    expect(after).toMatch(/due:\s*'?2026-06-01'?/);
    expect(h.store.getEventByUid(ev.uid)?.date_value).toBe("2026-06-01");
  });

  it("PUT with new SUMMARY renames the file", async () => {
    const ev = h.store.getAllLiveEvents("tasks").find((e) => e.vault_path === "ship.md")!;
    const newBody = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-caldav`,
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
    const ev = h.store.getAllLiveEvents("tasks").find((e) => e.vault_path === "ship.md")!;
    const res = await h.app.inject({
      method: "DELETE",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(204);

    const after = readFileSync(join(h.vaults[0]!, "ship.md"), "utf8");
    expect(after).not.toMatch(/due:/);
    expect(h.store.getEventByUid(ev.uid)?.tombstoned).toBe(1);
  });

  it("ctag bumps after a write", async () => {
    const before = h.store.getCtag("tasks");
    const ev = h.store.getAllLiveEvents("tasks")[0]!;
    await h.app.inject({
      method: "DELETE",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    const after = h.store.getCtag("tasks");
    expect(after).not.toBe(before);
  });
});

describe("CalDAV server (multiple calendars, one vault)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupTwoCalendars();
  });
  afterEach(async () => {
    await h.app.close();
    h.store.db.close();
  });

  it("PROPFIND on calendar-home at depth 1 lists every calendar", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/calendars/${USER}/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<?xml version="1.0"?>
        <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:prop><d:displayname/><cs:getctag/><d:resourcetype/></d:prop>
        </d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain(`/calendars/${USER}/tasks/`);
    expect(res.body).toContain(`/calendars/${USER}/events/`);
    expect(res.body).toContain(">Tasks<");
    expect(res.body).toContain(">Events<");
  });

  it("each calendar serves only its own events", async () => {
    const tasks = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/calendars/${USER}/tasks/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
    });
    expect((tasks.body.match(/<d:response>/g) ?? []).length).toBe(3);

    const events = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/calendars/${USER}/events/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
    });
    expect((events.body.match(/<d:response>/g) ?? []).length).toBe(2);
  });

  it("rejects an event GET against the wrong calendar", async () => {
    const ev = h.store.getAllLiveEvents("tasks")[0]!;
    const res = await h.app.inject({
      method: "GET",
      url: `/calendars/${USER}/events/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT to a calendar uses that calendar's property when writing back", async () => {
    const ev = h.store.getAllLiveEvents("events").find((e) => e.vault_path === "Events/launch.md")!;
    const newBody = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-caldav`,
      "SUMMARY:launch",
      "DTSTART;VALUE=DATE:20260615",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const res = await h.app.inject({
      method: "PUT",
      url: `/calendars/${USER}/events/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH, "content-type": "text/calendar" },
      payload: newBody,
    });
    expect(res.statusCode).toBe(204);
    const after = readFileSync(join(h.vaults[0]!, "Events", "launch.md"), "utf8");
    expect(after).toMatch(/scheduled:\s*'?2026-06-15'?/);
    expect(after).not.toMatch(/^due:/m);
  });

  it("each calendar has an independent ctag", async () => {
    const tasksBefore = h.store.getCtag("tasks");
    const eventsBefore = h.store.getCtag("events");
    const ev = h.store.getAllLiveEvents("tasks")[0]!;
    await h.app.inject({
      method: "DELETE",
      url: `/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(h.store.getCtag("tasks")).not.toBe(tasksBefore);
    expect(h.store.getCtag("events")).toBe(eventsBefore);
  });

  it("calendar-color is per-calendar", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/calendars/${USER}/tasks/`,
      headers: { authorization: AUTH, depth: "0", "content-type": "application/xml" },
      payload: `<?xml version="1.0"?>
        <d:propfind xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/">
          <d:prop><ical:calendar-color/></d:prop>
        </d:propfind>`,
    });
    expect(res.body).toContain("#FF0000");
    expect(res.body).not.toContain("#00FF00");
  });
});

describe("CalDAV server (calendars in different vaults)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupTwoVaults();
  });
  afterEach(async () => {
    await h.app.close();
    h.store.db.close();
  });

  it("stores both events even though their vault_paths collide", () => {
    const personal = h.store.getAllLiveEvents("personal");
    const work = h.store.getAllLiveEvents("work");
    expect(personal).toHaveLength(1);
    expect(work).toHaveLength(1);
    expect(personal[0]!.vault_path).toBe("Tasks/foo.md");
    expect(work[0]!.vault_path).toBe("Tasks/foo.md");
    expect(personal[0]!.uid).not.toBe(work[0]!.uid);
  });

  it("PUT to the personal calendar writes to vault A only", async () => {
    const ev = h.store.getAllLiveEvents("personal")[0]!;
    const body = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${ev.uid}@obsidian-caldav`,
      "SUMMARY:foo",
      "DTSTART;VALUE=DATE:20260520",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const res = await h.app.inject({
      method: "PUT",
      url: `/calendars/${USER}/personal/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH, "content-type": "text/calendar" },
      payload: body,
    });
    expect(res.statusCode).toBe(204);

    const a = readFileSync(join(h.vaults[0]!, "Tasks", "foo.md"), "utf8");
    const b = readFileSync(join(h.vaults[1]!, "Tasks", "foo.md"), "utf8");
    expect(a).toMatch(/due:\s*'?2026-05-20'?/);
    expect(b).toMatch(/due:\s*'?2026-06-01'?/); // vault B untouched
  });

  it("rejects an event GET against the wrong-vault calendar", async () => {
    const ev = h.store.getAllLiveEvents("personal")[0]!;
    const res = await h.app.inject({
      method: "GET",
      url: `/calendars/${USER}/work/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("CalDAV server (with base_path)", () => {
  let h: Harness;
  const BASE = "/obsidian-caldav";
  beforeEach(async () => {
    h = await setupSingleCalendarWithBasePath(BASE);
  });
  afterEach(async () => {
    await h.app.close();
    h.store.db.close();
  });

  it("PROPFIND on the bare base_path returns the root", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `${BASE}/`,
      headers: { authorization: AUTH, depth: "0", "content-type": "application/xml" },
      payload: `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    // Emitted href must include the base_path so clients follow it back through the proxy.
    expect(res.body).toContain(`${BASE}/principals/${USER}/`);
  });

  it("also accepts requests at the root path (proxy that strips the prefix)", async () => {
    // Tailscale Serve and other reverse proxies sometimes strip the mount
    // prefix before forwarding. The server treats prefixed and unprefixed
    // requests the same way.
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `/principals/${USER}/`,
      headers: { authorization: AUTH, depth: "0", "content-type": "application/xml" },
      payload: `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    // Emitted hrefs still include the prefix so clients walk back through the proxy.
    expect(res.body).toContain(`${BASE}/principals/${USER}/`);
  });

  it("calendar-home PROPFIND lists calendars under the base_path", async () => {
    const res = await h.app.inject({
      method: "PROPFIND" as never,
      url: `${BASE}/calendars/${USER}/`,
      headers: { authorization: AUTH, depth: "1", "content-type": "application/xml" },
      payload: `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain(`${BASE}/calendars/${USER}/tasks/`);
    expect(res.body).not.toContain(`>/calendars/${USER}/tasks/<`);
  });

  it("event GET works through the base_path", async () => {
    const ev = h.store.getAllLiveEvents("tasks")[0]!;
    const res = await h.app.inject({
      method: "GET",
      url: `${BASE}/calendars/${USER}/tasks/${encodeURIComponent(ev.uid)}.ics`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN:VEVENT");
  });
});
