/**
 * Event Manager reports (backend: routers/event_manager.py).
 *
 * The Event Manager uses the Teacher panel's screens against its own event
 * API (see components/teacher/panel.jsx); what it adds is here: reports are
 * generated directly -- for one event or for a selection of several -- and
 * each event's report shows every chosen photo.
 */
import { apiFetch, apiJson, errorFromResponse } from "./api";
import { fileNameFromResponse, reportFileName } from "../utils/fileNames";

const BASE = "/event-manager";

/** Most events one consolidated report may cover (backend MAX_EVENTS_PER_REPORT). */
export const MAX_EVENTS_PER_REPORT = 50;

/**
 * Photos a report shows until the teacher or Event Manager chooses (backend
 * DEFAULT_REPORT_PHOTOS). Once they choose, the report shows as many as they tick.
 */
export const DEFAULT_REPORT_PHOTOS = 4;

/** Delete these events (with their files) in one request. `api` is the panel's event API. */
export const bulkDeleteEvents = (ids, api = BASE) =>
  apiJson(`${api}/events/bulk-delete`, { method: "POST", body: { event_ids: ids } });

/**
 * Move these drafts on in one request: a teacher's go to the Dean for approval
 * (bulk-submit), an Event Manager's are recorded at once (bulk-record). Each is
 * checked like the form's own Submit; the answer says which went and why the
 * others did not.
 */
export const bulkSubmitDrafts = (ids, { api = BASE, approval = false } = {}) =>
  apiJson(`${api}/events/${approval ? "bulk-submit" : "bulk-record"}`, {
    method: "POST",
    body: { event_ids: ids },
  });

/**
 * Save which photos go into the event's report. Both panels choose them the
 * same way: `api` is the panel's event API ("/teacher" for the Dean's report,
 * "/event-manager" by default).
 */
export const saveReportPhotos = (id, photoIds, api = BASE) =>
  apiJson(`${api}/events/${id}/report-photos`, { method: "PUT", body: { photo_ids: photoIds } });

/**
 * A generated report, once it is ready, is handed to the browser:
 *
 * - on https (the deployed app) it downloads directly as a file;
 * - on plain http (the app reached at http://<LAN address>) Chrome blocks
 *   every download ("Insecure download blocked") but not a PDF shown in a
 *   tab, so it opens in Chrome's PDF viewer instead.
 *
 * Nothing opens or navigates until the report exists: the page stays put,
 * with the button's spinner, while it is generated. A tab opened after the
 * request can be stopped by the pop-up blocker (the click's permission lasts
 * a few seconds); then REPORT_READY_EVENT is dispatched and ReportReadyPrompt
 * offers an "Open report" button, which is a fresh click the blocker allows.
 */
export const REPORT_READY_EVENT = "campus:report-ready";

function saveBlob(blob, fileName) {
  const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
  const url = window.URL.createObjectURL(pdf);

  if (!window.isSecureContext) {
    const tab = window.open(url, "_blank");
    if (!tab) {
      window.dispatchEvent(new CustomEvent(REPORT_READY_EVENT, { detail: { url, fileName } }));
      return "ready";
    }
    // The tab is still reading it; release the memory once it has.
    setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
    return "opened";
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 1_000);
  return "downloaded";
}

async function fetchReport(path, options, fallbackName) {
  const response = await apiFetch(path, options);
  if (!response.ok) throw await errorFromResponse(response, "Could not generate the report.");
  return saveBlob(await response.blob(), fileNameFromResponse(response) || fallbackName);
}

/**
 * What to tell the user once a report call resolves: "downloaded", "opened"
 * (in a new tab) or "ready" (ReportReadyPrompt is asking for a click -- say
 * nothing more).
 */
export function reportNotice(outcome, what = "Report") {
  if (outcome === "ready") return "";
  return outcome === "opened" ? `${what} opened in a new tab.` : `${what} downloaded.`;
}


/** Download (or, on plain http, open) the report for one event. Resolves with the outcome. */
export function downloadEventReport(id, eventName, customization = null) {
  const options = customization ? { method: "POST", body: customization } : {};
  return fetchReport(`${BASE}/events/${id}/report`, options, reportFileName(eventName));
}

/** One consolidated report for several events, in the order given. */
export function downloadEventsReport(ids, customization = null) {
  const body = { event_ids: ids };
  if (customization) body.customization = customization;
  return fetchReport(
    `${BASE}/reports`,
    { method: "POST", body },
    reportFileName(`Consolidated_Event_Report_${new Date().toISOString().slice(0, 10)}`),
  );
}

/** Download (or open) the report for one Dean event. Resolves with the outcome. */
export function downloadDeanEventReport(id, eventName, customization = null) {
  const options = customization ? { method: "POST", body: customization } : {};
  return fetchReport(`/dean/events/${id}/report/download`, options, reportFileName(eventName));
}

/** One consolidated report for several Dean events. */
export function downloadDeanEventsReport(ids, customization = null) {
  const body = { event_ids: ids };
  if (customization) body.customization = customization;
  return fetchReport(
    `/dean/reports`,
    { method: "POST", body },
    reportFileName(`Consolidated_Event_Report_${new Date().toISOString().slice(0, 10)}`),
  );
}
