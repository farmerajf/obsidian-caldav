# obsidian-ical

A small CalDAV server that exposes Obsidian markdown files as calendar events,
with two-way sync. Each file's date lives in a frontmatter property; editing
the event in Apple Calendar (date or title) writes back to the file. No extra
frontmatter is added — the event ↔ file mapping is kept in a sidecar SQLite DB
outside the vault.

## What it does

- Watches a folder in your vault for `.md` files with a configurable date
  property (`due:`, `scheduled:`, etc.).
- Serves them as a CalDAV collection that Apple Calendar can subscribe to.
- When you drag an event in the calendar → updates the date property in the
  file's frontmatter.
- When you rename an event title in the calendar → renames the `.md` file.
- When you delete an event in the calendar → clears the date property (the
  file itself is kept).
- Each event includes an `obsidian://` deep link so clicking opens the source
  note in Obsidian.

## Install

```bash
git clone <repo> obsidian-ical
cd obsidian-ical
npm install
npm run build
```

## Configure

```bash
mkdir -p ~/.config/obsidian-ical
cp config.example.json ~/.config/obsidian-ical/config.json
$EDITOR ~/.config/obsidian-ical/config.json   # set vault path & a password
chmod 600 ~/.config/obsidian-ical/config.json
```

The password lives inline in `server.password`. If you'd rather not commit it
to the same file, you can instead set `server.password_file` (a path to a file
containing the password) or the `OBSIDIAN_ICAL_PASSWORD` env var, which take
precedence over each other in this order: env > inline > file.

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

A calendar called *Obsidian Tasks* will appear with one event per file.

**On iOS over Tailscale:** *Settings → Calendar → Accounts → Add Account →
Other → Add CalDAV Account*. Use the Tailscale hostname for the server.

If the calendar doesn't appear, watch the server logs (`LOG_LEVEL=debug npm
start`) — Apple Calendar's discovery is finicky and the response payload may
need tweaks for your client version.

## Run as a launchd service (macOS)

```bash
# Edit paths in scripts/com.adam.obsidian-ical.plist (node binary, repo path)
cp scripts/com.adam.obsidian-ical.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.adam.obsidian-ical.plist
# Logs: ~/Library/Logs/obsidian-ical.log
```

## How it stays in sync

| Trigger | What happens |
|---|---|
| New file appears with date property | Event inserted, new UID generated, calendar refreshes |
| Date property edited in Obsidian | Existing event updated, same UID |
| File renamed in Obsidian (date unchanged) | Path updated in DB, UID kept — calendar sees no change |
| File deleted in Obsidian | Event tombstoned, calendar issues DELETE on next poll |
| Event dragged in calendar | `due:` value rewritten via `gray-matter` (preserves rest of frontmatter) |
| Event title edited in calendar | `.md` file renamed (sanitized for filesystem) |
| Event deleted in calendar | `due:` property removed; file itself kept |

A pending-write table in SQLite suppresses the watcher's echo when the server
writes to the vault — so calendar edits don't cause a redundant rescan.

The DB lives at `<state_dir>/state.db`. By default that's `./state/state.db`,
resolved relative to the working directory the server is launched from. The
launchd plist sets `WorkingDirectory` to the repo, so the DB ends up in
`obsidian-ical/state/` next to the source. Override with `state_dir` in your
config if you want it elsewhere.

## Limitations

- **No wiki-link rewriting on rename.** If you rename an event title, the
  `.md` file is renamed but `[[other-note → renamed-note]]` links elsewhere
  in your vault are not updated. Use Obsidian's built-in rename inside Obsidian
  if link maintenance matters for that file.
- **No recurring events** — one frontmatter date per file.
- **No VTODO** — events only.
- **Single user / single calendar** — no multi-tenant support.
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
scripts/
  com.adam.obsidian-ical.plist
```

## Tests

```bash
npm test
```
