import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { apiJson, isAbortError } from "../../services/api";
import DeanShell from "../../components/dean/DeanShell";
import Modal from "../../components/teacher/Modal";
import DateRangeModal from "../../components/common/DateRangeModal";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArchive,
  IconCalendar,
  IconCheck,
  IconCheckCircle,
  IconDownload,
  IconEye,
  IconMoreHorizontal,
  IconRefresh,
  IconRotateCcw,
  IconSearch,
  IconTrash,
  IconX,
} from "../../components/teacher/icons";
import {
  DEAN_STATUS_FILTERS,
  canApprove,
  canReject,
  canRevoke,
  getApproveLabel,
  getStatusBucket,
} from "../../utils/constants";
import useEventTypes from "../../hooks/useEventTypes";
import useTableQuery from "../../hooks/useTableQuery";
import SubmissionsGroupedList from "../../components/dean/SubmissionsGroupedList";
import { bulkEvents } from "../../services/deanTeachers";
import useEventReportDownload from "../../hooks/useEventReportDownload";

/**
 * A row's overflow menu for secondary actions. Rendered into <body> with fixed
 * positioning so table/card boundaries cannot clip it.
 */
function RowMenu({ label, items, onSelect }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const WIDTH = 210;

  const place = useCallback(() => {
    const button = buttonRef.current?.getBoundingClientRect();
    if (!button) return;
    const height = menuRef.current?.offsetHeight || 0;
    const below = button.bottom + 6;
    const top =
      below + height > window.innerHeight - 8
        ? Math.max(8, button.top - height - 6)
        : below;
    const left = Math.min(
      Math.max(8, button.right - WIDTH),
      window.innerWidth - WIDTH - 8,
    );
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const itemsOf = () => [
      ...(menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || []),
    ];
    itemsOf()[0]?.focus({ preventScroll: true });

    const close = (refocus = false) => {
      setOpen(false);
      if (refocus) buttonRef.current?.focus();
    };
    const onPointer = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) {
        close();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = itemsOf();
        const at = list.indexOf(document.activeElement);
        const next =
          e.key === "ArrowDown"
            ? (at + 1) % list.length
            : (at - 1 + list.length) % list.length;
        list[next]?.focus({ preventScroll: true });
      } else if (e.key === "Tab") {
        close();
      }
    };
    const onScroll = () => place();

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="More actions"
        className={`btn btn-ghost btn-xs border border-line/80 font-medium text-ink hover:bg-raised/60 inline-flex items-center justify-center h-7 w-7 p-0 ${
          open ? "bg-raised" : ""
        }`}
      >
        <IconMoreHorizontal className="h-4 w-4 text-muted hover:text-ink" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            className="hv-popover glass glass-blur fixed z-50 rounded-xl p-1.5 text-left shadow-lg border border-line/80"
            style={{ top: pos.top, left: pos.left, width: WIDTH }}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.key);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${
                  item.danger
                    ? "text-err hover:bg-err/10 focus-visible:bg-err/10"
                    : "text-ink hover:bg-raised focus-visible:bg-raised"
                }`}
              >
                <item.Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Minimal row actions: Report button + primary decision button + More (⋯) menu.
 */
function EventActions({
  event,
  isProcessing,
  isDownloading,
  onDownloadReport,
  canDownloadReport,
  onApprove,
  onReject,
  onRevoke,
  onRemove,
  navigate,
}) {
  const check = canDownloadReport || { canDownload: true };
  const hasApprove = canApprove(event);
  const hasRevoke = canRevoke(event);
  const hasReject = canReject(event);

  const menuItems = [
    {
      key: "view",
      label: "View details",
      Icon: IconEye,
    },
  ];

  if (hasApprove && hasReject) {
    menuItems.push({
      key: "reject",
      label: "Reject",
      Icon: IconX,
      danger: true,
    });
  }

  menuItems.push({
    key: "archive",
    label: "Archive or delete",
    Icon: IconArchive,
    danger: true,
  });

  const handleMenuSelect = (key) => {
    if (key === "view") {
      navigate(`/dean/events/${event.id}`);
    } else if (key === "reject") {
      onReject(event);
    } else if (key === "revoke") {
      onRevoke(event);
    } else if (key === "archive") {
      onRemove(event);
    }
  };

  return (
    <>
      {/* 1. Report download button */}
      <button
        type="button"
        onClick={onDownloadReport}
        disabled={isDownloading || !check.canDownload}
        title={check.reason || "Download report"}
        aria-label={`Download report for ${event.event_name}`}
        className={`btn btn-ghost btn-xs border border-line/80 font-medium ${
          !check.canDownload
            ? "opacity-45 cursor-not-allowed text-muted"
            : "text-ink hover:bg-raised/60"
        } inline-flex items-center gap-1.5`}
      >
        {isDownloading ? (
          <span className="spin h-3.5 w-3.5" />
        ) : (
          <IconDownload className="h-3.5 w-3.5 text-muted" />
        )}
        <span>Report</span>
      </button>

      {/* 2. Primary decision button */}
      {hasApprove ? (
        <button
          type="button"
          onClick={() => onApprove(event)}
          disabled={isProcessing}
          title={getApproveLabel(event)}
          className="btn btn-ok btn-xs"
        >
          {isProcessing ? <span className="spin h-3.5 w-3.5" /> : <IconCheck />}
          {getApproveLabel(event)}
        </button>
      ) : hasRevoke ? (
        <button
          type="button"
          onClick={() => onRevoke(event)}
          disabled={isProcessing}
          title="Withdraw this event's approval"
          className="btn btn-danger btn-xs"
        >
          {isProcessing ? <span className="spin h-3.5 w-3.5" /> : <IconX />}
          Revoke
        </button>
      ) : hasReject ? (
        <button
          type="button"
          onClick={() => onReject(event)}
          disabled={isProcessing}
          title="Reject this event"
          className="btn btn-danger btn-xs"
        >
          {isProcessing ? <span className="spin h-3.5 w-3.5" /> : <IconX />}
          Reject
        </button>
      ) : null}

      {/* 3. More (⋯) menu */}
      <RowMenu
        label={`More actions for ${event.event_name}`}
        items={menuItems}
        onSelect={handleMenuSelect}
      />
    </>
  );
}

function AllEvents() {
  const navigate = useNavigate();

  const [events, setEvents] = useState([]);

  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState(null);

  // Archiving / deleting, kept separate from `decision`: that state already
  // branches four ways, and mixing an irreversible delete into it is how a
  // mis-click ends up destroying an event's media.
  // { event, mode: "archive" | "delete", confirmText }
  const [removal, setRemoval] = useState(null);

  // "Select All Events": ids (with names, for the confirmation) kept across
  // pages and filters, so events can be picked from several pages at once.
  const [selected, setSelected] = useState(() => new Map());
  const [bulkDelete, setBulkDelete] = useState(null); // { confirmText } while open
  const [bulkArchive, setBulkArchive] = useState(null); // { reason } while open
  const [bulkBusy, setBulkBusy] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Filters and paging live in the URL (see useTableQuery), so a filtered
  // page can be linked and reloaded, and there is one place a filter can be
  // out of step with the rows it produced. Every filter change resets to
  // page 1 -- narrowing a filter while on page 7 would otherwise show an
  // empty table and read as a bug.
  const { query, setFilter, setFilters, reset } = useTableQuery({}, { paginate: false });
  // Categories come from the server now, so a type a teacher added is
  // filterable here -- which the old hardcoded list could not do.
  const { types: eventTypes } = useEventTypes();
  const { q: searchQuery, status: statusFilter, type: typeFilter,
          date: selectedDate, startDate, endDate } = query;
  const [showDateRangeModal, setShowDateRangeModal] = useState(false);

  // The search box is uncontrolled by the URL while typing: writing every
  // keystroke to history would flood it and refetch per character.
  const [searchDraft, setSearchDraft] = useState(searchQuery);

  // Totals for the status tabs and the footer, straight from the server --
  // they must count the whole result set, not the page on screen.
  const [total, setTotal] = useState(0);
  const [eventCounts, setEventCounts] = useState(() => {
    let cached = 0;
    try {
      const raw = sessionStorage.getItem("cc_dean_events_count");
      if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) cached = parsed;
      }
    } catch {
      // ignore
    }
    return { all: cached };
  });

  // Signed-in Dean, used for the shell's account blocks.
  const [deanProfile, setDeanProfile] = useState(null);

  // The decision being confirmed: { event, kind: "approve" | "reject" }.
  // A themed dialog rather than window.confirm / window.prompt, so a rejection
  // reason is typed in the product instead of in an OS box.
  const [decision, setDecision] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  const {
    downloadingRowId,
    isBulkDownloading,
    downloadProgress,
    downloadNotice,
    downloadError,
    setDownloadNotice,
    setDownloadError,
    downloadSingle,
    downloadBulk,
    canDownload,
  } = useEventReportDownload();

  useEffect(() => {
    if (downloadNotice) {
      setSuccess(downloadNotice);
      setDownloadNotice("");
    }
  }, [downloadNotice, setDownloadNotice]);

  useEffect(() => {
    if (downloadError) {
      setError(downloadError);
      setDownloadError("");
    }
  }, [downloadError, setDownloadError]);

  // ============================================================
  // ERRORS
  // A 401 means the session is gone (apiJson already cleared it): go to the
  // login page. Anything else, including a 409 when the event moved on
  // meanwhile, is shown with the backend's message.
  // ============================================================

  const handleApiError = (err, fallback, context) => {
    console.error(`${context}:`, err);
    if (err?.status === 401) {
      navigate("/login", { replace: true });
      return;
    }
    setError(err?.message || fallback);
  };

  // ============================================================
  // LOAD EVENTS
  //
  // Only the newest request may update the list: changing the date quickly
  // must not let a slow, older response overwrite the newer one.
  // ============================================================

  const loadControllerRef = useRef(null);

  useEffect(() => () => loadControllerRef.current?.abort(), []);

  const loadEvents = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams({
        limit: "1000",
      });
      if (query.date) params.set("event_date", query.date);
      if (query.startDate) params.set("start_date", query.startDate);
      if (query.endDate) params.set("end_date", query.endDate);
      if (query.type) params.set("event_type", query.type);
      if (query.q) params.set("q", query.q);
      if (query.source) params.set("source", query.source);
      if (query.status && query.status !== "all") {
        params.set("status_bucket", query.status);
      }

      const data = await apiJson(`/dean/events?${params}`, {
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      const totalAll = data?.counts?.all ?? data?.total ?? 0;
      if (totalAll > 0) {
        try {
          sessionStorage.setItem("cc_dean_events_count", String(totalAll));
        } catch {
          // ignore
        }
      }
      setEvents(data?.events || []);
      setTotal(data?.total || 0);
      setEventCounts(data?.counts || { all: totalAll });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      handleApiError(err, "Failed to load events", "Load events error");
      setEvents([]);
      setTotal(0);
    } finally {
      if (loadControllerRef.current === controller) setLoading(false);
    }
    // handleApiError is stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.date, query.startDate, query.endDate, query.type, query.q, query.status, query.source]);

  // ============================================================
  // INITIAL LOAD
  // ============================================================

  const loadDeanProfile = async () => {
    try {
      const data = await fetchCurrentUser();

      if (data) {
        setDeanProfile(data);
      }
    } catch (err) {
      // Non-blocking: the shell falls back to a neutral initial.
      console.error("Load dean profile error:", err);
    }
  };

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadDeanProfile();
  }, []);

  // Debounced so typing does not fire a request per character; `replace`
  // keeps the back button useful instead of one entry per keystroke.
  useEffect(() => {
    if (searchDraft === searchQuery) return undefined;
    const timer = setTimeout(
      () => setFilter("q", searchDraft, { replace: true }),
      350,
    );
    return () => clearTimeout(timer);
  }, [searchDraft, searchQuery, setFilter]);

  // ============================================================
  // AUTO-DISMISS SUCCESS
  //
  // Feedback is shown as a floating toast so it never pushes the
  // table down and forces the Dean to scroll.
  // ============================================================

  useEffect(() => {
    if (!success) {
      return undefined;
    }

    const timer = setTimeout(() => setSuccess(""), 4500);

    return () => clearTimeout(timer);
  }, [success]);

  // ============================================================
  // DATE CHANGE
  // ============================================================

  const handleDateChange = (event) =>
    setFilters({ date: event.target.value, startDate: "", endDate: "" });

  // ============================================================
  // FORMAT DATE
  // ============================================================

  const formatEventDate = (value) => {
    if (!value) {
      return "—";
    }

    const dateObject = new Date(`${value}T00:00:00`);

    if (Number.isNaN(dateObject.getTime())) {
      return value;
    }

    return dateObject.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  // ============================================================
  // LOGOUT
  // ============================================================

  const handleLogout = async () => {
    await signOut();

    navigate("/login", { replace: true });
  };

  // ============================================================
  // OPEN / CLOSE A DECISION
  // ============================================================

  const openDecision = (event, kind) => {
    setDecision({ event, kind });
    setRejectReason("");
    setReasonError("");
  };

  const closeDecision = () => {
    if (processingId) return; // never abandon a request mid-flight
    setDecision(null);
    setRejectReason("");
    setReasonError("");
  };

  // ============================================================
  // ARCHIVE / DELETE (PRD 1)
  // ============================================================

  // ============================================================
  // SELECT ALL EVENTS + BULK DELETE
  // ============================================================

  // Intersect selection with currently visible (filtered) events (Requirement 3)
  const effectiveSelectedEvents = useMemo(() => {
    return events.filter((event) => selected.has(event.id));
  }, [events, selected]);

  const effectiveSelectedIds = useMemo(() => {
    return new Set(effectiveSelectedEvents.map((event) => event.id));
  }, [effectiveSelectedEvents]);

  const toggleEvent = (event) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(event.id)) next.delete(event.id);
      else next.set(event.id, event.event_name || "Untitled Event");
      return next;
    });
  };

  const toggleGroup = (groupItems) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const allSelected = groupItems.every((item) => next.has(item.id));
      if (allSelected) {
        groupItems.forEach((item) => next.delete(item.id));
      } else {
        groupItems.forEach((item) => next.set(item.id, item.event_name || "Untitled Event"));
      }
      return next;
    });
  };

  /** Select all currently visible (loaded) events. */
  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      visibleEvents.forEach((event) => next.set(event.id, event.event_name || "Untitled Event"));
      return next;
    });
  };

  const runBulkDelete = async () => {
    const ids = effectiveSelectedEvents.map((e) => e.id);
    if (ids.length === 0) return;
    try {
      setBulkBusy(true);
      setError("");
      setSuccess("");
      // The whole selection in one request.
      const data = await bulkEvents("delete", ids);
      const deleted = data?.deleted_count || 0;
      const missing = data?.not_found_count || 0;
      setBulkDelete(null);
      setSelected(new Map());
      setSuccess(
        `${deleted} event${deleted === 1 ? "" : "s"} deleted permanently.` +
          (missing ? ` ${missing} could not be found (already removed).` : ""),
      );
      await loadEvents();
    } catch (err) {
      handleApiError(err, "Failed to delete the selected events", "Bulk delete events error");
      setBulkDelete(null);
      await loadEvents();
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkArchive = async () => {
    const ids = effectiveSelectedEvents.map((e) => e.id);
    if (ids.length === 0) return;
    try {
      setBulkBusy(true);
      setError("");
      setSuccess("");
      // The whole selection in one request.
      const data = await bulkEvents("archive", ids, { reason: bulkArchive?.reason?.trim() || null });
      const archived = data?.archived_count || 0;
      const skipped = data?.skipped_count || 0;
      setBulkArchive(null);
      setSelected(new Map());
      setSuccess(
        `${archived} event${archived === 1 ? "" : "s"} moved to the archive.` +
          (skipped ? ` ${skipped} skipped (already archived or no longer available).` : ""),
      );
      await loadEvents();
    } catch (err) {
      handleApiError(err, "Failed to archive the selected events", "Bulk archive events error");
      setBulkArchive(null);
      await loadEvents();
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmRemoval = async () => {
    const event = removal?.event;
    if (!event) return;

    const deleting = removal.mode === "delete";

    try {
      setProcessingId(event.id);
      setError("");
      setSuccess("");

      if (deleting) {
        await apiJson(`/dean/events/${event.id}`, { method: "DELETE" });
      } else {
        await apiJson(`/dean/events/${event.id}/archive`, { method: "PATCH" });
      }

      setRemoval(null);
      setSuccess(
        deleting ? "Event deleted permanently." : "Event moved to the archive.",
      );
      // Refetch rather than splicing the row out: on a paged list, removing
      // one row locally would leave 24 of 25 with no way to pull the next in.
      await loadEvents();
    } catch (err) {
      handleApiError(
        err,
        deleting ? "Failed to delete event" : "Failed to archive event",
        "Remove event error",
      );
      setRemoval(null);
    } finally {
      setProcessingId(null);
    }
  };

  /**
   * Reload the current page after a decision.
   *
   * Patching the row in place was right while the whole list lived in the
   * browser. Now that the server does the filtering and the counting, an
   * approved event has to leave the Pending tab and the tab counts have to
   * move with it — neither of which a local splice can do.
   */
  const refreshAfterDecision = () => loadEvents();

  // ============================================================
  // APPROVE EVENT
  // ============================================================

  const confirmApprove = async () => {
    const event = decision?.event;

    if (!event) {
      return;
    }

    try {
      setProcessingId(event.id);
      setError("");
      setSuccess("");

      const data = await apiJson(`/dean/events/${event.id}/approve`, { method: "PATCH" });

      await refreshAfterDecision();

      setSuccess(data.message || "Event approved successfully.");
      setDecision(null);
    } catch (err) {
      handleApiError(err, "Failed to approve event", "Approve event error");
      setDecision(null);
    } finally {
      setProcessingId(null);
    }
  };

  // ============================================================
  // REJECT EVENT
  // ============================================================

  const confirmReject = async () => {
    const event = decision?.event;

    if (!event) {
      return;
    }

    const reason = rejectReason.trim();

    if (!reason) {
      setReasonError("A reason is required — the teacher sees it verbatim.");
      return;
    }

    try {
      setProcessingId(event.id);
      setError("");
      setSuccess("");
      setReasonError("");

      // In the body, not the query string: long reasons would hit URL
      // limits and end up in access logs.
      const revoking = decision?.kind === "revoke";
      const data = await apiJson(
        `/dean/events/${event.id}/${revoking ? "revoke" : "reject"}`,
        {
          method: "PATCH",
          body: revoking
            ? { revocation_reason: reason }
            : { rejection_reason: reason },
        },
      );

      await refreshAfterDecision();

      setSuccess(
        data.message ||
          (revoking ? "Event approval revoked." : "Event rejected successfully."),
      );
      setDecision(null);
    } catch (err) {
      handleApiError(err, "Failed to reject event", "Reject event error");
      setDecision(null);
    } finally {
      setProcessingId(null);
    }
  };

  // ============================================================
  // EVENT COUNTS
  //
  // Always computed from the full fetch scope, never from the
  // client-filtered list, so the chip totals stay stable while filtering.
  // ============================================================

  // `events` is one page of an already-filtered result set, so there is no
  // second, client-side filtering pass to apply.
  const visibleEvents = events;

  const isFiltered =
    searchQuery.trim() !== "" ||
    statusFilter !== "all" ||
    typeFilter !== "" ||
    query.source !== "" ||
    selectedDate !== "" ||
    startDate !== "" ||
    endDate !== "";

  const handleClearAllFilters = () => {
    setSearchDraft("");
    reset();
  };

  // The decision dialog's copy depends on what the current status makes of it:
  // approving a rejection clears the reason, rejecting an approval revokes it.
  const decisionEvent = decision?.event;
  const decisionBucket = getStatusBucket(decisionEvent?.status);
  // Its own action now, not a rejection wearing a different label (PRD 18).
  const isRevoking = decision?.kind === "revoke";
  const isReapproving = decision?.kind === "approve" && decisionBucket === "rejected";
  const isRestoringRevoked = isReapproving && decisionEvent?.status === "revoked";
  const decisionBusy = Boolean(processingId);

  // ============================================================
  // MAIN UI
  //
  // The screen is height-locked: only the table body scrolls, so the
  // toolbar, the status chips and the column headers always stay put.
  // ============================================================

  return (
    <DeanShell
      active="events"
      profile={deanProfile}
      onLogout={handleLogout}
      railBadge={eventCounts.all > 0 ? eventCounts.all : (loading ? undefined : 0)}
      railNote="Approve or reject from the row, or open an event for the full proposal, its media and its documents."
    >
      {/* Toasts sit bottom-right so feedback never shifts the layout or covers
          the filter controls. */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
        {error && (
          <div className="toast toast-err pointer-events-auto" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{error}</p>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}

        {success && (
          <div className="toast toast-ok pointer-events-auto" role="status">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
              <IconCheck className="h-3 w-3" />
            </span>
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{success}</p>
            <button
              type="button"
              onClick={() => setSuccess("")}
              aria-label="Dismiss message"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* `min-w-0` lets the main column shrink below its content width so the
          cards stay inside the viewport and the table — not the page — owns
          any horizontal overflow. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-5 lg:px-6 lg:py-6">

        {/* ================================================
            COMMAND BAR
            Title, search, program type, date and the status
            chips — every control on one screen, no scrolling.
        ================================================ */}
        <div className="glass shrink-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:px-5">

            <div className="mr-auto min-w-0">
              <p className="eyebrow">Dean Panel</p>
              <h1 className="h3 mt-0.5 truncate text-ink">All Events</h1>
            </div>

            {/* Search */}
            <div className="relative w-full sm:w-60 xl:w-72">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
                <IconSearch className="h-4 w-4" />
              </span>

              <input
                id="eventSearch"
                type="text"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Search name, venue, type or teacher…"
                aria-label="Search events by name, venue, type or teacher"
                className="input pl-10 pr-9"
              />

              {searchDraft && (
                <button
                  type="button"
                  onClick={() => setSearchDraft("")}
                  aria-label="Clear search"
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted transition hover:text-ink"
                >
                  <IconX className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Program type + date share a line on narrow screens */}
            <div className="flex w-full gap-2.5 sm:w-auto">
              <select
                value={typeFilter}
                onChange={(e) => setFilter("type", e.target.value)}
                aria-label="Filter by program type"
                className="input min-w-0 flex-1 sm:w-40 sm:flex-none"
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
                className="input min-w-0 flex-1 sm:w-44 sm:flex-none"
              >
                <option value="">All submitters</option>
                <option value="teacher">Teachers</option>
                <option value="event_manager">Event Managers</option>
              </select>

              <input
                id="eventDate"
                type="date"
                value={selectedDate}
                onChange={handleDateChange}
                aria-label="Filter by event date"
                className="input min-w-0 flex-1 sm:w-42 sm:flex-none"
              />

              <button
                type="button"
                onClick={() => setShowDateRangeModal(true)}
                className={`btn btn-sm shrink-0 ${
                  startDate || endDate ? "btn-primary font-medium" : "btn-ghost"
                }`}
                title="Filter by date range"
                aria-label="Filter by date range"
              >
                <IconCalendar />
                <span>
                  {startDate && endDate
                    ? `${startDate} – ${endDate}`
                    : startDate
                      ? `From ${startDate}`
                      : endDate
                        ? `Until ${endDate}`
                        : "Date Range"}
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => loadEvents(selectedDate)}
              disabled={loading}
              className="btn btn-ghost btn-sm shrink-0"
            >
              {loading ? <span className="spin h-4 w-4" /> : <IconRefresh />}
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>

          {/* Status tabs + result count */}
          <div className="flex flex-wrap items-center gap-1.5 border-t hairline bg-raised/35 px-4 py-2.5 sm:px-5">
            {DEAN_STATUS_FILTERS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.key}
                onClick={() => setFilter("status", tab.key)}
                className="tab"
              >
                {tab.label}
                <span className="tab-count">{eventCounts[tab.key] ?? 0}</span>
              </button>
            ))}

            <div className="ml-auto flex items-center gap-3">
              <p className="num text-xs font-medium text-muted">
                {total === 0
                  ? "No events"
                  : `Showing ${visibleEvents.length} of ${total}`}
              </p>

              {isFiltered && (
                <button
                  type="button"
                  onClick={handleClearAllFilters}
                  className="btn btn-ghost btn-xs"
                >
                  <IconRotateCcw />
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Warning Banner if total > loaded events (1,000 cap reached) (Requirement 2) */}
        {total > visibleEvents.length && (
          <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs sm:text-sm text-amber-800 dark:text-amber-200">
            <IconAlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>
              Showing first {visibleEvents.length.toLocaleString()} of {total.toLocaleString()}. Narrow your filters.
            </span>
          </div>
        )}

        {/* Reusable Grouped List (Requirement 1 & 2) */}
        <SubmissionsGroupedList
          events={visibleEvents}
          loading={loading}
          isFiltered={isFiltered}
          onClearFilters={handleClearAllFilters}
          selectedEventType={typeFilter}
          title="All Events Review Queue"
          showReviewQueueLink={false}
          selectedIds={effectiveSelectedIds}
          defaultExpanded={false}
          onToggleSelect={toggleEvent}
          onToggleSelectGroup={toggleGroup}
          onClearSelection={() => setSelected(new Map())}
          allowDecisions={true}
          renderRowActions={(event) => (
            <EventActions
              event={event}
              isProcessing={processingId === event.id}
              isDownloading={downloadingRowId === event.id}
              onDownloadReport={() => downloadSingle(event)}
              canDownloadReport={canDownload(event)}
              onApprove={(e) => openDecision(e, "approve")}
              onReject={(e) => openDecision(e, "reject")}
              onRevoke={(e) => openDecision(e, "revoke")}
              onRemove={(e) => setRemoval({ event: e, mode: "archive", confirmText: "" })}
              navigate={navigate}
            />
          )}
          renderDrawerActions={(event) => {
            const check = canDownload(event);
            const isDownloading = downloadingRowId === event.id;
            return (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadSingle(event)}
                  disabled={isDownloading || !check.canDownload}
                  title={check.reason || "Download report"}
                  aria-label={`Download report for ${event.event_name}`}
                  className={`btn btn-ghost btn-xs border border-line/80 font-medium ${
                    !check.canDownload
                      ? "opacity-45 cursor-not-allowed text-muted"
                      : "text-ink hover:bg-raised/60"
                  } inline-flex items-center gap-1.5`}
                >
                  {isDownloading ? (
                    <span className="spin h-3.5 w-3.5" />
                  ) : (
                    <IconDownload className="h-3.5 w-3.5 text-muted" />
                  )}
                  <span>Report</span>
                </button>
                {canApprove(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision(event, "approve")}
                    disabled={processingId === event.id}
                    className="btn btn-ok btn-xs"
                  >
                    <IconCheck />
                    {getApproveLabel(event)}
                  </button>
                )}
                {canReject(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision(event, "reject")}
                    disabled={processingId === event.id}
                    className="btn btn-danger btn-xs"
                  >
                    <IconX />
                    Reject
                  </button>
                )}
                {canRevoke(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision(event, "revoke")}
                    disabled={processingId === event.id}
                    className="btn btn-danger btn-xs"
                  >
                    Revoke
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setRemoval({ event, mode: "archive", confirmText: "" })}
                  disabled={processingId === event.id}
                  className="btn btn-ghost btn-xs text-err"
                >
                  <IconArchive />
                  Archive
                </button>
              </div>
            );
          }}
          bulkActions={({ clearSelection }) => (
            <>
              {visibleEvents.length > effectiveSelectedEvents.length && (
                <button
                  type="button"
                  onClick={selectAllVisible}
                  disabled={bulkBusy || isBulkDownloading}
                  className="btn btn-ghost btn-xs font-medium text-ink"
                >
                  Select all {visibleEvents.length} events
                </button>
              )}
              <button
                type="button"
                onClick={() => downloadBulk(effectiveSelectedEvents)}
                disabled={bulkBusy || isBulkDownloading || effectiveSelectedEvents.length === 0}
                className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink inline-flex items-center gap-1.5"
                title="Download report for selected events"
              >
                {isBulkDownloading ? (
                  <span className="spin h-3.5 w-3.5" />
                ) : (
                  <IconDownload className="h-3.5 w-3.5" />
                )}
                <span>{downloadProgress || "Download report"}</span>
              </button>
              <button
                type="button"
                onClick={() => setBulkArchive({ reason: "" })}
                disabled={bulkBusy || isBulkDownloading}
                className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink inline-flex items-center gap-1.5"
              >
                <IconArchive className="h-3.5 w-3.5" />
                Archive selected
              </button>
              <button
                type="button"
                onClick={() => setBulkDelete({ confirmText: "" })}
                disabled={bulkBusy || isBulkDownloading}
                className="btn btn-ghost btn-xs border border-red-500/30 text-red-600 dark:text-red-400 font-medium inline-flex items-center gap-1.5"
              >
                <IconTrash className="h-3.5 w-3.5" />
                Delete selected
              </button>
              <span className="text-muted">·</span>
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkBusy || isBulkDownloading}
                className="btn btn-ghost btn-xs text-muted hover:text-ink font-medium"
              >
                Clear
              </button>
            </>
          )}
        />
      </div>

      {/* ==================================================================
          BULK ARCHIVE -- reversible, so a plain confirmation with an
          optional reason, as for archiving one event.
      ================================================================== */}
      <Modal
        open={Boolean(bulkArchive)}
        onClose={() => !bulkBusy && setBulkArchive(null)}
        eyebrow="Archive"
        title={`Archive ${effectiveSelectedEvents.length} ${effectiveSelectedEvents.length === 1 ? "event" : "events"}?`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setBulkArchive(null)}
              disabled={bulkBusy}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button type="button" onClick={runBulkArchive} disabled={bulkBusy} className="btn btn-brand btn-sm">
              {bulkBusy ? <span className="spin h-4 w-4" /> : <IconArchive />}
              Archive {effectiveSelectedEvents.length}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="prose-muted text-sm">
            The events leave the review list and move to the Archive, with every record, photo and
            document kept. Each can be restored from the Archive at any time.
          </p>
          <div className="field">
            <label htmlFor="bulkArchiveReason">
              Reason <span className="ml-2 font-normal text-muted">(Optional)</span>
            </label>
            <textarea
              id="bulkArchiveReason"
              rows={2}
              maxLength={1000}
              value={bulkArchive?.reason || ""}
              onChange={(event) => setBulkArchive({ reason: event.target.value })}
              className="input"
            />
          </div>
        </div>
      </Modal>

      {/* ==================================================================
          BULK DELETE -- the irreversible outcome, so typed confirmation as
          for a single delete.
      ================================================================== */}
      <Modal
        open={Boolean(bulkDelete)}
        onClose={() => !bulkBusy && setBulkDelete(null)}
        eyebrow="Permanent"
        title={`Delete ${effectiveSelectedEvents.length} ${effectiveSelectedEvents.length === 1 ? "event" : "events"} permanently?`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setBulkDelete(null)}
              disabled={bulkBusy}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={runBulkDelete}
              disabled={bulkBusy || bulkDelete?.confirmText !== "DELETE"}
              className="btn btn-danger btn-sm"
            >
              {bulkBusy ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete {effectiveSelectedEvents.length} permanently
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="prose-muted text-sm">
            Each event is removed with its photos, videos, documents and report. This cannot be undone.
            To keep an event&apos;s records, archive it instead.
          </p>
          <ul className="max-h-40 space-y-1 overflow-auto rounded-xl border hairline bg-raised/40 p-3 text-xs text-ink">
            {effectiveSelectedEvents.slice(0, 50).map((event) => (
              <li key={event.id} className="truncate">{event.event_name || "Untitled Event"}</li>
            ))}
            {effectiveSelectedEvents.length > 50 && (
              <li className="text-muted">…and {effectiveSelectedEvents.length - 50} more</li>
            )}
          </ul>
          <div className="field">
            <label htmlFor="bulkDeleteConfirm">
              Type <span className="font-semibold">DELETE</span> to confirm
            </label>
            <input
              id="bulkDeleteConfirm"
              type="text"
              value={bulkDelete?.confirmText || ""}
              onChange={(event) => setBulkDelete({ confirmText: event.target.value })}
              autoComplete="off"
              placeholder="DELETE"
              className="input"
            />
          </div>
        </div>
      </Modal>

      {/* ==================================================================
          ARCHIVE OR DELETE
          Two outcomes behind one control, with the reversible one selected by
          default and the irreversible one gated behind typing DELETE.
      ================================================================== */}
      <Modal
        open={Boolean(removal)}
        onClose={() => !processingId && setRemoval(null)}
        eyebrow="Remove"
        title="Remove this event?"
        subtitle={removal?.event?.event_name || ""}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setRemoval(null)}
              disabled={Boolean(processingId)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn btn-sm ${
                removal?.mode === "delete" ? "btn-danger" : "btn-brand"
              }`}
              onClick={confirmRemoval}
              disabled={
                Boolean(processingId) ||
                (removal?.mode === "delete" && removal?.confirmText !== "DELETE")
              }
            >
              {processingId ? <span className="spin h-3.5 w-3.5" /> : null}
              {removal?.mode === "delete" ? "Delete permanently" : "Archive"}
            </button>
          </>
        }
      >
        <div className="space-y-2.5">
          {[
            {
              mode: "archive",
              label: "Archive",
              hint: "Hides it from All Events but keeps the record, its media and its report. You can restore it from the Archive at any time.",
            },
            {
              mode: "delete",
              label: "Delete permanently",
              hint: "Removes the event, its photos, videos, documents and report. This cannot be undone.",
            },
          ].map((option) => (
            <label
              key={option.mode}
              className={`glass flex cursor-pointer gap-3 rounded-xl p-3.5 ${
                removal?.mode === option.mode ? "ring-1 ring-accent/40" : ""
              }`}
            >
              <input
                type="radio"
                name="removalMode"
                checked={removal?.mode === option.mode}
                onChange={() =>
                  setRemoval((current) => ({
                    ...current,
                    mode: option.mode,
                    confirmText: "",
                  }))
                }
                className="mt-1 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">
                  {option.label}
                </span>
                <span className="prose-muted block text-xs">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {removal?.mode === "delete" && (
          <div className="field mt-4">
            <label htmlFor="deleteConfirm">
              Type <span className="font-semibold">DELETE</span> to confirm
            </label>
            <input
              id="deleteConfirm"
              type="text"
              value={removal.confirmText}
              onChange={(event) =>
                setRemoval((current) => ({
                  ...current,
                  confirmText: event.target.value,
                }))
              }
              autoComplete="off"
              placeholder="DELETE"
              className="input"
            />
          </div>
        )}
      </Modal>

      {/* ==================================================================
          THE DECISION
          One dialog for both halves of the decision: the reject side adds a
          reason field, and both sides spell out what changes for the teacher.
      ================================================================== */}
      <Modal
        open={Boolean(decision)}
        onClose={closeDecision}
        eyebrow="Confirm"
        title={
          decision?.kind === "approve"
            ? isReapproving
              ? "Re-approve event"
              : "Do you want to approve?"
            : isRevoking
            ? "Revoke this approval?"
            : "Reject event"
        }
        subtitle={
          decision?.kind === "approve"
            ? "The teacher is notified of the decision."
            : "The teacher sees the reason you give."
        }
        footer={
          <>
            <button
              type="button"
              onClick={closeDecision}
              disabled={decisionBusy}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>

            {decision?.kind === "approve" && (
              <button
                type="button"
                onClick={() =>
                  navigate(`/dean/events/${decisionEvent?.id}?action=approve`)
                }
                disabled={decisionBusy}
                className="btn btn-ghost btn-sm"
              >
                Open event and approve
              </button>
            )}

            {decision?.kind === "approve" ? (
              <button
                type="button"
                onClick={confirmApprove}
                disabled={decisionBusy}
                className="btn btn-ok btn-sm"
              >
                {decisionBusy ? <span className="spin h-3.5 w-3.5" /> : <IconCheck />}
                {decisionBusy
                  ? "Approving…"
                  : isReapproving
                  ? "Re-approve"
                  : "Approve"}
              </button>
            ) : (
              <button
                type="button"
                onClick={confirmReject}
                disabled={decisionBusy}
                className="btn btn-danger btn-sm"
              >
                {decisionBusy ? <span className="spin h-3.5 w-3.5" /> : <IconX />}
                {decisionBusy
                  ? isRevoking
                    ? "Revoking…"
                    : "Rejecting…"
                  : isRevoking
                  ? "Revoke approval"
                  : "Reject"}
              </button>
            )}
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span
            className="icon-tile icon-tile-track"
            style={{
              "--track":
                decision?.kind === "approve" ? trackOf("approved") : trackOf("rejected"),
            }}
          >
            {decision?.kind === "approve" ? <IconCheckCircle /> : <IconAlertTriangle />}
          </span>

          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              {decisionEvent?.event_name || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              {[
                decisionEvent?.event_type,
                formatEventDate(decisionEvent?.event_date),
                decisionEvent?.location,
              ]
                .filter(Boolean)
                .join(" · ") || "No details recorded"}
            </p>
          </div>
        </div>

        {/* What the decision actually changes, when it is not the plain case */}
        {(isRevoking || isReapproving) && (
          <div
            className="mt-4 rounded-xl border px-4 py-3"
            data-tint=""
            style={{ "--track": trackOf(isRevoking ? "rejected" : "approved") }}
          >
            <p className="text-sm text-ink">
              {isRevoking
                ? "This event is approved. Revoking withdraws that approval, invalidates any generated report, and notifies the teacher — who can then fix and resubmit it."
                : isRestoringRevoked
                ? "This event's approval was revoked. Re-approving restores it, clears the revocation reason, and puts the delivery stages back within reach."
                : "This event is rejected. Re-approving it clears the existing rejection reason and notifies the teacher."}
            </p>
          </div>
        )}

        {/* Revoke belongs here too: confirmReject will not send without a
            reason, so omitting the field made the button a silent no-op. */}
        {(decision?.kind === "reject" || decision?.kind === "revoke") && (
          <div className="field mt-5">
            <label htmlFor="rejectReason">
              {decision?.kind === "revoke"
                ? "Reason for revoking approval"
                : "Reason for rejection"}
              <span className="req">*</span>
            </label>

            <textarea
              id="rejectReason"
              value={rejectReason}
              onChange={(e) => {
                setRejectReason(e.target.value);
                if (reasonError) setReasonError("");
              }}
              rows={4}
              autoFocus
              placeholder={
                decision?.kind === "revoke"
                  ? "Why is this approval being withdrawn?"
                  : "What needs to change before this can be approved?"
              }
              aria-invalid={reasonError ? "true" : undefined}
              aria-describedby={reasonError ? "rejectReasonError" : undefined}
              className="input"
            />

            {reasonError && (
              <p id="rejectReasonError" className="field-error">
                {reasonError}
              </p>
            )}
          </div>
        )}
      </Modal>

      <DateRangeModal
        open={showDateRangeModal}
        onClose={() => setShowDateRangeModal(false)}
        startDate={startDate}
        endDate={endDate}
        onApply={({ startDate: s, endDate: e }) => {
          setFilters({ startDate: s, endDate: e, date: "" });
        }}
        onClear={() => {
          setFilters({ startDate: "", endDate: "" });
        }}
      />
    </DeanShell>
  );
}

export default AllEvents;
