/**
 * Display rules for research records, shared by the Event Manager, teacher
 * and Dean screens. The category definitions themselves come from the server
 * (GET /research/categories); nothing here duplicates them.
 */

import { trackOf } from "../components/teacher/status";
import { formatEventDay } from "./dates";

/** Where the record stands with the Dean. */
export const VERIFICATION_META = {
  draft: { label: "Draft", track: trackOf("draft") },
  submitted: { label: "Awaiting verification", short: "Awaiting", track: trackOf("pending") },
  verified: { label: "Verified", track: trackOf("approved") },
  changes_requested: { label: "Changes requested", short: "Changes", track: trackOf("under_review") },
  rejected: { label: "Rejected", track: trackOf("rejected") },
};

export const verificationMeta = (status) => VERIFICATION_META[status] || VERIFICATION_META.draft;

/** Tabs for the authors' list, in working order. */
export const AUTHOR_TABS = ["all", "draft", "changes_requested", "submitted", "verified", "rejected"];

/** The Event Manager maintains records; only the Dean has review tabs. */
export const MANAGER_TABS = ["all", "draft", "verified"];
export const MANAGER_TAB_LABELS = { verified: "Recorded" };

/** Tabs for the Dean: the queue first. */
export const DEAN_TABS = ["submitted", "verified", "changes_requested", "rejected", "event_manager", "all"];
// The Event Manager's submissions: shown to the Dean as they are, with no
// verification status (the server keeps them out of the verification tabs).
export const DEAN_TAB_LABELS = { event_manager: "Event Manager" };

export const tabLabel = (key) => (key === "all" ? "All" : verificationMeta(key).short || verificationMeta(key).label);

/**
 * Where the research itself stands (a patent's filed / published / granted),
 * coloured by how far along its category's line it is: closed outcomes in
 * red, the last stage in green, anything before it in blue.
 */
export function outcomeTrack(category, outcome) {
  if (!category) return trackOf("draft");
  if ((category.closed_outcomes || []).includes(outcome)) return trackOf("rejected");
  const line = (category.outcomes || [])
    .map((o) => o.key)
    .filter((key) => !(category.closed_outcomes || []).includes(key));
  if (line.length <= 1) return trackOf("approved");
  const index = line.indexOf(outcome);
  if (index === line.length - 1) return trackOf("approved");
  return index <= 0 ? trackOf("draft") : trackOf("under_review");
}

export function outcomeLabel(category, outcome) {
  return category?.outcomes?.find((o) => o.key === outcome)?.label || outcome || "";
}

/**
 * Whether a field must be filled before the record can be submitted -- the
 * server's rule, mirrored for the form's asterisks only. The server decides.
 */
export function isFieldShown(field, details = {}) {
  if (!field?.shown_if) return true;
  const value = details[field.shown_if.field];
  return Array.isArray(value) ? value.includes(field.shown_if.value) : value === field.shown_if.value;
}

export function isFieldRequired(category, field, outcome, details = {}) {
  // A conditional field that does not apply (Other not ticked) is never needed.
  if (!isFieldShown(field, details)) return false;
  if (field.required) return true;
  if (!field.required_from || !category) return false;
  if ((category.closed_outcomes || []).includes(outcome)) return false;
  const keys = (category.outcomes || []).map((o) => o.key);
  const at = keys.indexOf(outcome);
  const from = keys.indexOf(field.required_from);
  return at >= 0 && from >= 0 && at >= from;
}

/** A detail value as a person reads it. */
export function formatFieldValue(field, value) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (field?.type === "date") return formatEventDay(value);
  if (field?.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return number.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  return String(value);
}

export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed since the Dean last verified the record: one row per field,
 * with the verified value and the current one. Empty when nothing did, or
 * when the record has never been verified.
 */
export function changesSinceVerified(record, category) {
  const snapshot = record?.verified_snapshot;
  if (!snapshot) return [];
  const rows = [];
  const push = (label, before, after) => {
    if (!same(before, after)) rows.push({ label, before: before || "—", after: after || "—" });
  };

  push("Title", snapshot.title, record.title);
  push(
    category?.date_label || "Date",
    snapshot.record_date ? formatEventDay(snapshot.record_date) : "",
    record.record_date ? formatEventDay(record.record_date) : "",
  );
  push("Status", outcomeLabel(category, snapshot.outcome_status), outcomeLabel(category, record.outcome_status));
  for (const field of category?.fields || []) {
    push(
      field.label,
      formatFieldValue(field, snapshot.details?.[field.key]),
      formatFieldValue(field, record.details?.[field.key]),
    );
  }
  push("Abstract", snapshot.abstract, record.abstract);
  push("Link", snapshot.link, record.link);

  const before = new Set((snapshot.evidence || []).map((e) => e.id));
  const after = new Set((record.evidence || []).map((e) => e.id));
  for (const entry of record.evidence || []) {
    if (!before.has(entry.id)) rows.push({ label: "Evidence added", before: "—", after: `${entry.tag}: ${entry.file_name}` });
  }
  for (const entry of snapshot.evidence || []) {
    if (!after.has(entry.id)) rows.push({ label: "Evidence removed", before: `${entry.tag}: ${entry.file_name}`, after: "—" });
  }
  return rows;
}

