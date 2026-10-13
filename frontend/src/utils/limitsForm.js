/**
 * Turning the upload-limits API into editable form state, and back.
 *
 * Pure functions with no React in them, so the validation rules can be read --
 * and tested -- on their own. The ranges are never hardcoded here: they arrive
 * from the server's `bounds`, which is derived from the same Pydantic model
 * that enforces them, so the form and the API cannot drift apart.
 */

import { OPTIONAL_LIMIT_FIELDS } from "./uploadLimits";

/**
 * Rejects "20.5", "2e3", "-1", "" and " ". The API takes integers, and the old
 * form validated with Number.isFinite but serialised with parseInt, so 20.5 was
 * silently saved as 20.
 */
const INTEGER_RE = /^\d+$/;

const MB = 1024 * 1024;

export const isOptional = (field) => OPTIONAL_LIMIT_FIELDS.includes(field);

/**
 * Server values -> form values. Numbers become strings; null means "no cap".
 * The mandatory-upload switches are booleans and stay that way.
 */
export function fromServer(limits) {
  return Object.fromEntries(
    Object.entries(limits).map(([field, value]) => [
      field,
      value === null || value === undefined
        ? null
        : typeof value === "boolean"
          ? value
          : String(value),
    ]),
  );
}

/** Form values -> request body. null passes through as "no cap". */
export function toWire(values) {
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      field,
      value === null || value === ""
        ? null
        : typeof value === "boolean"
          ? value
          : Number(value),
    ]),
  );
}

export function isDirty(values, pristine) {
  if (!values || !pristine) return false;
  return Object.keys(values).some((field) => values[field] !== pristine[field]);
}

const label = (field) =>
  field
    .replace(/^max_/, "")
    .replace(/_mb$/, "")
    .replace(/_/g, " ");

/**
 * Per-field messages, keyed by field name.
 *
 * Relationship rules attach the same message to *both* participants, so whichever
 * one the admin looks at explains itself and both light up aria-invalid.
 */
export function validateLimits(values, bounds, { deploymentCeilingMb = null } = {}) {
  const errors = {};
  const numbers = {};

  for (const [field, raw] of Object.entries(values)) {
    const bound = bounds[field];
    if (!bound) continue;

    if (raw === null) {
      // Only the nullable fields may be absent; everything else is required.
      if (!isOptional(field)) errors[field] = "This value is required.";
      continue;
    }

    const text = String(raw).trim();
    if (!INTEGER_RE.test(text)) {
      errors[field] = `Enter a whole number between ${bound.min} and ${bound.max}.`;
      continue;
    }

    const value = Number(text);
    if (value < bound.min || value > bound.max) {
      errors[field] = `Enter a whole number between ${bound.min} and ${bound.max}.`;
      continue;
    }
    numbers[field] = value;
  }

  const both = (a, b, message) => {
    if (errors[a] || errors[b]) return; // don't mask a more basic problem
    errors[a] = message;
    errors[b] = message;
  };

  // Checked independently, not chained off the range check: the old form put
  // this in an `else if`, so it never ran when the total was itself invalid.
  if (numbers.max_photo_total_mb != null && numbers.max_photo_size_mb != null) {
    if (numbers.max_photo_total_mb < numbers.max_photo_size_mb) {
      both(
        "max_photo_total_mb",
        "max_photo_size_mb",
        "The combined photo budget cannot be smaller than the per-photo limit.",
      );
    }
  }

  if (numbers.max_video_total_mb != null && numbers.max_video_size_mb != null) {
    if (numbers.max_video_size_mb > numbers.max_video_total_mb) {
      both(
        "max_video_size_mb",
        "max_video_total_mb",
        "The per-video limit cannot exceed the combined video budget.",
      );
    }
  }

  // Mirrors the server's check. These caps replace the global backstop on the
  // upload path, so a larger value would promise an upload the deployment
  // cannot physically accept.
  if (deploymentCeilingMb != null) {
    for (const field of ["max_photo_size_mb", "max_video_size_mb", "max_documents_total_mb"]) {
      const value = numbers[field];
      if (value != null && value > deploymentCeilingMb && !errors[field]) {
        errors[field] =
          `This deployment cannot accept a file larger than ${deploymentCeilingMb} MB.`;
      }
    }
  }

  return errors;
}

const num = (value) => (value === null || value === "" ? null : Number(value));

/**
 * What the current form values actually mean for one event, in bytes-on-disk
 * terms. This is the number an admin is really setting and could not see
 * anywhere on the old page.
 */
export function effectiveCeiling(values) {
  const photoCount = num(values.max_photos_per_event);
  const photoSize = num(values.max_photo_size_mb);
  const photoTotal = num(values.max_photo_total_mb);
  const videoCount = num(values.max_videos_per_event);
  const videoSize = num(values.max_video_size_mb);
  const videoTotal = num(values.max_video_total_mb);
  const docTotal = num(values.max_documents_total_mb);

  // Photos are capped by count x per-file, narrowed by the combined budget when
  // one is set.
  const photosByCount = photoCount != null && photoSize != null ? photoCount * photoSize : null;
  const photosMb =
    photoTotal != null && photosByCount != null
      ? Math.min(photoTotal, photosByCount)
      : (photoTotal ?? photosByCount);

  // Videos are budgeted by combined size; a count cap can only lower it.
  const videosByCount = videoCount != null && videoSize != null ? videoCount * videoSize : null;
  const videosMb =
    videosByCount != null && videoTotal != null
      ? Math.min(videoTotal, videosByCount)
      : videoTotal;

  const parts = [photosMb, videosMb, docTotal].filter((mb) => mb != null);
  const largestSingleMb = Math.max(
    ...[photoSize, videoSize, docTotal].filter((mb) => mb != null),
    0,
  );

  return {
    photosMb,
    videosMb,
    documentsMb: docTotal,
    worstCaseMb: parts.length ? parts.reduce((sum, mb) => sum + mb, 0) : null,
    largestSingleMb: largestSingleMb || null,
  };
}

export const mbToBytes = (mb) => (mb == null ? null : mb * MB);
export const fieldLabel = label;
