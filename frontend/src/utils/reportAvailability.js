/**
 * Which report sections an event has anything for, so the section picker
 * (ReportCustomizationModal) can disable the rest.
 *
 * Two sources, one shape:
 * - a list row carries no files, so the Dean's list asks the server
 *   (POST /dean/reports/availability), which applies the PDF builder's rules;
 * - an event page already holds the files, and works it out here by the very
 *   same rules -- keep `availabilityFromFiles` in step with
 *   `report_availability` in backend/app/routers/reports.py.
 *
 * Summary shape (the server's): { photos, videos, notices, report_documents,
 * attachments, has_description, has_other_info }.
 */

const filled = (value) => {
  const text = value == null ? "" : String(value).trim();
  return text !== "" && text !== "0";
};

const kindOf = (item) => String(item?.media_type || "").toLowerCase();

/** The availability summary for one event from files already loaded. */
export function availabilityFromFiles({
  description = "",
  participants = "",
  socialUrl = "",
  media = [],
  documents = [],
} = {}) {
  const photos = media.filter((item) => kindOf(item) === "image").length;
  const videos = media.filter((item) => kindOf(item) === "video").length;
  // A document is a notice unless it was uploaded as a report; attachments
  // are the report documents plus a link for every photo and video.
  const notices = documents.filter((doc) => doc?.category !== "report").length;
  const reportDocuments = documents.length - notices;

  return {
    photos,
    videos,
    notices,
    report_documents: reportDocuments,
    attachments: reportDocuments + media.length,
    has_description: filled(description),
    has_other_info: filled(participants) || filled(socialUrl),
  };
}

/**
 * ReportCustomizationModal's availability props for a summary. With no
 * summary (not known), every prop is null and every section stays offered.
 */
export function reportModalProps(summary) {
  if (!summary) {
    return {
      photoCount: null,
      documentCount: null,
      noticeCount: null,
      attachmentCount: null,
      hasDescription: null,
      hasOtherInfo: null,
    };
  }
  return {
    photoCount: summary.photos,
    documentCount: summary.notices + summary.report_documents,
    noticeCount: summary.notices,
    attachmentCount: summary.attachments,
    hasDescription: summary.has_description,
    hasOtherInfo: summary.has_other_info,
  };
}
