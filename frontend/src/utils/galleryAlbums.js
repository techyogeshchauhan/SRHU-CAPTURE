/**
 * Helpers for the Dean gallery.
 *
 * Dates are "YYYY-MM-DD" strings, built and compared as strings (the domain
 * rule): no Date arithmetic beyond finding today and "n days ago" locally.
 */

import { localDateKey, localDateKeyOffset } from "./dates";

/**
 * The one-click periods above the gallery, in display order. A period is a
 * date range ending today; "All time" is no range at all.
 */
export const GALLERY_PERIODS = [
  { key: "", label: "All time" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "Last 3 months" },
  { key: "year", label: "This year" },
];

/** { startDate, endDate } for a period, or empty strings for "All time". */
export function periodRange(key, today = localDateKey()) {
  if (key === "month") return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
  if (key === "year") return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
  if (key === "quarter") {
    const [y, m, d] = today.split("-").map(Number);
    return { startDate: localDateKeyOffset(-90, new Date(y, m - 1, d)), endDate: today };
  }
  return { startDate: "", endDate: "" };
}

/**
 * Which period a date range is: a period key, "" for no range, or "custom"
 * for any other range (chosen in the date-range dialog).
 */
export function periodOf(startDate, endDate, today = localDateKey()) {
  if (!startDate && !endDate) return "";
  for (const { key } of GALLERY_PERIODS) {
    if (!key) continue;
    const range = periodRange(key, today);
    if (range.startDate === startDate && range.endDate === endDate) return key;
  }
  return "custom";
}

/** Where `id` sits in `ids`, and the ids either side of it (or null). */
export function albumNeighbours(ids = [], id) {
  const index = ids.indexOf(id);
  if (index === -1) return { index: -1, prev: null, next: null };
  return {
    index,
    prev: index > 0 ? ids[index - 1] : null,
    next: index < ids.length - 1 ? ids[index + 1] : null,
  };
}
