import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { apiJson, isAbortError } from "../../services/api";
import EventMediaSections from "../common/EventMediaSections";
import MediaGallery from "../common/MediaGallery";
import useMediaRefresh from "../common/useMediaRefresh";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconX,
} from "../teacher/icons";
import { formatDateRange } from "../../utils/dates";

const isVideo = (item) => String(item?.media_type || "").toLowerCase() === "video";

const KIND_NOTE = { image: "Showing photos only", video: "Showing videos only" };

/**
 * One event's photos and videos, opened from its card in the gallery.
 *
 * The media is read only now, through `loadMedia(id, { fresh })`, which the
 * gallery backs with a cache so stepping back to an album is instant. ← and
 * → step to the neighbouring album; inside the full-screen viewer they step
 * through photos instead (the viewer claims them first, see MediaGallery).
 *
 * `event` is the card's copy of the event. A link opened straight onto an
 * album that is not on the current page has none, so the event is read too.
 */
export default function GalleryAlbumDialog({
  eventId,
  event: knownEvent,
  kind = "",
  position,
  onPrev,
  onNext,
  onClose,
  loadMedia,
}) {
  const [media, setMedia] = useState(null);
  const [error, setError] = useState("");
  const [fetchedEvent, setFetchedEvent] = useState(null);
  const closeRef = useRef(null);
  const bodyRef = useRef(null);

  const event = knownEvent || (fetchedEvent?.id === eventId ? fetchedEvent : null);

  // The album on screen. Stepping quickly through albums leaves earlier
  // requests in flight; only the answer for this one may land.
  const currentIdRef = useRef(eventId);
  useLayoutEffect(() => {
    currentIdRef.current = eventId;
  }, [eventId]);

  const load = useCallback(
    async ({ fresh = false } = {}) => {
      setError("");
      try {
        const items = await loadMedia(eventId, { fresh });
        if (currentIdRef.current === eventId) setMedia({ eventId, items });
      } catch (err) {
        if (isAbortError(err) || currentIdRef.current !== eventId) return;
        setMedia({ eventId, items: [] });
        setError(err?.message || "This album could not be loaded.");
      }
    },
    [eventId, loadMedia],
  );

  useEffect(() => {
    load();
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [load]);

  useEffect(() => {
    if (knownEvent) return undefined;
    const controller = new AbortController();
    apiJson(`/dean/events/${eventId}`, { signal: controller.signal })
      .then((data) => setFetchedEvent(data?.event || null))
      .catch((err) => {
        if (!isAbortError(err)) console.error("Load album event error:", err);
      });
    return () => controller.abort();
  }, [eventId, knownEvent]);

  // Signed links expire; a thumbnail that fails refetches this album only.
  const refreshLinks = useMediaRefresh(() => load({ fresh: true }));

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // Already handled by the full-screen viewer on top of the album.
      if (e.defaultPrevented) return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "VIDEO") return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  const ready = media?.eventId === eventId;
  const items = ready
    ? media.items.filter((item) => !kind || (kind === "video" ? isVideo(item) : !isVideo(item)))
    : [];
  const name = event?.event_name || (event ? "Untitled event" : "Album");
  const meta = event ? [event.event_type, event.location].filter(Boolean).join(" · ") : "";
  const submitter = event?.teacher_name
    ? `${event.teacher_name} (${event.submitted_by_role === "event_manager" ? "Event Manager" : "Teacher"})`
    : "";

  return createPortal(
    <div
      className="hv-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-title"
        className="modal-panel modal-panel-xl album-panel"
      >
        {/* ------------------------------------------------------ header */}
        <div className="flex items-start gap-3 border-b hairline px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">
              Album
              {position && position.index >= 0 && (
                <span className="num"> {position.index + 1} of {position.total}</span>
              )}
            </p>
            <h2 id="album-title" className="h3 mt-1 line-clamp-2 text-ink" title={name}>
              {name}
            </h2>
            {event && (
              <div className="prose-muted mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="num font-medium text-ink">
                  {formatDateRange(event.event_date, event.end_date)}
                </span>
                {meta && <span>· {meta}</span>}
                {submitter && <span>· {submitter}</span>}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onPrev}
              disabled={!onPrev}
              aria-label="Previous album"
              title="Previous album (←)"
              className="icon-btn icon-btn-sm disabled:opacity-35"
            >
              <IconArrowLeft />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              aria-label="Next album"
              title="Next album (→)"
              className="icon-btn icon-btn-sm disabled:opacity-35"
            >
              <IconArrowRight />
            </button>
            <Link
              to={`/dean/events/${eventId}`}
              className="btn btn-ghost btn-sm hidden sm:inline-flex"
              title="Open the event's page"
            >
              <IconExternalLink />
              Open event
            </Link>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close album"
              className="icon-btn icon-btn-sm"
            >
              <IconX />
            </button>
          </div>
        </div>

        {/* -------------------------------------------------------- body */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {kind && ready && !error && (
            <p className="prose-muted mb-3 text-xs">
              {KIND_NOTE[kind]} · {items.length} of {media.items.length} in this album
            </p>
          )}

          {error ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center" role="alert">
              <IconAlertTriangle className="h-6 w-6 text-err" />
              <p className="text-sm text-ink">{error}</p>
              <button type="button" onClick={() => load({ fresh: true })} className="btn btn-ghost btn-sm">
                Retry
              </button>
            </div>
          ) : !ready ? (
            <ul
              className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
              aria-label="Loading the album"
            >
              {Array.from({ length: 10 }, (_, i) => (
                <li key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-line/10" />
              ))}
            </ul>
          ) : (
            items.length === 0 ? (
              <MediaGallery
                items={items}
                title={name}
                emptyText={kind ? "Nothing of this kind in this album." : "This album is empty."}
              />
            ) : (
              // Photos and videos apart, each with its own count and viewer.
              <div className="space-y-4">
                <EventMediaSections
                  items={items}
                  eventName={name}
                  columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                  onLoadError={refreshLinks}
                  hideEmpty
                />
              </div>
            )
          )}

          <Link
            to={`/dean/events/${eventId}`}
            className="btn btn-ghost btn-sm mt-4 w-full sm:hidden"
          >
            <IconExternalLink />
            Open event
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
