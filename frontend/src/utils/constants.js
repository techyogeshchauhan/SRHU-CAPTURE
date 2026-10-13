/**
 * Shared event vocabulary and filter predicates for the Dean views.
 *
 * Status buckets deliberately mirror the backend dashboard-stats handler
 * (backend/app/routers/events.py). If these diverge, the status chip counts
 * will contradict the Dean dashboard's stat cards.
 */

/**
 * Event types the backend accepts for its `event_type` filter
 * (backend/app/routers/events.py). The Program Type dropdown is sourced from
 * this list so it can never offer a value the API would reject with a 400.
 */
export const EVENT_TYPES = [
  "Cultural",
  "Sports",
  "Academic",
  "Workshop",
  "Seminar",
  "Other",
];

/** Status filter options offered to the Dean. Drafts never reach the Dean. */
export const DEAN_STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export function normalizeStatus(status) {
  return String(status ?? "").trim().toLowerCase();
}

/**
 * Collapse a raw status into the bucket the Dean filters by.
 * Mirrors the backend stats grouping.
 */
export function getStatusBucket(status) {
  const value = normalizeStatus(status);

  if (value === "pending" || value === "submitted" || value === "under_review") {
    return "pending";
  }

  if (
    value === "approved" ||
    value === "published" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "recorded"
  ) {
    return "approved";
  }

  if (value === "rejected" || value === "revoked") {
    return "rejected";
  }

  return "other";
}

const STATUS_META = {
  draft: {
    label: "Draft",
    badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300",
    dotClass: "bg-slate-400",
  },
  pending: {
    label: "Pending",
    badgeClass: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20",
    dotClass: "bg-amber-500",
  },
  submitted: {
    label: "Submitted",
    badgeClass: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20",
    dotClass: "bg-amber-500",
  },
  under_review: {
    label: "Under Review",
    badgeClass: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20",
    dotClass: "bg-sky-500",
  },
  approved: {
    label: "Approved",
    badgeClass:
      "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
    dotClass: "bg-emerald-500",
  },
  // "In Progress" was removed from event tracking. An event still stored with
  // it (until scripts/migrate_in_progress_to_approved.py runs) reads as Approved.
  in_progress: {
    label: "Approved",
    badgeClass:
      "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
    dotClass: "bg-emerald-500",
  },
  completed: {
    label: "Completed",
    badgeClass:
      "bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-600/20",
    dotClass: "bg-teal-500",
  },
  published: {
    label: "Published",
    badgeClass:
      "bg-purple-50 text-purple-700 ring-1 ring-inset ring-purple-600/20",
    dotClass: "bg-purple-500",
  },
  rejected: {
    label: "Rejected",
    badgeClass: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20",
    dotClass: "bg-rose-500",
  },
  revoked: {
    label: "Revoked",
    badgeClass: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20",
    dotClass: "bg-rose-600",
  },
  // Event Manager only: saved straight away, no Dean review.
  recorded: {
    label: "Recorded",
    badgeClass:
      "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
    dotClass: "bg-emerald-500",
  },
};

const UNKNOWN_STATUS_META = {
  label: "Unknown",
  badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300",
  dotClass: "bg-slate-400",
};

/**
 * Presentation for a status. The label reports the *true* status so that
 * `submitted` / `under_review` / `published` are never silently shown as
 * "Pending"; only the colour family follows the bucket.
 */
export function getStatusMeta(status) {
  const key = normalizeStatus(status);
  const meta = STATUS_META[key];

  if (!meta) {
    return { key, ...UNKNOWN_STATUS_META };
  }

  return { key, ...meta };
}

/** True when the event belongs to the selected status bucket. */
export function matchesStatusFilter(event, filterKey) {
  if (!filterKey || filterKey === "all") {
    return true;
  }

  return getStatusBucket(event?.status) === filterKey;
}

/** True when the event matches the selected program type. */
export function matchesTypeFilter(event, typeKey) {
  if (!typeKey) {
    return true;
  }

  return normalizeStatus(event?.event_type) === normalizeStatus(typeKey);
}

/**
 * Free-text match over the fields the Dean's table actually shows.
 *
 * The field list mirrors the `q` filter of GET /dean/events
 * (backend/app/routers/events.py). The dashboard filters its own fetched rows
 * with this, while All Events asks the server — so the same words typed into
 * either box have to find the same events, or the two pages disagree.
 *
 * `description` is deliberately excluded: teacher-entered extras are encoded
 * into it as an HTML comment, which would produce phantom matches.
 */
export function matchesEventSearch(event, query) {
  const term = String(query ?? "").trim().toLowerCase();

  if (!term) {
    return true;
  }

  return [
    event?.event_name,
    event?.location,
    event?.event_type,
    event?.organizer,
    // The submitting teacher, which the server's `q` filter also matches and
    // GET /dean/events now returns on every row. Without these two the
    // dashboard search found nothing for a teacher's name while All Events,
    // which asks the server, found their events.
    event?.teacher_name,
    event?.teacher_email,
  ].some((field) => String(field ?? "").toLowerCase().includes(term));
}

/** Bucket totals for the status chips. Always compute from the fetch scope. */
export function countByStatusBucket(events) {
  const list = Array.isArray(events) ? events : [];

  return {
    all: list.length,
    pending: list.filter((event) => getStatusBucket(event?.status) === "pending")
      .length,
    approved: list.filter(
      (event) => getStatusBucket(event?.status) === "approved"
    ).length,
    rejected: list.filter(
      (event) => getStatusBucket(event?.status) === "rejected"
    ).length,
  };
}

