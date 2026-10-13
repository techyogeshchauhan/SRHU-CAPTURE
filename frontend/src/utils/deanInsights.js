/**
 * The figures behind the Dean dashboard's Overview panels, worked out from
 * the event list the dashboard already loads (GET /dean/events returns every
 * non-draft, non-archived event in full, history included).
 *
 * Pure functions, so the panels can be tested without rendering them.
 *
 * `event_date` is a "YYYY-MM-DD" string and is compared as one: building a
 * Date from it is what reintroduces timezone drift. Only the history
 * timestamps -- real instants -- are parsed.
 */

import { getStatusBucket } from "./constants";
import { localDateKey, localDateKeyOffset } from "./dates";

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

/** Days in a month, `month` 1-12. Day 0 of the next month is this one's last. */
const daysInMonth = (year, month) => new Date(year, month, 0).getDate();

const dayKey = (value) => {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
};

/**
 * Events per month around today, split by review outcome.
 *
 * The window runs `before` months back and `after` months ahead of the
 * current one: events are usually approved before they take place, so the
 * months ahead show what is already planned.
 *
 * @returns {Array<{key, label, year, start, end, isCurrent, isFuture,
 *                  approved, pending, rejected, total}>}
 */
export function monthlyActivity(events = [], today = localDateKey(), { before = 8, after = 3 } = {}) {
  const [todayYear, todayMonth] = today.split("-").map(Number);
  const currentKey = `${todayYear}-${pad(todayMonth)}`;

  const buckets = [];
  for (let offset = -before; offset <= after; offset += 1) {
    const index = todayYear * 12 + (todayMonth - 1) + offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const key = `${year}-${pad(month)}`;
    buckets.push({
      key,
      label: MONTH_SHORT[month - 1],
      year,
      start: `${key}-01`,
      end: `${key}-${pad(daysInMonth(year, month))}`,
      isCurrent: key === currentKey,
      isFuture: key > currentKey,
      approved: 0,
      pending: 0,
      rejected: 0,
      total: 0,
    });
  }

  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const event of events) {
    const bucket = byKey.get(dayKey(event?.event_date).slice(0, 7));
    if (!bucket) continue;
    const outcome = getStatusBucket(event.status);
    if (outcome === "other") continue;
    bucket[outcome] += 1;
    bucket.total += 1;
  }

  return buckets;
}

/**
 * Approved events taking place in the next `days` days, soonest first.
 *
 * @returns {{items: Object[], total: number, until: string}}
 */
export function upcomingEvents(events = [], today = localDateKey(), { days = 30, limit = 6 } = {}) {
  const [year, month, day] = today.split("-").map(Number);
  const until = localDateKeyOffset(days, new Date(year, month - 1, day));

  const matches = events
    .filter((event) => {
      if (getStatusBucket(event?.status) !== "approved") return false;
      const date = dayKey(event.event_date);
      return Boolean(date) && date >= today && date <= until;
    })
    .sort(
      (a, b) =>
        dayKey(a.event_date).localeCompare(dayKey(b.event_date)) ||
        // An event without a time sorts after the timed ones on its day.
        String(a.start_time || "99:99").localeCompare(String(b.start_time || "99:99")),
    );

  return { items: matches.slice(0, limit), total: matches.length, until };
}

const SUBMIT_ACTIONS = new Set(["submitted", "resubmitted"]);
const DECISION_ACTIONS = new Set(["approved", "rejected", "changes_requested"]);

const toTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isNaN(time) ? null : time;
};

const byTime = (a, b) => (toTime(a?.created_at) ?? 0) - (toTime(b?.created_at) ?? 0);

/**
 * How quickly submissions get a decision, and how long the open ones have
 * been waiting.
 *
 * A turnaround is the gap from a submission (or resubmission) to the review
 * decision that answered it -- approve, reject or request changes. Revoking
 * is not a review of a submission, and a Dean revising a decision without a
 * new submission starts no new clock, so neither counts. Only decisions in
 * the last `windowDays` days are averaged, so the figure tracks the present.
 *
 * Waiting time is counted for the events `isAwaiting` accepts -- the
 * dashboard passes the Review Queue's own rule, so the two always agree --
 * from their latest submission, falling back to `submitted_at`, then
 * `created_at`, for events whose history does not record it.
 *
 * @returns {{avgDays: number|null, decisions: number,
 *            ageing: {fresh: number, waiting: number, stale: number},
 *            awaiting: number}}
 */
export function reviewTurnaround(
  events = [],
  now = new Date(),
  { windowDays = 90, isAwaiting = (event) => getStatusBucket(event?.status) === "pending" } = {},
) {
  const nowMs = now.getTime();
  const since = nowMs - windowDays * DAY_MS;

  const gaps = [];
  const ageing = { fresh: 0, waiting: 0, stale: 0 };

  for (const event of events) {
    const history = Array.isArray(event?.history) ? [...event.history].sort(byTime) : [];

    let openedAt = null;
    let lastSubmittedAt = null;
    for (const entry of history) {
      const at = toTime(entry?.created_at);
      if (at == null) continue;
      if (SUBMIT_ACTIONS.has(entry.action)) {
        openedAt = at;
        lastSubmittedAt = at;
      } else if (DECISION_ACTIONS.has(entry.action) && openedAt != null) {
        if (at >= since) gaps.push(Math.max(0, at - openedAt));
        openedAt = null;
      }
    }

    if (!isAwaiting(event)) continue;
    const from = lastSubmittedAt ?? toTime(event.submitted_at) ?? toTime(event.created_at);
    if (from == null) continue;
    const waited = Math.floor((nowMs - from) / DAY_MS);
    if (waited <= 2) ageing.fresh += 1;
    else if (waited <= 7) ageing.waiting += 1;
    else ageing.stale += 1;
  }

  const avgDays = gaps.length
    ? Math.round((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length / DAY_MS) * 10) / 10
    : null;

  return {
    avgDays,
    decisions: gaps.length,
    ageing,
    awaiting: ageing.fresh + ageing.waiting + ageing.stale,
  };
}
