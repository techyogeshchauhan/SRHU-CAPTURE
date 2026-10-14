import MediaGallery from "./MediaGallery";
import { IconFilm, IconImagePlus } from "../teacher/icons";

const isVideo = (item) => String(item?.media_type || "").toLowerCase() === "video";

/**
 * An event's uploads as two dedicated cards, Photos and Videos, used by the
 * teacher, Dean and superadmin event pages alike.
 *
 * They used to share one grid in upload order, so once a handful of photos
 * were in, the videos sat below the fold of a height-capped scroll box and
 * looked missing. Each card now shows every item of its own kind, with its
 * own count, and its viewer steps through that kind only.
 */
export default function EventMediaSections({
  items = [],
  eventName = "Event",
  columns = "grid-cols-2 sm:grid-cols-3",
  onLoadError,
  reportPhotoSelection,
  hideEmptySections = false,
}) {
  const videos = items.filter(isVideo);
  const photos = items.filter((item) => !isVideo(item));

  return (
    <>
      {(!hideEmptySections || photos.length > 0) && <MediaSection
        id="event-photos"
        Icon={IconImagePlus}
        heading="Photos"
        items={photos}
        title={`${eventName} · Photos`}
        columns={columns}
        onLoadError={onLoadError}
        emptyText="No photos uploaded for this event."
        photoSelection={reportPhotoSelection}
      />}
      {(!hideEmptySections || videos.length > 0) && <MediaSection
        id="event-videos"
        Icon={IconFilm}
        heading="Videos"
        items={videos}
        title={`${eventName} · Videos`}
        columns={columns}
        onLoadError={onLoadError}
        emptyText="No videos uploaded for this event."
      />}
    </>
  );
}

function MediaSection({ id, Icon, heading, items, title, columns, emptyText, onLoadError, photoSelection }) {
  return (
    <section className="glass overflow-hidden" aria-labelledby={id}>
      <div
        className={`${photoSelection ? "flex flex-wrap" : "flex"} items-center justify-between gap-3 border-b hairline px-6 py-4`}
      >
        <div className="flex items-center gap-2.5">
          <span className="icon-tile h-9 w-9 rounded-lg">
            <Icon className="h-4 w-4" />
          </span>
          <h2 id={id} className="h3 text-base text-ink">
            {heading}
          </h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {photoSelection && (
            <>
              <span className="text-xs text-muted">
                {photoSelection.selectedCount} of {items.length} in report
              </span>
              {photoSelection.changed && (
                <button
                  type="button"
                  onClick={photoSelection.onSave}
                  disabled={photoSelection.saving}
                  className="btn btn-brand btn-xs"
                >
                  {photoSelection.saving ? <span className="spin h-3 w-3" /> : "Save"}
                  {photoSelection.saving ? "Saving" : "report photos"}
                </button>
              )}
            </>
          )}
          <span className="chip chip-sm chip-solid num" aria-label={`${items.length} ${heading.toLowerCase()}`}>
            {items.length}
          </span>
        </div>
      </div>

      <div className={photoSelection ? "p-4" : "p-5"}>
        {photoSelection && <p className="mb-3 text-xs text-muted">Choose which photos to include in the report.</p>}
        <MediaGallery
          items={items}
          title={title}
          columns={columns}
          emptyText={emptyText}
          onLoadError={onLoadError}
          photoSelection={photoSelection}
        />
      </div>
    </section>
  );
}
