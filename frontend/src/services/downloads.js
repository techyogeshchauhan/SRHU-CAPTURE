/**
 * Files the API generates -- the "Download Excel" exports and PDFs -- fetched
 * with the login token and handed to the browser as a download.
 */

import { apiFetch, errorFromResponse } from "./api";
import { fileNameFromResponse } from "../utils/fileNames";

export const queryString = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/** Resolves once the download starts. `options` as for apiFetch (a POST body). */
export async function downloadFile(path, fallbackName, options) {
  const response = await apiFetch(path, options);
  if (!response.ok) throw await errorFromResponse(response, "The file could not be generated.");
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileNameFromResponse(response) || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 1_000);
}

// ---------------------------------------------------------------- Excel

/** The Dean's event list under the page's filters. */
export const downloadDeanEventsExcel = (params) =>
  downloadFile(`/dean/events/export.xlsx${queryString(params)}`, "events.xlsx");

/**
 * My Events under its filters (every page of it); `api` is the panel's
 * ("/teacher", "/event-manager"). `params`: q, status, event_type,
 * start_date, end_date -- as the list asks for its pages.
 */
export const downloadMyEventsExcel = (params, { api }) =>
  downloadFile(`${api}/events/export.xlsx${queryString(params)}`, "my-events.xlsx");

/** The Dean's faculty list under the page's filters. */
export const downloadTeachersExcel = (params) =>
  downloadFile(`/dean/teachers/export.xlsx${queryString(params)}`, "teachers.xlsx");

/** The Super Admin's accreditation (NAAC / NIRF) export of events. */
export const downloadAccreditationExcel = (params) =>
  downloadFile(`/superadmin/events/export.xlsx${queryString(params)}`, "events-naac-nirf.xlsx");
