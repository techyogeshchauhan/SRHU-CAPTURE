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
}) {
  const videos = items.filter(isVideo);
  const photos = items.filter((item) => !isVideo(item));

  return (
    <>
      <MediaSection
        id="event-photos"
        Icon={IconImagePlus}
        heading="Photos"
        items={photos}
        title={`${eventName} · Photos`}
        columns={columns}
        onLoadError={onLoadError}
        emptyText="No photos uploaded for this event."
      />
      <MediaSection
        id="event-videos"
        Icon={IconFilm}
        heading="Videos"
        items={videos}
        title={`${eventName} · Videos`}
        columns={columns}
        onLoadError={onLoadError}
        emptyText="No videos uploaded for this event."
      />
    </>
  );
}

function MediaSection({ id, Icon, heading, items, title, columns, emptyText, onLoadError }) {
  return (
    <section className="glass overflow-hidden" aria-labelledby={id}>
      <div className="flex items-center justify-between gap-3 border-b hairline px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="icon-tile h-9 w-9 rounded-lg">
            <Icon className="h-4 w-4" />
          </span>
          <h2 id={id} className="h3 text-base text-ink">
            {heading}
          </h2>
        </div>
        <span className="chip chip-sm chip-solid num" aria-label={`${items.length} ${heading.toLowerCase()}`}>
          {items.length}
        </span>
      </div>

      <div className="p-5">
        <MediaGallery
          items={items}
          title={title}
          columns={columns}
          emptyText={emptyText}
          onLoadError={onLoadError}
        />
      </div>
    </section>
  );
}
