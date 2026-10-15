import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { apiJson, isAbortError } from "../../services/api";
import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import GalleryAlbumCard from "../../components/dean/GalleryAlbumCard";
import GalleryAlbumDialog from "../../components/dean/GalleryAlbumDialog";
import DateRangeModal from "../../components/common/DateRangeModal";
import Pagination from "../../components/common/Pagination";
import useMediaRefresh from "../../components/common/useMediaRefresh";
import { trackOf } from "../../components/teacher/status";
import useEventTypes from "../../hooks/useEventTypes";
import useTableQuery from "../../hooks/useTableQuery";
import { GALLERY_PERIODS, albumNeighbours, periodOf, periodRange } from "../../utils/galleryAlbums";
import {
  IconAlertTriangle,
  IconCalendar,
  IconFilm,
  IconImagePlus,
  IconLayers,
  IconRefresh,
  IconSearch,
  IconX,
} from "../../components/teacher/icons";

const MEDIA_TABS = [
  { key: "", label: "All media", Icon: IconLayers, count: (t) => t.photos + t.videos },
  { key: "image", label: "Photos", Icon: IconImagePlus, count: (t) => t.photos },
  { key: "video", label: "Videos", Icon: IconFilm, count: (t) => t.videos },
];

const EMPTY_TOTALS = { events: 0, photos: 0, videos: 0 };

// One continuous grid, newest first. Month headings were dropped: with
// paging by event they split a month across pages and spent a row on each
// heading, while each card already shows its date.
const ALBUM_GRID =
  "grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const isTyping = (target) =>
  target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);

/**
 * Every event with photos or videos, as a grid of albums: one card per
 * event. Opening one shows that event's photos and its videos as separate
 * sections, so everything stays organised event by event.
 *
 * Each event is one card with a single, lazily loaded cover; its photos and
 * videos are fetched only when its album is opened, in a dialog that steps
 * on to the neighbouring albums. Opening the gallery therefore costs a page
 * of covers, not every file of every event on the page.
 *
 * The filters are search, program, submitter and date range, plus the kind
 * of media. No event status is shown or filtered on: the gallery is the
 * events' photos and videos, nothing more. They live in the URL, as does the
 * open album (`?album=<id>`), so a filtered gallery or a single album can be
 * bookmarked or sent on, and the back button closes an album.
 */
