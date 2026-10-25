/**
 * Lookup data the create-event form needs: event categories and faculty
 * coordinators. Both are lists the teacher picks from and may add to.
 */

import { apiJson } from "./api";

/**
 * The category list used to be hardcoded in three places that had already
 * drifted apart — a teacher could pick a type the Dean's filter could not
 * select. It is server data now; this is the only copy left, and it exists
 * solely so the form still works if the request fails.
 */
export const FALLBACK_EVENT_TYPES = [
  "Academic",
  "Cultural",
  "Sports",
  "Workshop",
  "Seminar",
  "Conference",
  "Celebration",
  "Funded FDP",
  "Funded Programme",
  "Other",
];

// Shared across every component that mounts at once (the wizard and the Dean
// filters), so the list is fetched once per page rather than per consumer.
let inFlight = null;
export const EVENT_TYPES_CHANGED = "campus:event-types-changed";

function refreshEventTypes(data) {
  const names = data?.event_types || [];
  inFlight = Promise.resolve(names);
  window.dispatchEvent(new CustomEvent(EVENT_TYPES_CHANGED, { detail: names }));
  return data;
}

export async function listEventTypes({ force = false } = {}) {
  if (force) inFlight = null;
  if (!inFlight) {
    inFlight = apiJson("/event-types")
      .then((data) => data?.event_types || [])
      .catch((error) => {
        inFlight = null; // let the next caller retry
        throw error;
      });
  }
  return inFlight;
}

export async function createEventType(name) {
  const data = await apiJson("/event-types", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return refreshEventTypes(data);
}

export async function listManageableEventTypes() {
  const data = await apiJson("/event-types/manage");
  return data.event_types;
}

export function getEventTypeUsage(id) {
  return apiJson(`/event-types/${encodeURIComponent(id)}/usage`);
}

export async function renameEventType(id, name) {
  return refreshEventTypes(await apiJson(`/event-types/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ name }),
  }));
}

export async function deleteEventType(id, destinationId) {
  return refreshEventTypes(await apiJson(`/event-types/${encodeURIComponent(id)}`, {
    method: "DELETE", body: JSON.stringify({ destination_id: destinationId }),
  }));
}

export async function listFacultyCoordinators(query = "") {
  const search = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const data = await apiJson(`/faculty/coordinators${search}`);
  return data?.coordinators || [];
}

export async function createFacultyCoordinator({ name, phone }) {
  const data = await apiJson("/faculty/coordinators", {
    method: "POST",
    body: JSON.stringify({ name, phone }),
  });
  return data?.coordinator || null;
}

/**
 * Names already attached to this event (PRD 10).
 * Returns a { [fileName]: boolean } map; an empty map on failure, because a
 * duplicate check that cannot run must not block the upload.
 */
export async function checkUploadNames(eventId, fileNames, kind = "media", apiBase = "/teacher") {
  const names = (fileNames || []).filter(Boolean);
  if (!eventId || names.length === 0) return {};

  const query = names
    .map((name) => `file_name=${encodeURIComponent(name)}`)
    .join("&");

  try {
    const data = await apiJson(
      `${apiBase}/events/${eventId}/uploads/check-name?${query}&kind=${kind}`,
    );
    return data?.duplicates || {};
  } catch {
    return {};
  }
}
