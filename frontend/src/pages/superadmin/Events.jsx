import { useCallback, useEffect, useState } from "react";
import { submitterOf } from "../../components/common/submitter";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, apiJson, isAbortError } from "../../services/api";
import useLatestRead from "../../hooks/useLatestRead";
import { useAuth } from "../../context/AuthContext";
import SuperAdminShell from "../../components/superadmin/SuperAdminShell";
import PageHero from "../../components/teacher/PageHero";
import StatusChip from "../../components/teacher/StatusChip";
import Pagination from "../../components/common/Pagination";
import Modal from "../../components/teacher/Modal";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheckCircle,
  IconInbox,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "../../components/teacher/icons";

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

const formatDay = (value) => {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * Every submitted event, read-only, so the superadmin can open any event and
 * see its photos, videos and documents. Decisions stay with the Deans.
 */
export default function SuperAdminEvents() {
  const beginRead = useLatestRead();
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Deleting an event: { event, confirmText } while the dialog is open.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [success, setSuccess] = useState("");

  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const rawPer = Number(searchParams.get("per")) || 25;
  const per = [25, 50, 100].includes(rawPer) ? rawPer : 25;
  const skip = (page - 1) * per;

  const urlQ = searchParams.get("q") || "";
  const [searchDraft, setSearchDraft] = useState(urlQ);

  // Sync draft when URL q changes (e.g. back button, clear filters)
  useEffect(() => {
    setSearchDraft(urlQ);
  }, [urlQ]);

  // Debounce searchDraft -> URL query string, resetting to page 1
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed !== urlQ) {
        const next = new URLSearchParams(searchParams);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        next.delete("page");
        setSearchParams(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, urlQ, searchParams, setSearchParams]);

  const statusFilter = STATUS_TABS.some((t) => t.key === searchParams.get("status"))
    ? searchParams.get("status")
    : "all";

  const setStatusFilter = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key === "all") next.delete("status");
    else next.set("status", key);
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const setPage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage > 1) next.set("page", String(nextPage));
    else next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const setPerPage = (nextPer) => {
    const next = new URLSearchParams(searchParams);
    if (nextPer !== 25) next.set("per", String(nextPer));
    else next.delete("per");
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const loadEvents = useCallback(async () => {
    const controller = beginRead();
    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams({
        skip: String(skip),
        limit: String(per),
      });
      if (statusFilter !== "all") {
        params.set("status_bucket", statusFilter);
      }
      if (urlQ) {
        params.set("q", urlQ);
      }

      // Each event carries its teacher's name; the page used to download every
      // account to look them up -- and storing that list re-ran this load.
      const eventData = await apiJson(`/dean/events?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;

      setEvents(eventData?.events || []);
      setTotal(eventData?.total || 0);
      if (eventData?.counts) {
        setCounts(eventData.counts);
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      if (err?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      console.error("Load events error:", err);
      setError(err.message || "Failed to load events");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [skip, per, statusFilter, urlQ, navigate, beginRead]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const confirmDelete = async () => {
    const event = pendingDelete?.event;
    if (!event) return;
    try {
      setDeleting(true);
      setError("");
      setSuccess("");
      const data = await apiJson(`/superadmin/events/${event.id}`, { method: "DELETE" });
      setPendingDelete(null);
      setSuccess(data?.message || "Event deleted permanently.");
      // Deleting the last row of the last page steps back a page rather than
      // leaving an empty table that reads as "no matches".
      if (events.length === 1 && page > 1) setPage(page - 1);
      else await loadEvents();
    } catch (err) {
      setPendingDelete(null);
      setError(err?.message || "Failed to delete the event.");
    } finally {
      setDeleting(false);
    }
  };

  const [exporting, setExporting] = useState(false);

  const handleExportCsv = async () => {
    try {
      setExporting(true);
      setError("");
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (urlQ) params.set("q", urlQ);

      const res = await apiFetch(`/superadmin/events/export?${params}`);
      if (!res.ok) throw new Error("Failed to export events");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `events_naac_nirf_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error("Export CSV error:", err);
      setError("Failed to export accreditation CSV.");
    } finally {
      setExporting(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const visibleEvents = events;

  return (
    <SuperAdminShell
      active="events"
      profile={profile}
      onLogout={handleLogout}
      railNote="Read-only: open any event to see its photos, videos and documents. Deans make the decisions."
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">
        <PageHero
          eyebrow="Super Admin"
          title="All"
          accent="Events"
          subtitle="Every event submitted across campus, with the photos, videos and documents attached to it."
          actions={
            <div className="flex w-full flex-wrap items-center gap-2 sm:gap-3 lg:justify-end">
              <button type="button" onClick={loadEvents} disabled={loading} className="btn btn-ghost">
                {loading ? <span className="spin h-4 w-4" /> : <IconRefresh />}
                Refresh
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={exporting}
                className="btn btn-primary"
                title="Download full CSV dump for NAAC/NIRF accreditation"
              >
                {exporting ? <span className="spin h-4 w-4" /> : null}
                Export (NAAC / NIRF)
              </button>
            </div>
          }
        />

        {error && (
          <div className="toast toast-err mt-6" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="flex-1 text-sm font-medium text-ink">{error}</p>
            <button
              type="button"
              onClick={() => setError("")}
              className="icon-btn icon-btn-sm -my-1 -mr-1 border-0 bg-transparent"
              aria-label="Dismiss"
            >
              <IconX />
            </button>
          </div>
        )}

        {success && (
          <div className="toast toast-ok mt-6" role="status">
            <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
            <p className="flex-1 text-sm font-medium text-ink">{success}</p>
            <button
              type="button"
              onClick={() => setSuccess("")}
              className="icon-btn icon-btn-sm -my-1 -mr-1 border-0 bg-transparent"
              aria-label="Dismiss"
            >
              <IconX />
            </button>
          </div>
        )}

        <div className="reveal mt-7 flex flex-col gap-3 md:flex-row md:items-center md:justify-between" style={{ "--i": 1 }}>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.key}
                onClick={() => setStatusFilter(tab.key)}
                className="tab"
              >
                {tab.key !== "all" && <span className="dot dot-sm" style={{ "--track": trackOf(tab.key) }} />}
                {tab.label}
                <span className="tab-count">{counts[tab.key]}</span>
              </button>
            ))}
          </div>

          <label className="relative block w-full md:w-72">
            <span className="sr-only">Search events</span>
            <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search event, venue, type or teacher"
              className="input pl-10"
            />
          </label>
        </div>

        <section className="glass reveal mt-4 overflow-hidden" style={{ "--i": 2 }}>
          {loading ? (
            <div className="px-6 py-16 text-center">
              <span className="spin mx-auto mb-4 block h-9 w-9 text-accent" />
              <p className="prose-muted text-sm">Loading events…</p>
            </div>
          ) : visibleEvents.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <span className="icon-tile mx-auto">
                <IconInbox />
              </span>
              <p className="h3 mt-4 text-ink">
                {total === 0 && !urlQ && statusFilter === "all" ? "No events yet" : "No matches"}
              </p>
              <p className="prose-muted mt-1 text-sm">
                {total === 0 && !urlQ && statusFilter === "all"
                  ? "Nothing has been submitted for review."
                  : "Try a different search or clear the status filter."}
              </p>
              {(urlQ || statusFilter !== "all") && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft("");
                    const next = new URLSearchParams(searchParams);
                    next.delete("q");
                    next.delete("status");
                    next.delete("page");
                    setSearchParams(next, { replace: true });
                  }}
                  className="btn btn-ghost btn-sm mt-5"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-line/10">
              {visibleEvents.map((event) => (
                <li key={event.id} className="flex items-center gap-2 pr-4 transition hover:bg-raised/50">
                  <Link
                    to={`/superadmin/events/${event.id}`}
                    className="flex min-w-0 flex-1 flex-col gap-2 py-4 pl-5 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-sm font-semibold text-ink">
                        {event.event_name || "Untitled Event"}
                      </p>
                      <p className="prose-muted mt-0.5 truncate text-xs">
                        {[event.event_type, formatDay(event.event_date), event.location]
                          .filter(Boolean)
                          .join(" · ")}
                        {event.teacher_name || event.teacher_email
                          ? ` · ${submitterOf(event).verb.toLowerCase()} ${submitterOf(event).name} (${submitterOf(event).role})`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusChip status={event.status} />
                      <span className="btn btn-ghost btn-xs">
                        View
                        <IconArrowRight />
                      </span>
                    </div>
                  </Link>
                  {/* Outside the link, so deleting never also opens the event. */}
                  <button
                    type="button"
                    onClick={() => setPendingDelete({ event, confirmText: "" })}
                    className="btn btn-danger btn-xs btn-icon shrink-0"
                    title="Delete this event permanently"
                    aria-label={`Delete ${event.event_name || "event"}`}
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {total > 0 && (
            <Pagination
              page={page}
              perPage={per}
              total={total}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
              disabled={loading}
            />
          )}
        </section>
      </div>

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => !deleting && setPendingDelete(null)}
        eyebrow="Permanent"
        title="Delete this event permanently?"
        subtitle={pendingDelete?.event?.event_name || ""}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deleting || pendingDelete?.confirmText !== "DELETE"}
              className="btn btn-danger btn-sm"
            >
              {deleting ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete permanently
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="prose-muted text-sm">
            The event is removed with its photos, videos, documents and report. This cannot be undone.
          </p>
          <div className="field">
            <label htmlFor="adminDeleteConfirm">
              Type <span className="font-semibold">DELETE</span> to confirm
            </label>
            <input
              id="adminDeleteConfirm"
              type="text"
              value={pendingDelete?.confirmText || ""}
              onChange={(e) => setPendingDelete((current) => ({ ...current, confirmText: e.target.value }))}
              autoComplete="off"
              placeholder="DELETE"
              className="input"
            />
          </div>
        </div>
      </Modal>
    </SuperAdminShell>
  );
}