// ------------------------------------------------------------------
// Dean decisions (PRD 18)
//
// Reject and revoke are separate actions over separate statuses, not one
// button that changes label. They previously shared a control that always
// called /reject -- and because rejection only accepts a *pending* event,
// pressing it on an approved one answered 409. Revoking was unreachable.
// ------------------------------------------------------------------

/** Approve, or re-approve something previously refused. */
export function canApprove(event) {
  return (
    getStatusBucket(event?.status) !== "approved" &&
    normalizeStatus(event?.status) !== "recorded"
  );
}

/** Reject: a first refusal, only while the event is still awaiting review. */
export function canReject(event) {
  return (
    getStatusBucket(event?.status) === "pending" &&
    normalizeStatus(event?.status) !== "recorded"
  );
}

/** Revoke: withdraw an approval that has already been granted. */
export function canRevoke(event) {
  return (
    getStatusBucket(event?.status) === "approved" &&
    normalizeStatus(event?.status) !== "recorded"
  );
}

/** Changes can only be asked for while the event still awaits a first decision. */
export function canRequestChanges(event) {
  return getStatusBucket(event?.status) === "pending";
}

/** Action labels that read correctly when a previous decision is being revised. */
export function getApproveLabel(event) {
  return getStatusBucket(event?.status) === "rejected" ? "Re-approve" : "Approve";
}

// ============================================================
// EVENT PROGRESS / WORKFLOW STAGES
//
// Created -> Pending -> Approved -> Completed
//                    \-> Rejected
// ============================================================

export const PROGRESS_STAGES = [
  {
    key: "created",
    label: "Event Created",
    description: "The teacher submitted this event for review.",
  },
  {
    key: "pending",
    label: "Pending Review",
    description: "Awaiting the Dean's approval decision.",
  },
  {
    key: "approved",
    label: "Approved",
    description: "The Dean approved this event. It can now go ahead.",
  },
  {
    key: "completed",
    label: "Completed",
    description: "The event has finished.",
  },
];

export const REJECTED_STAGE = {
  key: "rejected",
  label: "Rejected",
  description: "The Dean rejected this event. See the reason below.",
};

export const REVOKED_STAGE = {
  key: "revoked",
  label: "Revoked",
  description: "The Dean withdrew the approval. See the reason below.",
};

/** Index of the stage an event has reached along the happy path. */
export function getProgressIndex(status) {
  const value = normalizeStatus(status);

  if (value === "completed") return 3;
  // The retired "in_progress" sits at Approved, the stage it has become.
  if (value === "approved" || value === "published" || value === "in_progress") return 2;
  // Revoked is the fourth node of its own trail (below): the event reached
  // Approved before the Dean withdrew it, so it is not back at Pending.
  if (value === "revoked") return 3;
  if (value === "rejected") return 1;
  if (value === "pending" || value === "submitted" || value === "under_review") {
    return 1;
  }

  return 0;
}

export function isRejected(status) {
  return normalizeStatus(status) === "rejected";
}

/** Refused either way: rejected outright, or approved and then revoked. */
export function isRefused(status) {
  const value = normalizeStatus(status);
  return value === "rejected" || value === "revoked";
}

/** The reason behind a refusal, whichever kind it was. */
export function getRefusalReason(event) {
  return event?.rejection_reason || event?.revocation_reason || "";
}

/**
 * The stage list to render for an event: the rejected branch replaces
 * everything after Pending, since the workflow stops there.
 */
export function getProgressTrail(status) {
  if (isRejected(status)) {
    return [PROGRESS_STAGES[0], PROGRESS_STAGES[1], REJECTED_STAGE];
  }

  // A revocation happens *after* approval, so its trail keeps the Approved
  // node it actually passed through rather than pretending it never got there.
  if (normalizeStatus(status) === "revoked") {
    return [
      PROGRESS_STAGES[0],
      PROGRESS_STAGES[1],
      PROGRESS_STAGES[2],
      REVOKED_STAGE,
    ];
  }

  return PROGRESS_STAGES;
}

/** Which post-approval stage the Dean can move to next, if any. */
export function getNextStage(status) {
  const value = normalizeStatus(status);

  if (value === "approved" || value === "published" || value === "in_progress") {
    return { key: "completed", label: "Mark Completed" };
  }

  return null;
}

/**
 * Which post-approval stage the Dean can step back to, if any. None: Completed
 * is final -- the report is generated from it -- and the server refuses the
 * move (update_event_stage), so the option is not offered.
 */
// eslint-disable-next-line no-unused-vars
export function getPreviousStage(status) {
  return null;
}

// ============================================================
// TEACHER EDIT WINDOW
//
// A teacher may edit their own event until the Dean approves it. Keep this in
// step with TEACHER_EDITABLE_STATUSES in backend/app/models/documents.py --
// the API enforces it, this only decides what the UI offers.
// ============================================================

export const TEACHER_EDITABLE_STATUSES = [
  "draft",
  "submitted",
  "pending",
  "under_review",
  "rejected",
  // A revoked event is editable and resubmittable on the server
  // (RESUBMITTABLE_STATUSES in the events router). Leaving it out here hid
  // the Edit button on an event the API would happily have accepted, which
  // stranded the teacher with no way out of a revocation.
  "revoked",
  // An Event Manager's saved event: nobody reviews it, so it stays editable.
  // A teacher's event never has this status.
  "recorded",
];

export function canTeacherEditEvent(event) {
  const status = normalizeStatus(
    typeof event === "string" ? event : event?.status
  );

  // A local draft has no DB row yet and is always editable.
  if (!status) {
    return true;
  }

  return TEACHER_EDITABLE_STATUSES.includes(status);
}

/** Why editing is unavailable, for a tooltip / helper line. */
export function getEditLockReason(event) {
  if (canTeacherEditEvent(event)) {
    return "";
  }

  return "This event has been approved and can no longer be edited.";
}
