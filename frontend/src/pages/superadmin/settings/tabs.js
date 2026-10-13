import DocumentLimitsTab from "./DocumentLimitsTab";
import UploadLimitsTab from "./UploadLimitsTab";

/**
 * The settings sections, in the order they appear.
 *
 * `fields` is what lets the shell tell which tab owns a validation error, so a
 * failed save can send the admin to the right place. Adding a section is one
 * file plus one entry here.
 */
export const SETTINGS_TABS = [
  {
    key: "uploads",
    label: "Photos & videos",
    Component: UploadLimitsTab,
    fields: [
      "max_photos_per_event",
      "max_photo_size_mb",
      "max_photo_total_mb",
      "max_videos_per_event",
      "max_video_size_mb",
      "max_video_total_mb",
      "photos_required",
      "videos_required",
    ],
  },
  {
    key: "documents",
    label: "Documents",
    Component: DocumentLimitsTab,
    fields: ["max_documents_per_event", "max_documents_total_mb", "documents_required"],
  },
];

export const DEFAULT_TAB = SETTINGS_TABS[0].key;

export function resolveTab(key) {
  return SETTINGS_TABS.find((tab) => tab.key === key) || SETTINGS_TABS[0];
}

/** The first tab carrying one of the given field names. */
export function tabOwningField(field) {
  return SETTINGS_TABS.find((tab) => tab.fields.includes(field)) || SETTINGS_TABS[0];
}
