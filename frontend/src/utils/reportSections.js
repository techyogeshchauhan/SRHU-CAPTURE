import { readEventFields } from "./eventFields";

export const REPORT_SECTION_KEYS = [
  "include_basic_details", "include_schedule_venue", "include_description",
  "include_other_info", "include_photos", "include_notices", "include_reports",
];

export const reportSectionOptions = (selected = true) =>
  Object.fromEntries(REPORT_SECTION_KEYS.map((key) => [key, selected]));

const present = (value) => value != null && String(value).trim() !== "";

/** Availability uses saved event data, never display placeholders. For a
 * consolidated report a section is selectable when any event supplies it. */
export function reportSectionAvailability(entries, options = reportSectionOptions()) {
  const available = reportSectionOptions(false);
  const counts = { photos: 0, notices: 0, attachments: 0 };
  let photoLinks = 0;
  for (const { event, media = [], documents = [] } of entries) {
    const fields = readEventFields(event);
    available.include_basic_details ||= [event.event_name, event.event_type, fields.organizer, fields.contactInfo].some(present);
    available.include_schedule_venue ||= [event.event_date, event.end_date, fields.startTime, fields.endTime, event.location].some(present);
    available.include_description ||= present(fields.description);
    available.include_other_info ||= [fields.expectedParticipants, event.social_network_url].some(present);
    const photos = media.filter((item) => item.media_type === "image");
    // An explicit empty photo choice means no photographs go into the PDF.
    const chosen = event.report_photo_ids;
    counts.photos += Array.isArray(chosen)
      ? photos.filter((photo) => chosen.includes(photo.id)).length
      : Math.min(photos.length, 4);
    counts.notices += documents.filter((item) => item.category !== "report").length;
    counts.attachments += documents.filter((item) => item.category === "report").length
      + media.filter((item) => item.media_type !== "image").length;
    photoLinks += photos.length;
  }
  if (options.include_photos && counts.photos > 0) counts.attachments += photoLinks;
  available.include_photos = counts.photos > 0;
  available.include_notices = counts.notices > 0;
  available.include_reports = counts.attachments > 0;
  return { available, counts };
}

export function availableReportOptions(options, available) {
  const selected = Object.fromEntries(REPORT_SECTION_KEYS.map((key) => [key, Boolean(options[key] && available[key])]));
  return { ...selected, include_documents: selected.include_notices || selected.include_reports };
}
