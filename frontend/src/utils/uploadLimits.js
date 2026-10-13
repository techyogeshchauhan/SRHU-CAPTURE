/**
 * The shape of the platform's upload limits, and the fallback values.
 *
 * Deliberately free of imports: the validation helpers and the pick rules build
 * on this, and keeping the HTTP client out of the dependency chain is what lets
 * those pure functions be loaded and tested outside a browser.
 *
 * The server is the source of truth. These constants only cover the moment
 * before its first response, and mirror backend/app/config.py.
 */

/** `null` means "no cap": no combined photo budget, and no video count limit. */
export const DEFAULT_UPLOAD_LIMITS = {
  max_photos_per_event: 10,
  max_photo_size_mb: 20,
  max_photo_total_mb: null,
  max_videos_per_event: null,
  max_video_size_mb: 200,
  max_video_total_mb: 200,
  max_documents_per_event: 50,
  max_documents_total_mb: 15,
  // Whether each kind must have at least one upload before an event can be
  // submitted. Mirrors DEFAULT_UPLOAD_LIMITS in upload_config_service.py.
  photos_required: true,
  videos_required: false,
  documents_required: true,
};

/** Upload kind (as the wizard names it) -> its mandatory-upload switch. */
export const REQUIREMENT_FIELDS = {
  image: "photos_required",
  video: "videos_required",
  document: "documents_required",
};

/** Mirrors LIMIT_BOUNDS in backend/app/schemas/superadmin.py. */
export const DEFAULT_LIMIT_BOUNDS = {
  max_photos_per_event: { min: 1, max: 100, unit: "count" },
  max_photo_size_mb: { min: 1, max: 100, unit: "mb" },
  max_photo_total_mb: { min: 1, max: 1000, unit: "mb", nullable: true },
  max_videos_per_event: { min: 1, max: 50, unit: "count", nullable: true },
  max_video_size_mb: { min: 1, max: 1000, unit: "mb" },
  max_video_total_mb: { min: 1, max: 2000, unit: "mb" },
  max_documents_per_event: { min: 1, max: 200, unit: "count" },
  max_documents_total_mb: { min: 1, max: 500, unit: "mb" },
};

/** The fields where null is a legal value meaning "no cap". */
export const OPTIONAL_LIMIT_FIELDS = ["max_photo_total_mb", "max_videos_per_event"];