/** History actions as a sentence fragment: "<actor> submitted it". */
export const HISTORY_LABEL = {
  created: "created the record",
  updated: "edited the record",
  submitted: "submitted it for verification",
  resubmitted: "resubmitted it",
  verified: "verified it",
  changes_requested: "asked for changes",
  rejected: "rejected it",
  unverified: "withdrew the verification",
  reverification: "changed the verified record — it needs verifying again",
  recorded: "recorded it",
  evidence_added: "attached evidence",
  evidence_removed: "removed evidence",
  correction_flagged: "flagged a correction",
};

export function historyTrack(action) {
  if (action === "verified" || action === "recorded") return trackOf("approved");
  if (action === "rejected") return trackOf("rejected");
  if (action === "changes_requested" || action === "unverified" || action === "correction_flagged") {
    return trackOf("under_review");
  }
  if (action === "submitted" || action === "resubmitted" || action === "reverification") return trackOf("pending");
  return trackOf("draft");
}

/** The empty form for a category: every field present, nothing filled. */
export function emptyDetails(category) {
  const details = {};
  for (const field of category?.fields || []) details[field.key] = field.type === "multiselect" ? [] : "";
  return details;
}

const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|miss|er|shri|smt)$/;

function nameTokens(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !HONORIFIC.test(token));
}

/**
 * Where a person comes in a paper's author list (0 = first author), or -1.
 * "Dr. Meera Joshi" matches "M. Joshi" and "Meera Joshi": the same surname
 * and the same first initial, accents and titles ignored.
 */
export function authorIndex(name, authorNames = []) {
  const me = nameTokens(name);
  if (!me.length) return -1;
  const family = me[me.length - 1];
  return authorNames.findIndex((author) => {
    const them = nameTokens(author);
    if (!them.length || them[them.length - 1] !== family) return false;
    return me.length === 1 || them.length === 1 || them[0][0] === me[0][0];
  });
}

/** Only the filled-in details, as the server expects them. */
export function compactDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value) ? value.length : value !== "" && value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}


/** The one line that says what a record is, by category, for cards. */
export function recordFacts(record) {
  const d = record?.details || {};
  const join = (...parts) => parts.filter(Boolean).join(" · ");
  switch (record?.category) {
    case "journal":
      return join(
        d.journal,
        d.volume && `Vol. ${d.volume}${d.issue ? `(${d.issue})` : ""}`,
        (d.indexing || []).join(", "),
        d.quartile,
      );
    case "conference":
      return join(d.conference, d.presentation_type, d.level);
    case "patent":
      return join(d.office, d.application_number && `Appl. ${d.application_number}`, d.patent_number && `Patent ${d.patent_number}`);
    case "project": // Display-only support for records saved before this category was retired.
      return join(d.role);
    case "book":
      return join(d.book_type, d.publisher, d.isbn && `ISBN ${d.isbn}`);
    default:
      return join(d.kind, d.awarded_by, d.level);
  }
}

// Notes the system writes itself, which only restate the action beside them.
const BOILERPLATE_NOTES = [/^Recorded by the Event Manager/i, /^Imported from a spreadsheet$/i];

const joinAnd = (parts) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * A record's history as a reader wants it: newest first, with steps one
 * person took in one sitting merged into a single line ("created the record,
 * attached evidence and recorded it"), a submission that was immediately
 * recorded shown only as recorded, and notes that merely restate the action
 * left out. Notes that say something -- the Dean's remarks, the file
 * attached -- are kept.
 */
export function summariseHistory(history = [], { gapMinutes = 30 } = {}) {
  const entries = [...history].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  // A submission the same person's "recorded" followed is one step, not two.
  const kept = entries.filter((entry, i) => {
    const next = entries[i + 1];
    return !(
      ["submitted", "resubmitted"].includes(entry.action) &&
      next?.action === "recorded" &&
      next.actor_name === entry.actor_name
    );
  });

  const groups = [];
  for (const entry of kept) {
    const at = new Date(entry.created_at).getTime();
    const last = groups[groups.length - 1];
    const sameSitting =
      last &&
      last.actor_name === entry.actor_name &&
      last.actor_role === entry.actor_role &&
      Number.isFinite(at) &&
      at - last.lastTime <= gapMinutes * 60 * 1000;
    const group = sameSitting
      ? last
      : { actor_name: entry.actor_name, actor_role: entry.actor_role, actions: [], notes: [], first_at: entry.created_at, firstTime: at };
    if (!sameSitting) groups.push(group);
    group.actions.push(entry.action);
    group.last_at = entry.created_at;
    group.lastTime = at;
    const note = (entry.note || "").trim();
    if (note && !BOILERPLATE_NOTES.some((re) => re.test(note)) && !group.notes.includes(note)) group.notes.push(note);
  }

  // The step that says most about where the record stands colours the line.
  const weight = { verified: 5, recorded: 5, rejected: 5, unverified: 4, changes_requested: 4, reverification: 3, submitted: 3, resubmitted: 3, correction_flagged: 3 };
  return groups
    .map((group) => {
      const counts = {};
      for (const action of group.actions) counts[action] = (counts[action] || 0) + 1;
      const phrases = Object.entries(counts).map(([action, n]) => {
        const label = HISTORY_LABEL[action] || action.replace(/_/g, " ");
        return n > 1 && action.startsWith("evidence_") ? `${label} (${n} files)` : label;
      });
      const lead = group.actions.reduce((best, a) => ((weight[a] || 0) > (weight[best] || 0) ? a : best), group.actions[0]);
      return {
        actor_name: group.actor_name,
        actor_role: group.actor_role,
        text: joinAnd(phrases),
        notes: group.notes,
        first_at: group.first_at,
        last_at: group.last_at,
        track: historyTrack(lead),
      };
    })
    .reverse();
}
