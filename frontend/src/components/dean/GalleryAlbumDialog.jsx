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
  const [activeKind, setActiveKind] = useState(kind || "");
  const closeRef = useRef(null);
  const bodyRef = useRef(null);

  const event = knownEvent || (fetchedEvent?.id === eventId ? fetchedEvent : null);

  useEffect(() => {
    setActiveKind(kind || "");
  }, [kind, eventId]);

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
      const targetDialog = e.target?.closest?.('[role="dialog"]');
      const albumDialog = closeRef.current?.closest('[role="dialog"]');
      if (targetDialog && targetDialog !== albumDialog) return;
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
  const allItems = ready ? media.items : [];
  const photoCount = allItems.filter((item) => !isVideo(item)).length;
  const videoCount = allItems.filter(isVideo).length;
  const items = ready
    ? allItems.filter((item) => !activeKind || (activeKind === "video" ? isVideo(item) : !isVideo(item)))
    : [];
  const name = event?.event_name || (event ? "Untitled event" : "Album");
  const meta = event ? [event.event_type, event.location].filter(Boolean).join(" · ") : "";
  const submitter = event?.teacher_name
    ? `${event.teacher_name} (${event.submitted_by_role === "event_manager" ? "Event Manager" : "Teacher"})`
    : "";

  return createPortal(
    <div
      className="hv-backdrop !items-center !justify-center p-2 sm:p-5 md:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-title"
        className="modal-panel modal-panel-xl album-panel flex flex-col overflow-hidden shadow-2xl bg-surface border hairline"
      >
        {/* ------------------------------------------------------ header */}
        <div className="border-b hairline px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="eyebrow">
                  Album
                  {position && position.index >= 0 && (
                    <span className="num"> {position.index + 1} of {position.total}</span>
                  )}
                </p>
                {ready && (
                  <span className="text-xs text-muted">
                    · {photoCount} photo{photoCount !== 1 ? "s" : ""}, {videoCount} video{videoCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <h2 id="album-title" className="h3 mt-1 line-clamp-2 text-ink text-lg sm:text-xl font-bold" title={name}>
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

          {/* Quick filter tabs when both photos and videos are available */}
          {ready && allItems.length > 0 && photoCount > 0 && videoCount > 0 && (
            <div className="mt-3 flex items-center gap-1.5 pt-2 border-t hairline/50">
              <button
                type="button"
                onClick={() => setActiveKind("")}
                className={`chip chip-sm cursor-pointer transition ${
                  !activeKind ? "chip-brand font-semibold" : "chip-outline hover:bg-raised"
                }`}
              >
                All ({allItems.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveKind("image")}
                className={`chip chip-sm cursor-pointer transition ${
                  activeKind === "image" ? "chip-brand font-semibold" : "chip-outline hover:bg-raised"
                }`}
              >
                Photos ({photoCount})
              </button>
              <button
                type="button"
                onClick={() => setActiveKind("video")}
                className={`chip chip-sm cursor-pointer transition ${
                  activeKind === "video" ? "chip-brand font-semibold" : "chip-outline hover:bg-raised"
                }`}
              >
                Videos ({videoCount})
              </button>
            </div>
          )}
        </div>

        {/* -------------------------------------------------------- body */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {activeKind && ready && !error && (
            <p className="prose-muted mb-3 text-xs">
              {KIND_NOTE[activeKind]} · {items.length} of {allItems.length} in this album
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
              className="grid list-none grid-cols-2 gap-3 sm:gap-4 p-0 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
              aria-label="Loading the album"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <li key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-line/10" />
              ))}
            </ul>
          ) : (
            items.length === 0 ? (
              <MediaGallery
                items={items}
                title={name}
                emptyText={
                  activeKind
                    ? `Nothing of this kind in this album.`
                    : "This album is empty."
                }
              />
            ) : (
              // Photos and videos apart, each with its own count and viewer.
              <div className="space-y-5">
                <EventMediaSections
                  items={items}
                  eventName={name}
                  columns="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
                  onLoadError={refreshLinks}
                  hideEmptySections={true}
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