export default function Gallery() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { query, setFilter, setFilters, setPage, setPerPage, reset } = useTableQuery();
  const { types: eventTypes } = useEventTypes();

  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState(EMPTY_TOTALS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deanProfile, setDeanProfile] = useState(null);
  const [showDateRangeModal, setShowDateRangeModal] = useState(false);

  // The search box is uncontrolled by the URL while typing (see All Events).
  const [searchDraft, setSearchDraft] = useState(query.q);

  const controllerRef = useRef(null);
  const searchRef = useRef(null);
  const cardRefs = useRef(new Map());
  // Each album's media list, by event id, as a promise: hovering a card starts
  // the request, and opening the album -- or coming back to it -- reuses it.
  const albumCache = useRef(new Map());

  const albumId = searchParams.get("album") || "";

  // ============================================================
  // LOAD
  // ============================================================

  const loadGallery = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const params = new URLSearchParams({
      skip: String(query.skip),
      limit: String(query.per),
    });
    if (query.q) params.set("q", query.q);
    if (query.type) params.set("event_type", query.type);
    if (query.source) params.set("source", query.source);
    if (query.startDate) params.set("start_date", query.startDate);
    if (query.endDate) params.set("end_date", query.endDate);
    if (query.media) params.set("media_type", query.media);

    try {
      setLoading(true);
      setError("");
      const data = await apiJson(`/dean/gallery?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // Fresh cover links mean the cached album links may be stale too.
      albumCache.current.clear();
      setGroups(data?.groups || []);
      setTotal(data?.total || 0);
      setTotals(data?.totals || EMPTY_TOTALS);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      console.error("Load gallery error:", err);
      if (err?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      setError(err?.message || "The gallery could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [
    query.skip,
    query.per,
    query.q,
    query.type,
    query.source,
    query.startDate,
    query.endDate,
    query.media,
    navigate,
  ]);

  useEffect(() => {
    loadGallery();
    return () => controllerRef.current?.abort();
  }, [loadGallery]);

  useEffect(() => {
    let mounted = true;
    fetchCurrentUser()
      .then((data) => {
        // Non-blocking: the shell falls back to a neutral initial.
        if (mounted && data) setDeanProfile(data);
      })
      .catch((err) => console.error("Load dean profile error:", err));
    return () => {
      mounted = false;
    };
  }, []);

  // Debounced so typing does not fire a request per character; `replace`
  // keeps the back button useful instead of one entry per keystroke.
  useEffect(() => {
    if (searchDraft === query.q) return undefined;
    const timer = setTimeout(() => setFilter("q", searchDraft, { replace: true }), 350);
    return () => clearTimeout(timer);
  }, [searchDraft, query.q, setFilter]);

  // "/" jumps to the search box from anywhere on the page, as on most sites
  // with a search -- the quickest way to an event among hundreds.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || albumId || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [albumId]);

  // Signed links expire; a cover that fails to load refetches the page.
  const refreshCovers = useMediaRefresh(loadGallery);

  // ============================================================
  // ALBUMS
  // ============================================================

  const loadAlbumMedia = useCallback((id, { fresh = false } = {}) => {
    const cache = albumCache.current;
    if (fresh) cache.delete(id);
    if (!cache.has(id)) {
      const request = apiJson(`/dean/events/${id}/media`).then((data) => data?.media || []);
      // A failed request is not kept, so the next attempt asks again.
      request.catch(() => {
        if (cache.get(id) === request) cache.delete(id);
      });
      cache.set(id, request);
    }
    return cache.get(id);
  }, []);

  const prefetchAlbum = useCallback(
    (id) => {
      loadAlbumMedia(id).catch(() => {});
    },
    [loadAlbumMedia],
  );

  const withAlbum = useCallback(
    (id) => {
      const next = new URLSearchParams(searchParams);
      if (id) next.set("album", id);
      else next.delete("album");
      return next;
    },
    [searchParams],
  );

  const openAlbum = useCallback(
    (id) => setSearchParams(withAlbum(id), { state: { albumFromGrid: true } }),
    [setSearchParams, withAlbum],
  );

  // Stepping replaces the entry, so one Back still closes the album.
  const stepAlbum = useCallback(
    (id) => setSearchParams(withAlbum(id), { replace: true, state: location.state }),
    [setSearchParams, withAlbum, location.state],
  );

  // Opened from a card: go back, so Back afterwards does not reopen it.
  // Opened from a link: there is nothing to go back to, so drop the param.
  const closeAlbum = useCallback(() => {
    if (location.state?.albumFromGrid) navigate(-1);
    else setSearchParams(withAlbum(""), { replace: true });
  }, [location.state, navigate, setSearchParams, withAlbum]);

  // Focus returns to the card of the album that was open.
  const lastAlbumRef = useRef("");
  useEffect(() => {
    if (albumId) {
      lastAlbumRef.current = albumId;
      return;
    }
    const last = lastAlbumRef.current;
    lastAlbumRef.current = "";
    if (last) requestAnimationFrame(() => cardRefs.current.get(last)?.focus({ preventScroll: false }));
  }, [albumId]);

  const albumIds = useMemo(() => groups.map((group) => group.event.id), [groups]);
  const { index: albumIndex, prev: prevAlbum, next: nextAlbum } = albumNeighbours(albumIds, albumId);
  const openGroup = albumIndex >= 0 ? groups[albumIndex] : null;
  const period = periodOf(query.startDate, query.endDate);

  // ============================================================
  // FILTERS
  // ============================================================

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const filtersActive = Boolean(
    query.q ||
      query.type ||
      query.source ||
      query.startDate ||
      query.endDate ||
      query.media,
  );

  const clearFilters = () => {
    setSearchDraft("");
    reset();
  };

  const rangeLabel =
    period !== "custom"
      ? "Custom range"
      : query.startDate && query.endDate
        ? `${query.startDate} – ${query.endDate}`
        : query.startDate
          ? `From ${query.startDate}`
          : `Until ${query.endDate}`;

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <DeanShell active="gallery" profile={deanProfile} onLogout={handleLogout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero
          compact
          toolbar
          title="Event"
          accent="Gallery"
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2.5">
                  {/* Search */}
                  <div className="relative min-w-0 flex-1 basis-56 sm:w-72 sm:flex-none xl:w-80">
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
                      <IconSearch className="h-4 w-4" />
                    </span>
                    <input
                      ref={searchRef}
                      type="text"
                      value={searchDraft}
                      onChange={(e) => setSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && searchDraft) {
                          e.preventDefault();
                          setSearchDraft("");
                        }
                      }}
                      placeholder="Search events, venues, teachers…"
                      aria-label="Search events by name, venue, type or teacher"
                      aria-keyshortcuts="/"
                      className="input pl-10 pr-9"
                    />
                    {searchDraft ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchDraft("");
                          searchRef.current?.focus();
                        }}
                        aria-label="Clear search"
                        className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted transition hover:text-ink"
                      >
                        <IconX className="h-4 w-4" />
                      </button>
                    ) : (
                      <kbd
                        className="pointer-events-none absolute inset-y-0 right-2.5 my-auto hidden h-5 items-center rounded-md border hairline px-1.5 text-[10px] font-semibold text-muted sm:flex"
                        aria-hidden="true"
                      >
                        /
                      </kbd>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={loadGallery}
                    disabled={loading}
                    className="btn btn-ghost btn-sm shrink-0"
                  >
                    {loading ? <span className="spin h-4 w-4" /> : <IconRefresh />}
                    <span className="hidden sm:inline">Refresh</span>
                  </button>
            </div>
          }
        />

        {/* ================================================
            FILTERS
            Program, submitter and period, then the kind of media with the
            totals. Search, the view and Refresh sit in the header.
        ================================================ */}
        <div className="glass mt-4 overflow-hidden">

          <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 sm:px-5">
            <select
              value={query.type}
              onChange={(e) => setFilter("type", e.target.value)}
              aria-label="Filter by program type"
              className="input min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none sm:basis-auto"
            >
              <option value="">All programs</option>
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>

            <select
              value={query.source}
              onChange={(e) => setFilter("source", e.target.value)}
              aria-label="Filter by who submitted the event"
              className="input min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none sm:basis-auto"
            >
              <option value="">All submitters</option>
              <option value="teacher">Teachers</option>
              <option value="event_manager">Event Managers</option>
            </select>

            {/* One click for the usual periods; the dialog for anything else. */}
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Period">
              {GALLERY_PERIODS.map((option) => (
                <button
                  key={option.key || "all"}
                  type="button"
                  role="tab"
                  aria-selected={period === option.key}
                  onClick={() => setFilters({ ...periodRange(option.key), date: "" })}
                  className="tab"
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowDateRangeModal(true)}
              className={`btn btn-sm shrink-0 ${period === "custom" ? "btn-primary font-medium" : "btn-ghost"}`}
              title="Filter by event date range"
            >
              <IconCalendar />
              <span>{rangeLabel}</span>
            </button>

            {filtersActive && (
              <button type="button" onClick={clearFilters} className="btn btn-ghost btn-sm shrink-0">
                <IconX />
                Clear filters
              </button>
            )}
          </div>

          {/* Kind of media, and the totals */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t hairline px-4 py-2.5 sm:px-5">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Kind of media">
              {MEDIA_TABS.map((tab) => (
                <button
                  key={tab.key || "all"}
                  type="button"
                  role="tab"
                  aria-selected={query.media === tab.key}
                  onClick={() => setFilter("media", tab.key)}
                  className="tab"
                >
                  <tab.Icon className="h-4 w-4" />
                  {tab.label}
                  {/* Counts under the current filters; only exact for the
                      kind on show, so the others are left blank. */}
                  {(query.media === "" || query.media === tab.key) && (
                    <span className="tab-count">{tab.count(totals)}</span>
                  )}
                </button>
              ))}
            </div>
            <p className="prose-muted text-xs" aria-live="polite">
              {loading && groups.length === 0
                ? "Loading albums…"
                : `${plural(totals.events, "album", "albums")} · ${plural(
                    totals.photos,
                    "photo",
                    "photos",
                  )} · ${plural(totals.videos, "video", "videos")}`}
            </p>
          </div>
        </div>

        {error && (
          <div
            className="mt-5 flex items-start gap-3 rounded-2xl border p-4"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm text-ink">{error}</p>
            <button type="button" onClick={loadGallery} className="btn btn-ghost btn-xs shrink-0">
              Retry
            </button>
          </div>
        )}

        {/* ================================================
            THE ALBUMS
        ================================================ */}
        {loading && groups.length === 0 ? (
          <ul className={`${ALBUM_GRID} mt-6`} aria-label="Loading albums">
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="glass overflow-hidden">
                <div className="aspect-[4/3] animate-pulse bg-line/10" />
                <div className="space-y-2 p-3.5">
                  <div className="h-3.5 w-4/5 animate-pulse rounded bg-line/10" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-line/10" />
                </div>
              </li>
            ))}
          </ul>
        ) : groups.length === 0 && !error ? (
          <div className="glass mt-5 flex flex-col items-center px-6 py-14 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconImagePlus className="h-6 w-6" />
            </span>
            <p className="h3 text-ink">
              {filtersActive ? "No albums match these filters" : "No photos or videos yet"}
            </p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              {filtersActive
                ? "Try another search or a wider date range, or clear the filters."
                : "Once teachers and Event Managers upload media to their events, each event appears here as an album."}
            </p>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="btn btn-ghost btn-sm mt-5">
                <IconX />
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className={`mt-6 space-y-5 transition-opacity ${loading ? "opacity-60" : ""}`}>
            <ul className={ALBUM_GRID}>
              {groups.map((group) => (
                <li key={group.event.id}>
                  <GalleryAlbumCard
                    ref={(node) => {
                      if (node) cardRefs.current.set(group.event.id, node);
                      else cardRefs.current.delete(group.event.id);
                    }}
                    group={group}
                    onOpen={openAlbum}
                    onPrefetch={prefetchAlbum}
                    onCoverError={refreshCovers}
                  />
                </li>
              ))}
            </ul>

            {total > 0 && (
              <div className="glass overflow-hidden">
                <Pagination
                  page={query.page}
                  perPage={query.per}
                  total={total}
                  onPageChange={(page) => {
                    setPage(page);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  onPerPageChange={setPerPage}
                  disabled={loading}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {albumId && (
        <GalleryAlbumDialog
          eventId={albumId}
          event={openGroup?.event || null}
          kind={query.media}
          position={albumIndex >= 0 ? { index: albumIndex, total: groups.length } : null}
          onPrev={prevAlbum ? () => stepAlbum(prevAlbum) : null}
          onNext={nextAlbum ? () => stepAlbum(nextAlbum) : null}
          onClose={closeAlbum}
          loadMedia={loadAlbumMedia}
        />
      )}

      <DateRangeModal
        open={showDateRangeModal}
        onClose={() => setShowDateRangeModal(false)}
        startDate={query.startDate}
        endDate={query.endDate}
        onApply={({ startDate, endDate }) => setFilters({ startDate, endDate, date: "" })}
        onClear={() => setFilters({ startDate: "", endDate: "" })}
      />
    </DeanShell>
  );
}
