/**
 * The research portfolio API (backend routers/research.py).
 *
 * Event Managers and teachers share `/research/...` -- the server decides
 * what each may see -- and the Dean has `/dean/research/...`.
 */

import { apiJson, apiUpload } from "./api";
import { downloadFile } from "./downloads";

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

// ---------------------------------------------------------------- shared

let categoriesPromise = null;

/** Category definitions, fetched once per page load and shared. */
export function fetchResearchCategories() {
  if (!categoriesPromise) {
    categoriesPromise = apiJson("/research/categories").catch((err) => {
      categoriesPromise = null;
      throw err;
    });
  }
  return categoriesPromise;
}

// ---------------------------------------------------------------- authors

export const listResearch = (params, options) => apiJson(`/research/records${query(params)}`, options);

export const getResearch = (id) => apiJson(`/research/records/${id}`);

export const createResearch = (body) => apiJson("/research/records", { method: "POST", body });

export const updateResearch = (id, body) => apiJson(`/research/records/${id}`, { method: "PATCH", body });

export const submitResearch = (id) => apiJson(`/research/records/${id}/submit`, { method: "POST" });

export const deleteResearch = (id) => apiJson(`/research/records/${id}`, { method: "DELETE" });

/** Event Manager: delete several records; each is checked like a single delete. */
export const bulkDeleteResearch = (ids) =>
  apiJson("/research/records/bulk-delete", { method: "POST", body: { ids } });

/** Event Manager: record several ready research submissions in one action. */
export const bulkRecordResearch = (ids) =>
  apiJson("/research/records/bulk-record", { method: "POST", body: { ids } });

/** Event Manager: every record matching the filters that may be deleted (ids, titles). */
export const deletableResearchIds = (params) => apiJson(`/research/records/deletable-ids${query(params)}`);

export const flagResearch = (id, note) =>
  apiJson(`/research/records/${id}/flag`, { method: "POST", body: { note } });

export const uploadEvidence = (id, file, tag, { onProgress, signal } = {}) =>
  apiUpload(`/research/records/${id}/evidence`, { file, extraFields: { tag }, onProgress, signal });

export const removeEvidence = (id, evidenceId) =>
  apiJson(`/research/records/${id}/evidence/${evidenceId}`, { method: "DELETE" });

export const searchFaculty = (q, options) => apiJson(`/research/faculty${query({ q })}`, options);

/** Event Manager: add a faculty member with no account yet (a Teacher). */
export const addFaculty = (body) => apiJson("/research/faculty", { method: "POST", body });

// ---------------------------------------------------------------- Dean

export const deanListResearch = (params, options) =>
  apiJson(`/dean/research/records${query(params)}`, options);

export const deanGetResearch = (id) => apiJson(`/dean/research/records/${id}`);

export const deanDeleteResearch = (id) =>
  apiJson(`/dean/research/records/${id}`, { method: "DELETE" });

export const deanBulkDeleteResearch = (ids) =>
  apiJson("/dean/research/bulk-delete", { method: "POST", body: { ids } });

/** The Dean's figures for what the Event Manager submitted, under the page's filters. */
export const deanResearchOverview = (params, options) =>
  apiJson(`/dean/research/overview${query(params)}`, options);

export const deanResearchSummary = (includePending = false) =>
  apiJson(`/dean/research/summary${query({ include_pending: includePending || undefined })}`);

/** verb: "verify" | "request-changes" | "reject" | "unverify" */
export const deanDecideResearch = (id, verb, remarks) =>
  apiJson(`/dean/research/records/${id}/${verb}`, {
    method: "PATCH",
    body: remarks ? { remarks } : {},
  });

export const deanBulkVerifyResearch = (ids) =>
  apiJson("/dean/research/bulk-verify", { method: "POST", body: { ids } });

// ---------------------------------------------------------------- files

export { downloadFile };

/** Excel of the filtered register; with `faculty_id`, one faculty member's research. */
export const exportResearch = (params, { dean = false } = {}) =>
  downloadFile(`${dean ? "/dean" : ""}/research/export.xlsx${query(params)}`, "research-register.xlsx");

/** The NAAC Criterion III workbook (Event Manager and Dean). */
export const exportNaac = (academicYear, { dean = false } = {}) =>
  downloadFile(
    `${dean ? "/dean" : ""}/research/export/naac.xlsx${query({ academic_year: academicYear })}`,
    "naac-criterion-3-research.xlsx",
  );

/** A faculty member's research CV (verified records). */
export const downloadResearchCv = (facultyId, { dean = false } = {}) =>
  downloadFile(`${dean ? "/dean" : ""}/research/faculty/${facultyId}/cv.pdf`, "research-cv.pdf");

// ---------------------------------------------------------------- tools

/** Every faculty member with research, and their count per category. */
export const researchFacultySummary = (params, { dean = false, signal } = {}) =>
  apiJson(`${dean ? "/dean" : ""}/research/faculty-summary${query(params)}`, signal ? { signal } : undefined);

/** The faculty-wise table as shown, as Excel. */
export const exportFacultySummary = (params, { dean = false } = {}) =>
  downloadFile(`${dean ? "/dean" : ""}/research/faculty-summary.xlsx${query(params)}`, "faculty-wise-research.xlsx");

export const researchAnalytics = (params, { dean = false, signal } = {}) =>
  apiJson(`${dean ? "/dean" : ""}/research/analytics${query(params)}`, signal ? { signal } : undefined);

export const lookupDoi = (doi) => apiJson(`/research/doi${query({ doi })}`);

export const checkDuplicates = (body, options) =>
  apiJson("/research/duplicates", { method: "POST", body, ...options });

export const outcomesDue = () => apiJson("/research/outcomes-due");

export const checkResearchReminders = () => apiJson("/research/reminders/check", { method: "POST" });

// ---------------------------------------------------------------- showcases

export const listShowcases = () => apiJson("/research/showcases");
export const createShowcase = (body) => apiJson("/research/showcases", { method: "POST", body });
export const getShowcase = (id) => apiJson(`/research/showcases/${id}`);
export const updateShowcase = (id, body) => apiJson(`/research/showcases/${id}`, { method: "PATCH", body });
export const deleteShowcase = (id) => apiJson(`/research/showcases/${id}`, { method: "DELETE" });
export const sendShowcase = (id) => apiJson(`/research/showcases/${id}/send`, { method: "POST" });

export const deanListShowcases = () => apiJson("/dean/research/showcases");
export const deanGetShowcase = (id) => apiJson(`/dean/research/showcases/${id}`);

export const downloadShowcasePdf = (id, { dean = false } = {}) =>
  downloadFile(`${dean ? "/dean" : ""}/research/showcases/${id}/pdf`, "research-showcase.pdf");
