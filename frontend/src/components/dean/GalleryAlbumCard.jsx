import { forwardRef, useState } from "react";

import { IconCamera, IconFilm } from "../teacher/icons";
import { formatDateRange } from "../../utils/dates";

/**
 * One event in the gallery grid: a single cover photo, the event's name and
 * date, and how much media it holds. The cover is the only file a card ever
 * loads -- the event's photos and videos are fetched when its album is
 * opened -- and it is lazy, so a card scrolled out of sight loads nothing.
 *
 * `onPrefetch` fires on hover and focus, so the album's (small) media list
 * is usually already in hand by the time the card is clicked.
 */
const GalleryAlbumCard = forwardRef(function GalleryAlbumCard(
  { group, onOpen, onPrefetch, onCoverError },
  ref,
) {
  const { event, cover, photos, videos } = group;
  const [loadedUrl, setLoadedUrl] = useState(null);
  const [failedUrl, setFailedUrl] = useState(null);

  const coverUrl = cover?.media_url || null;
  const showCover = coverUrl && failedUrl !== coverUrl;
  const name = event.event_name || "Untitled event";
  const submitter = event.teacher_name
    ? `${event.teacher_name} · ${event.submitted_by_role === "event_manager" ? "Event Manager" : "Teacher"}`
    : "";
  const counts = [
    photos > 0 && `${photos} ${photos === 1 ? "photo" : "photos"}`,
    videos > 0 && `${videos} ${videos === 1 ? "video" : "videos"}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(event.id)}
      onMouseEnter={() => onPrefetch?.(event.id)}
      onFocus={() => onPrefetch?.(event.id)}
      aria-label={`Open album: ${name}, ${formatDateRange(event.event_date, event.end_date)}, ${counts}`}
      className="glass group flex h-full w-full flex-col overflow-hidden text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/25"
    >
      <span className="relative block aspect-[4/3] w-full overflow-hidden bg-raised">
        {showCover ? (
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoadedUrl(coverUrl)}
            onError={() => {
              setFailedUrl(coverUrl);
              onCoverError?.();
            }}
            className={`h-full w-full object-cover transition duration-500 group-hover:scale-105 ${
              loadedUrl === coverUrl ? "opacity-100" : "opacity-0"
            }`}
          />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted">
            {videos > 0 && photos === 0 ? (
              <IconFilm className="h-8 w-8" />
            ) : (
              <IconCamera className="h-8 w-8" />
            )}
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              {videos > 0 && photos === 0 ? "Video album" : "No preview"}
            </span>
          </span>
        )}

        {/* A cover still on its way shows a soft pulse, not a blank box. */}
        {showCover && loadedUrl !== coverUrl && (
          <span className="absolute inset-0 animate-pulse bg-line/10" aria-hidden="true" />
        )}

        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/65 to-transparent" />

        <span className="absolute bottom-2 left-2.5 flex items-center gap-2.5 text-xs font-semibold text-white">
          {photos > 0 && (
            <span className="inline-flex items-center gap-1">
              <IconCamera className="h-3.5 w-3.5" />
              <span className="num">{photos}</span>
            </span>
          )}
          {videos > 0 && (
            <span className="inline-flex items-center gap-1">
              <IconFilm className="h-3.5 w-3.5" />
              <span className="num">{videos}</span>
            </span>
          )}
        </span>
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1 p-3 sm:p-3.5">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-ink transition group-hover:text-accent" title={name}>
          {name}
        </span>
        <span className="prose-muted truncate text-xs">
          <span className="num font-medium text-ink">{formatDateRange(event.event_date, event.end_date)}</span>
          {event.event_type && <span> · {event.event_type}</span>}
        </span>
        {submitter && <span className="prose-muted truncate text-xs">{submitter}</span>}
      </span>
    </button>
  );
});

export default GalleryAlbumCard;
