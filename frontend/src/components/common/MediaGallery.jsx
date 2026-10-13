import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconArrowRight,
  IconDownload,
  IconExternalLink,
  IconFilm,
  IconImagePlus,
  IconPlay,
  IconX,
} from "../teacher/icons";

const isVideo = (item) => String(item?.media_type || "").toLowerCase() === "video";

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The photos and videos attached to an event, for the teacher who uploaded
 * them and the Dean reviewing them. Every item is a thumbnail; choosing one
 * opens a full-screen viewer that shows the image at full size or plays the
 * video, and steps through the rest with the arrow buttons, the arrow keys or
 * a swipe.
 *
 * Videos are not played inside the thumbnail grid: a player that small is
 * hard to use and its controls fight with the grid for clicks.
 *
 * `columns` is the Tailwind grid class for the thumbnails, so each page can
 * size the grid to the space it has.
 *
 * Media links are signed and expire. `onLoadError` is called when an image
 * or video fails to load, so the page can fetch fresh links (see
 * useMediaRefresh); the new URLs then re-render the failed items.
 */
export default function MediaGallery({
  items = [],
  title = "Event media",
  columns = "grid-cols-2 sm:grid-cols-3",
  emptyText = "No photos or videos attached.",
  onLoadError,
}) {
  const [openIndex, setOpenIndex] = useState(null);
  const thumbRefs = useRef([]);
  // Mirrors openIndex so `close` can stay stable across navigation.
  const openIndexRef = useRef(null);
  useEffect(() => {
    openIndexRef.current = openIndex;
  }, [openIndex]);

  const close = useCallback(() => {
    const index = openIndexRef.current;
    setOpenIndex(null);
    // Hand focus back to the thumbnail of the item that was on screen.
    if (index != null) requestAnimationFrame(() => thumbRefs.current[index]?.focus());
  }, []);

  if (items.length === 0) {
    return (
      <p className="prose-muted rounded-xl border border-dashed border-line/20 p-6 text-center text-sm">
        {emptyText}
      </p>
    );
  }

  return (
    <>
      <ul className={`grid list-none gap-3 p-0 ${columns}`}>
        {items.map((item, index) => {
          const video = isVideo(item);
          const label = `${video ? "Play video" : "View image"} ${index + 1} of ${items.length}${
            item.file_name ? `: ${item.file_name}` : ""
          }`;

          return (
            <li key={item.id || item.media_url || index}>
              <button
                type="button"
                ref={(node) => {
                  thumbRefs.current[index] = node;
                }}
                onClick={() => setOpenIndex(index)}
                aria-label={label}
                title={item.file_name || undefined}
                className="group relative block aspect-[4/3] w-full overflow-hidden rounded-xl border hairline bg-raised/60 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/25"
              >
                {video ? (
                  <>
                    {/* The fragment asks for the frame at 0.1s, so the tile
                        shows a picture rather than a black box. */}
                    <video
                      src={`${item.media_url}#t=0.1`}
                      preload="metadata"
                      muted
                      playsInline
                      tabIndex={-1}
                      aria-hidden="true"
                      onError={() => onLoadError?.()}
                      className="pointer-events-none h-full w-full bg-black object-cover"
                    />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/25 transition group-hover:bg-black/40">
                      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-ink shadow-lg transition group-hover:scale-110">
                        <IconPlay className="h-6 w-6" />
                      </span>
                    </span>
                  </>
                ) : (
                  <img
                    src={item.media_url}
                    alt=""
                    loading="lazy"
                    onError={() => onLoadError?.()}
                    className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                  />
                )}

                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  {video ? <IconFilm className="h-3 w-3" /> : <IconImagePlus className="h-3 w-3" />}
                  {video ? "Video" : "Image"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {openIndex != null &&
        createPortal(
          <MediaViewer
            items={items}
            index={openIndex}
            onIndex={setOpenIndex}
            onClose={close}
            title={title}
            onLoadError={onLoadError}
          />,
          document.body
        )}
    </>
  );
}

function MediaViewer({ items, index, onIndex, onClose, title, onLoadError }) {
  const item = items[index];
  const video = isVideo(item);
  const count = items.length;
  // The URL that failed to load; moving to another item clears it for free.
  const [failedUrl, setFailedUrl] = useState(null);
  const failed = failedUrl === item.media_url;
  const closeRef = useRef(null);
  const touchStart = useRef(null);

  const go = useCallback(
    (step) => onIndex((current) => (current + step + count) % count),
    [onIndex, count]
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (event) => {
      if (event.key === "Escape") onClose();
      // Left/right would otherwise also scrub a focused video; the viewer
      // owns them so they always mean "previous / next item".
      else if (event.key === "ArrowRight" && count > 1) {
        event.preventDefault();
        go(1);
      } else if (event.key === "ArrowLeft" && count > 1) {
        event.preventDefault();
        go(-1);
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, go, count]);

  const onTouchStart = (event) => {
    touchStart.current = event.touches[0].clientX;
  };
  const onTouchEnd = (event) => {
    if (touchStart.current == null || count < 2) return;
    const dx = event.changedTouches[0].clientX - touchStart.current;
    touchStart.current = null;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
  };

  const meta = [video ? "Video" : "Image", formatSize(item.file_size)].filter(Boolean).join(" · ");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title}: ${video ? "video" : "image"} ${index + 1} of ${count}`}
      className="fixed inset-0 z-[80] flex flex-col bg-black/95 text-white"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* ------------------------------------------------------ top bar */}
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={item.file_name}>
            {item.file_name || title}
          </p>
          <p className="text-xs text-white/60">
            {count > 1 && <span className="num">{index + 1} / {count} · </span>}
            {meta}
          </p>
        </div>

        <a
          href={item.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/20 px-3 text-xs font-semibold transition hover:bg-white/10"
        >
          <IconExternalLink className="h-4 w-4" />
          <span className="hidden sm:inline">Open original</span>
        </a>

        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>

      {/* ---------------------------------------------------------- stage */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-3 sm:px-16"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {failed ? (
          <div className="max-w-sm rounded-2xl border border-white/15 bg-white/5 p-6 text-center">
            <p className="text-sm font-semibold">
              {video ? "This video can't be played in the browser." : "This image couldn't be loaded."}
            </p>
            <p className="mt-1.5 text-xs text-white/60">
              {video
                ? "The file may use a format the browser doesn't support (for example some .mov files), or its link may have expired — reload the page to refresh it."
                : "Its link may have expired — reload the page to refresh it."}
            </p>
            <a
              href={item.media_url}
              download={item.file_name || true}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-black transition hover:bg-white/90"
            >
              <IconDownload className="h-4 w-4" />
              Download file
            </a>
          </div>
        ) : video ? (
          // Keyed on the URL so moving to the next video starts a new player
          // instead of reusing the old one mid-playback.
          <video
            key={item.media_url}
            src={item.media_url}
            controls
            autoPlay
            playsInline
            preload="auto"
            onError={() => {
              setFailedUrl(item.media_url);
              onLoadError?.();
            }}
            className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
          />
        ) : (
          <img
            key={item.media_url}
            src={item.media_url}
            alt={item.file_name || title}
            onError={() => {
              setFailedUrl(item.media_url);
              onLoadError?.();
            }}
            className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
          />
        )}

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous item"
              className="absolute left-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 ring-1 ring-white/20 transition hover:bg-white/15 sm:left-4"
            >
              <IconArrowLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next item"
              className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 ring-1 ring-white/20 transition hover:bg-white/15 sm:right-4"
            >
              <IconArrowRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* ---------------------------------------------------- filmstrip */}
      {count > 1 && (
        <div className="flex justify-center gap-2 overflow-x-auto px-3 pb-3">
          {items.map((entry, i) => (
            <button
              key={entry.id || entry.media_url || i}
              type="button"
              onClick={() => onIndex(i)}
              aria-label={`Show item ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
              className={`relative h-12 w-16 shrink-0 overflow-hidden rounded-md ring-2 transition ${
                i === index ? "ring-white" : "ring-transparent opacity-55 hover:opacity-90"
              }`}
            >
              {isVideo(entry) ? (
                <>
                  <video
                    src={`${entry.media_url}#t=0.1`}
                    preload="metadata"
                    muted
                    playsInline
                    tabIndex={-1}
                    className="pointer-events-none h-full w-full bg-black object-cover"
                  />
                  <IconPlay className="absolute inset-0 m-auto h-5 w-5 text-white" />
                </>
              ) : (
                <img src={entry.media_url} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
