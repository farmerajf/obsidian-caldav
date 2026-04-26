import { describe, expect, it } from "vitest";
import { parseEvent, renderEvent, obsidianUrl } from "../src/caldav/ics.js";
import type { EventRow } from "../src/db.js";

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    uid: "01900000-0000-7000-8000-000000000001",
    vault_path: "Tasks/Ship feature.md",
    date_value: "2026-05-15",
    etag: '"abc"',
    tombstoned: 0,
    updated_at: 0,
    ...over,
  };
}

describe("renderEvent", () => {
  it("renders an all-day VEVENT with DTEND = next day", () => {
    const ics = renderEvent(row(), "Personal");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:01900000-0000-7000-8000-000000000001@obsidian-ical");
    expect(ics).toContain("SUMMARY:Ship feature");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260515");
    expect(ics).toContain("DTEND;VALUE=DATE:20260516");
    expect(ics).toContain(`URL:${obsidianUrl("Personal", "Tasks/Ship feature.md")}`);
  });

  it("renders a timed VEVENT with DTEND = +1 hour", () => {
    const ics = renderEvent(
      row({ date_value: "2026-05-16T14:30:00" }),
      "Personal",
    );
    expect(ics).toContain("DTSTART:20260516T143000");
    expect(ics).toContain("DTEND:20260516T153000");
  });

  it("is deterministic so ETag is stable", () => {
    const a = renderEvent(row(), "Personal");
    const b = renderEvent(row(), "Personal");
    expect(a).toEqual(b);
  });
});

describe("parseEvent", () => {
  it("round-trips render → parse", () => {
    const r = row();
    const ics = renderEvent(r, "Personal");
    const parsed = parseEvent(ics);
    expect(parsed.uid).toBe(r.uid);
    expect(parsed.summary).toBe("Ship feature");
    expect(parsed.dateValue).toBe("2026-05-15");
  });

  it("round-trips timed events", () => {
    const r = row({ date_value: "2026-05-16T14:30:00" });
    const parsed = parseEvent(renderEvent(r, "Personal"));
    expect(parsed.dateValue).toBe("2026-05-16T14:30:00");
  });

  it("handles line folding (RFC 5545 §3.1)", () => {
    const folded = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc",
      "SUMMARY:This is a really long summary that has been folded acro",
      " ss two lines for fun",
      "DTSTART;VALUE=DATE:20260601",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseEvent(folded);
    expect(parsed.summary).toBe(
      "This is a really long summary that has been folded across two lines for fun",
    );
    expect(parsed.dateValue).toBe("2026-06-01");
  });

  it("escapes commas, semicolons, and newlines in SUMMARY", () => {
    const r = row({ vault_path: "Tasks/foo, bar; baz.md" });
    const ics = renderEvent(r, "Personal");
    expect(ics).toMatch(/SUMMARY:foo\\, bar\\; baz/);
    const parsed = parseEvent(ics);
    expect(parsed.summary).toBe("foo, bar; baz");
  });
});
