/**
 * Date helpers that work in the user's local calendar.
 *
 * `toISOString()` is UTC, so in India (UTC+5:30) it reports yesterday's date
 * between 00:00 and 05:29. Event dates are plain local calendar dates, so
 * compare them against a key built from the local year/month/day instead.
 */

/** "YYYY-MM-DD" for the given date in local time (defaults to now). */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local "YYYY-MM-DD" for `days` days from today (negative for the past). */
export function localDateKeyOffset(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

/** Local "HH:MM" (24h, zero-padded) for the given time, defaults to now. */
export function nowHHmm(date = new Date()) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * True when "YYYY-MM-DD" falls before today in the user's local calendar.
 *
 * Both sides are zero-padded local date keys, so a plain string compare is
 * correct and avoids re-introducing the UTC drift described at the top.
 */
export function isPastDate(iso, today = localDateKey()) {
  if (!iso) return false;
  return iso < today;
}

/**
 * Compare two "HH:MM" strings. Negative when a is earlier, 0 when equal,
 * positive when a is later. Zero-padded 24h values sort lexicographically,
 * so no Date object is involved.
 */
export function compareHHmm(a, b) {
  if (!a || !b) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * "14:00" -> "2:00 PM". The stored value stays canonical 24h "HH:MM"; this is
 * display only, so a teacher whose browser renders the native time input in
 * 24h still sees which half of the day the event falls in.
 */
export function formatTime12h(hhmm) {
  if (!hhmm) return "";
  const [rawH, rawM] = String(hhmm).split(":");
  const h = Number(rawH);
  const m = Number(rawM);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "2026-10-15" -> "15 Oct 2026" in the local calendar. */
export function formatEventDay(iso) {
  if (!iso) return "";
  // Parsed as local midnight, not UTC, so the day never shifts backwards.
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * One day as "15 Oct 2026", several as "15 – 17 Oct 2026".
 *
 * The month and year are printed once when both ends share them, which is the
 * common case for a two- or three-day event. `end` may be null or equal to
 * `start`, both of which mean a single-day event.
 */
export function formatDateRange(start, end) {
  const first = formatEventDay(start);
  if (!end || end === start) return first;

  const last = formatEventDay(end);
  if (!first) return last;
  if (!last) return first;

  const [firstDay, ...firstRest] = first.split(" ");
  const [lastDay, ...lastRest] = last.split(" ");
  if (firstRest.length && firstRest.join(" ") === lastRest.join(" ")) {
    return `${firstDay} – ${lastDay} ${lastRest.join(" ")}`;
  }

  return `${first} – ${last}`;
}

// ---------------------------------------------------------------------------
// dd/mm/yyyy -- how dates are typed and shown on the event form. The value the
// app stores and compares stays "YYYY-MM-DD"; these only convert at the edge.
// Plain arithmetic, no Date objects, so no timezone can move the day.
// ---------------------------------------------------------------------------

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** "2026-09-05" -> "05/09/2026"; anything else -> "". */
export function isoToDmy(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

/**
 * "05/09/2026" -> "2026-09-05", or "" unless it is a complete, real calendar
 * date (31/02/2026 and 29/02/2027 are refused). Dots and dashes work as
 * separators too.
 */
export function dmyToIso(text) {
  const match = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec((text || "").trim());
  if (!match) return "";
  const [, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return "";
  return `${yyyy}-${mm}-${dd}`;
}

/** Digits typed so far, shaped as "dd/mm/yyyy" with the slashes filled in. */
export function maskDmy(raw) {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
