import { isApprovedStatus } from "../components/teacher/status";

export const DRAFT_REPORT_MESSAGE = "Draft events cannot be included in the report. Please select only non-draft events to generate the report.";
export const APPROVAL_REPORT_MESSAGE = "Report unavailable.";

/** Legacy recorded events retain access. New events carry a server-owned
 * approval marker; a prior report never overrides a current refusal or draft. */
export function eventReportRestriction(event) {
  const status = String(event?.status || "").trim().toLowerCase();
  if (event?.isDraft || status === "draft") return DRAFT_REPORT_MESSAGE;
  const legacyRecorded = status === "recorded" && event?.report_approval_required !== true;
  return isApprovedStatus(status) || legacyRecorded ? "" : APPROVAL_REPORT_MESSAGE;
}

export function selectedReportsRestriction(events) {
  if (events.some((event) => eventReportRestriction(event) === DRAFT_REPORT_MESSAGE)) return DRAFT_REPORT_MESSAGE;
  return events.some((event) => eventReportRestriction(event)) ? APPROVAL_REPORT_MESSAGE : "";
}
