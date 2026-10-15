/**
 * One place to read an event's scheduling and organiser fields.
 *
 * These four used to be smuggled into `description` as a `<!--CC_METADATA:-->`
 * JSON comment. They are now real API fields, but events created before that
 * change still carry them only in the blob, so every read goes through here:
 * the real field wins, the blob fills the gap.
 *
 * `department` and `expectedParticipants` were deliberately left in the blob —
 * nothing validates, queries or sorts on them.
 *
 * Copying this fallback into each call site is exactly how one of them would
 * end up wrong and silently blank a field on older events, so every consumer
 * imports this instead.
 */

import { decodeEventMetadata } from "./draftStorage";

/**
 * The host of every event. The platform serves SST (School of Science &
 * Technology) only, so the form no longer asks for a host department or
 * school: new events store this, and an event without one reads as this.
 */
export const DEFAULT_HOST_DEPARTMENT = "SST";

const HOST_DEPARTMENT_DISPLAY_NAME =
  "Computer Science and Engineering, School of Science and Technology";

/**
 * Resolve the explicit field, legacy metadata or host default for display.
 * Keep the persisted identifier used by the create-event wizard unchanged.
 */
export function getEventDepartmentName(event = {}) {
  const department = readEventFields(event).department;
  return department.toUpperCase() === DEFAULT_HOST_DEPARTMENT
    ? HOST_DEPARTMENT_DISPLAY_NAME
    : department;
}

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = value == null ? "" : String(value).trim();
    if (text) return text;
  }
  return "";
};

/**
 * Normalised fields for an event from the API, a draft, or the wizard's own
 * form state.
 *
 * @param {Object} event
 * @returns {{startTime, endTime, organizer, contactInfo, department,
 *            expectedParticipants, description}}
 */
export function readEventFields(event = {}) {
  const { description, meta } = decodeEventMetadata(event.description || "");

  return {
    startTime: firstNonEmpty(event.start_time, event.startTime, meta.startTime),
    endTime: firstNonEmpty(event.end_time, event.endTime, meta.endTime),
    organizer: firstNonEmpty(event.organizer, meta.organizer),
    contactInfo: firstNonEmpty(
      event.coordinator_contact,
      event.contactInfo,
      meta.contactInfo,
    ),
    // Still blob-only, but read through the same helper so call sites never
    // need to know which fields were promoted and which were not.
    department: firstNonEmpty(event.department, meta.department, DEFAULT_HOST_DEPARTMENT),
    expectedParticipants: firstNonEmpty(
      event.expectedParticipants,
      meta.expectedParticipants,
    ),
    description,
  };
}

export default readEventFields;
