import { describe, expect, it } from "vitest";
import {
  monthlyActivity,
  reviewTurnaround,
  upcomingEvents,
} from "../../src/utils/deanInsights";

describe("monthlyActivity", () => {
  it("spans 8 months back to 3 ahead, across a year boundary", () => {
    const months = monthlyActivity([], "2026-02-14");
    expect(months).toHaveLength(12);
    expect(months[0]).toMatchObject({ key: "2025-06", label: "Jun", year: 2025 });
    expect(months[8]).toMatchObject({ key: "2026-02", isCurrent: true, isFuture: false });
    expect(months[11]).toMatchObject({ key: "2026-05", isFuture: true });
  });

  it("gives each month its first and last day", () => {
    const months = monthlyActivity([], "2028-02-10");
    const feb = months.find((m) => m.key === "2028-02");
    expect(feb.start).toBe("2028-02-01");
    expect(feb.end).toBe("2028-02-29"); // leap year
  });

  it("counts events by review outcome and skips anything else", () => {
    const months = monthlyActivity(
      [
        { event_date: "2026-08-21", status: "completed" },
        { event_date: "2026-08-02", status: "recorded" },
        { event_date: "2026-08-30", status: "pending" },
        { event_date: "2026-08-05", status: "revoked" },
        { event_date: "2026-08-06", status: "draft" },
        { event_date: "2020-01-01", status: "approved" }, // outside the window
        { event_date: "", status: "approved" },
      ],
      "2026-10-09",
    );
    const aug = months.find((m) => m.key === "2026-08");
    expect(aug).toMatchObject({ approved: 2, pending: 1, rejected: 1, total: 4 });
    expect(months.reduce((sum, m) => sum + m.total, 0)).toBe(4);
  });
});

describe("upcomingEvents", () => {
  const today = "2026-10-09";

  it("keeps approved events from today to 30 days ahead, inclusive", () => {
    const { items, total, until } = upcomingEvents(
      [
        { id: "today", event_date: "2026-10-09", status: "approved" },
        { id: "edge", event_date: "2026-11-08", status: "completed" },
        { id: "past", event_date: "2026-10-08", status: "approved" },
        { id: "late", event_date: "2026-11-09", status: "approved" },
        { id: "pending", event_date: "2026-10-12", status: "pending" },
      ],
      today,
    );
    expect(until).toBe("2026-11-08");
    expect(items.map((e) => e.id)).toEqual(["today", "edge"]);
    expect(total).toBe(2);
  });

  it("sorts by date, then time, with untimed events last on their day", () => {
    const { items } = upcomingEvents(
      [
        { id: "c", event_date: "2026-10-12", status: "approved" },
        { id: "b", event_date: "2026-10-12", start_time: "14:00", status: "approved" },
        { id: "a", event_date: "2026-10-12", start_time: "09:30", status: "approved" },
        { id: "first", event_date: "2026-10-10", start_time: "18:00", status: "approved" },
      ],
      today,
    );
    expect(items.map((e) => e.id)).toEqual(["first", "a", "b", "c"]);
  });

  it("limits the list but reports the full total", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      event_date: `2026-10-${String(10 + i).padStart(2, "0")}`,
      status: "approved",
    }));
    const { items, total } = upcomingEvents(events, today, { limit: 6 });
    expect(items).toHaveLength(6);
    expect(total).toBe(9);
  });
});

describe("reviewTurnaround", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const at = (iso) => `${iso}T12:00:00Z`;

  it("averages submission-to-decision gaps in days", () => {
    const { avgDays, decisions } = reviewTurnaround(
      [
        {
          status: "approved",
          history: [
            { action: "created", created_at: at("2026-09-01") },
            { action: "submitted", created_at: at("2026-09-01") },
            { action: "approved", created_at: at("2026-09-03") },
          ],
        },
        {
          status: "rejected",
          history: [
            { action: "submitted", created_at: at("2026-09-10") },
            { action: "rejected", created_at: at("2026-09-15") },
          ],
        },
      ],
      now,
    );
    expect(decisions).toBe(2);
    expect(avgDays).toBe(3.5);
  });

  it("restarts the clock on resubmission and ignores revisions without one", () => {
    const { avgDays, decisions } = reviewTurnaround(
      [
        {
          status: "approved",
          history: [
            { action: "submitted", created_at: at("2026-09-01") },
            { action: "changes_requested", created_at: at("2026-09-02") },
            { action: "resubmitted", created_at: at("2026-09-20") },
            { action: "approved", created_at: at("2026-09-21") },
            // A later change of mind, with no new submission to answer
            { action: "rejected", created_at: at("2026-09-25") },
            { action: "approved", created_at: at("2026-09-26") },
          ],
        },
      ],
      now,
    );
    expect(decisions).toBe(2); // 1 day + 1 day
    expect(avgDays).toBe(1);
  });

  it("only averages decisions from the last 90 days", () => {
    const { avgDays, decisions } = reviewTurnaround(
      [
        {
          status: "approved",
          history: [
            { action: "submitted", created_at: at("2026-01-01") },
            { action: "approved", created_at: at("2026-01-11") },
          ],
        },
      ],
      now,
    );
    expect(decisions).toBe(0);
    expect(avgDays).toBeNull();
  });

  it("buckets waiting events by days since their latest submission", () => {
    const { ageing, awaiting } = reviewTurnaround(
      [
        { status: "pending", history: [{ action: "submitted", created_at: at("2026-10-08") }] },
        { status: "pending", history: [{ action: "resubmitted", created_at: at("2026-10-04") }] },
        { status: "pending", submitted_at: at("2026-09-20") }, // no history: submitted_at
        { status: "submitted", created_at: at("2026-10-01") }, // nor that: created_at
        { status: "recorded", created_at: at("2026-01-01") }, // Event Manager: never reviewed
        { status: "approved", created_at: at("2026-01-01") },
      ],
      now,
    );
    expect(ageing).toEqual({ fresh: 1, waiting: 1, stale: 2 });
    expect(awaiting).toBe(4);
  });

  it("uses the caller's rule for what is awaiting review", () => {
    const { awaiting } = reviewTurnaround(
      [{ status: "needs_correction", created_at: at("2026-10-08") }],
      now,
      { isAwaiting: (event) => event.status === "needs_correction" },
    );
    expect(awaiting).toBe(1);
  });
});
