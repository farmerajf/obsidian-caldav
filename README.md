# obsidian-caldav

A small CalDAV server that exposes Obsidian markdown files as calendar events,
with two-way sync. Each file's date lives in a frontmatter property; editing
the event in Apple Calendar (date or title) writes back to the file. No extra
frontmatter is added — the event ↔ file mapping is kept in a sidecar SQLite DB
outside the vault.

You can serve multiple calendars from one server. Each calendar is fully
self-describing — it points at its own vault, folder, and frontmatter
property, so you can mix calendars from different Obsidian vaults under one
CalDAV account (e.g. a `Personal` vault `Tasks` calendar and a `Work` vault
`Events` calendar).

## What it does

- Watches one or more folders in your vault for `.md` files with a configurable
  date property (`due:`, `scheduled:`, etc.).
- Serves them as CalDAV collections — one per configured calendar — that Apple
  Calendar can subscribe to.
- When you drag an event in the calendar → updates the date property in the
  file's frontmatter.
- When you rename an event title in the calendar → renames the `.md` file.
- When you delete an event in the calendar → clears the date property (the
  file itself is kept).
- Each event includes an `obsidian://` deep link so clicking opens the source
  note in Obsidian.

## Install

```bash
git clone <repo> obsidian-caldav
cd obsidian-caldav
npm install
npm run build
```

## Configure

```bash
mkdir -p ~/.config/obsidian-caldav
cp config.example.json ~/.config/obsidian-caldav/config.json
$EDITOR ~/.config/obsidian-caldav/config.json   # set vault path & a password
chmod 600 ~/.config/obsidian-caldav/config.json
```

The password lives inline in `server.password`. If you'd rather not commit it
to the same file, you can instead set `server.password_file` (a path to a file
containing the password) or the `OBSIDIAN_CALDAV_PASSWORD` env var, which take
precedence over each other in this order: env > inline > file.

### Defining calendars

`calendars` is an array — one entry per calendar you want to expose. Each:

| Field | Required | What it is |
|---|---|---|
| `id` | yes | URL-safe slug (`[a-z0-9][a-z0-9-]{0,63}`); used in the CalDAV URL `/calendars/<user>/<id>/` |
| `name` | yes | Display name shown in the calendar client |
| `vault_path` | yes | Absolute path to the Obsidian vault on disk |
| `vault_name` | yes | Vault name used in `obsidian://open?vault=...` deep links |
| `folder` | yes | Vault-relative folder to watch (relative to `vault_path`) |
| `property` | yes | Frontmatter key whose value is the event date |
| `color` | no | `#RRGGBB` calendar color shown in Apple Calendar |
| `description` | no | Per-calendar description shown by some clients |

Calendar `id`s must be unique across the whole config. Within a single vault,
calendar folders must be disjoint (no duplicates, no prefix overlap). Two
calendars in *different* vaults can have the same `folder` string — they
point at different files.

### Serving behind a reverse proxy at a path prefix

Set `server.base_path` if you're putting the server behind a reverse proxy
that mounts the app at a path prefix. The server emits all hrefs in
PROPFIND/REPORT responses with the prefix included so calendar clients walk
back through the proxy correctly.

```json
"server": {
  "base_path": "/obsidian-caldav",
  ...
}
```

Then in Apple Calendar, Server Path = `/obsidian-caldav/`. Leave `base_path`
unset (or `""`) when serving at the root.

Incoming requests are matched leniently — both `/<base_path>/principals/...`
and `/principals/...` route the same way. This means the server works with
proxies that preserve the prefix *and* with proxies that strip it before
forwarding (e.g. Tailscale Serve's default behavior).

Then run it:

```bash
npm start
# or for development with auto-restart
npm run dev
```

## Add the calendar in Apple Calendar

**On macOS:** *Calendar → Settings → Accounts → +* → Add CalDAV Account →
Account Type: Manual.

- Server Address: `localhost` (or your Tailscale machine name, e.g.
  `mac.tailnet.ts.net`)
- Server Path: `/`
- Port: `5232`
- Username/Password: as configured

One calendar appears for each entry in your `calendars` config (named via the
`name` field).

**On iOS over Tailscale:** *Settings → Calendar → Accounts → Add Account →
Other → Add CalDAV Account*. Use the Tailscale hostname for the server.

If the calendar doesn't appear, watch the server logs (`LOG_LEVEL=debug npm
start`) — Apple Calendar's discovery is finicky and the response payload may
need tweaks for your client version.

## How it stays in sync

| Trigger | What happens |
|---|---|
| New file appears with date property | Event inserted, new UID generated, calendar refreshes |
| Date property edited in Obsidian | Existing event updated, same UID |
| File renamed in Obsidian (date unchanged) | Path updated in DB, UID kept — calendar sees no change |
| File deleted in Obsidian | Event tombstoned, calendar issues DELETE on next poll |
| Event dragged in calendar | The calendar's configured property is rewritten via `gray-matter` (preserves rest of frontmatter) |
| Event title edited in calendar | `.md` file renamed (sanitized for filesystem) |
| Event deleted in calendar | The calendar's configured property is removed; file itself kept |

A pending-write table in SQLite suppresses the watcher's echo when the server
writes to the vault — so calendar edits don't cause a redundant rescan.

The DB lives at `<state_dir>/state.db`. By default that's `./state/state.db`,
resolved relative to the working directory the server is launched from.
Override with `state_dir` in your config if you want it elsewhere.

## Limitations

- **No wiki-link rewriting on rename.** If you rename an event title, the
  `.md` file is renamed but `[[other-note → renamed-note]]` links elsewhere
  in your vault are not updated. Use Obsidian's built-in rename inside Obsidian
  if link maintenance matters for that file.
- **No recurring events** — one frontmatter date per file.
- **No VTODO** — events only.
- **Single user** — no multi-tenant support (one user can have any number of calendars).
- **Disjoint folders within a vault** — within one vault, calendars must watch non-overlapping subtrees. Across vaults, anything goes.
- **Floating local time** — timed events are stored as wall-clock local time
  with no timezone. Fine if you don't travel between zones; lossy if you do.
- **Apple Calendar / Fantastical / Thunderbird tested.** Google Calendar
  cannot subscribe to CalDAV — it would need a separate ICS-only path.

## Project layout

```
src/
  index.ts          # CLI entry; wires watcher + writer + server
  config.ts         # JSON config loader (zod)
  db.ts             # better-sqlite3 store
  logger.ts         # pino setup
  vault/
    scanner.ts      # walk folder + parse frontmatter
    watcher.ts      # chokidar with loop suppression
    writer.ts       # gray-matter round-trip + atomic rename
  caldav/
    server.ts       # fastify with PROPFIND/REPORT support
    handlers.ts     # OPTIONS / PROPFIND / REPORT / GET
    put.ts          # date / title write-back
    delete.ts       # clear date property
    ics.ts          # render & parse VEVENT
    xml.ts          # tiny DAV XML helpers
  sync/
    reconciler.ts   # diff scan vs DB, emit & apply actions
test/               # vitest suites
```

## Tests

```bash
npm test
```
