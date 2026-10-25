import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiJson } from "../../services/api";
import { downloadMyEventsExcel } from "../../services/downloads";
import { useOriginState } from "../../hooks/useOriginState";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { canTeacherEditEvent, getRefusalReason } from "../../utils/constants";
import { localDateKey, localDateKeyOffset } from "../../utils/dates";
import {
  getTeacherDrafts,
  deleteTeacherDraft,
  duplicateEventAsDraft,
  decodeEventMetadata,
} from "../../utils/draftStorage";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import {
  MAX_EVENTS_PER_REPORT,
  bulkDeleteEvents,
  bulkSubmitDrafts,
  downloadEventReport,
  downloadEventsReport,
  reportNotice,
} from "../../services/eventManager";
import Modal from "../../components/teacher/Modal";
import DateRangeModal from "../../components/common/DateRangeModal";
import DownloadExcelButton from "../../components/common/DownloadExcelButton";
import Pagination from "../../components/common/Pagination";
import ReportCustomizationModal from "../../components/common/ReportCustomizationModal";
import EventReportButton from "../../components/common/EventReportButton";
import { eventReportRestriction, selectedReportsRestriction } from "../../utils/eventReportEligibility";
import StatusChip from "../../components/teacher/StatusChip";
import { isRefusedStatus, trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconCheckCircle,
  IconCopy,
  IconDownload,
  IconEdit,
  IconInbox,
  IconPlus,
  IconRefresh,
  IconRotateCcw,
  IconSearch,
  IconTrash,
  IconX,
} from "../../components/teacher/icons";

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

// A panel without the Dean's review (Event Manager): events are either
// still drafts or recorded.
const DIRECT_STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "recorded", label: "Submitted" },
];

const DATE_FILTERS = [
  { key: "all_time", label: "All dates" },
  { key: "today", label: "Today" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "custom", label: "Custom range" },
];

const eventTypeOf = (item) => String(item.event_type || item.eventType || "").trim();

/**
 * Table columns, ordered by how much each one tells the teacher at a glance.
 * Actions is pinned to the right edge, so on a narrow screen it is Venue —
 * the least decisive field, and one still shown in full on the details page —
 * that slides under the pin rather than the status or the event name.
 */
const COLUMNS = [
  { label: "Event", className: "" },
  { label: "Status", className: "" },
  { label: "Type", className: "" },
  { label: "Date", className: "" },
  { label: "Venue", className: "hidden min-[1340px]:table-cell" },
  { label: "Actions", className: "sticky right-0 bg-raised/45 text-right" },
];

/**
 * Everything a teacher can do to one of their events. Shared by the desktop
 * table and the mobile card list so the two can never drift apart.
 */
function EventActions({ item, canDelete, onDuplicate, onDelete, originState, onReport, reporting }) {
  const panel = usePanel();
  return (
    <>
      {item.isDraft && (
        <Link
          to={`${panel.base}/create-event?draftId=${item.id}`}
          state={originState}
          title="Continue editing draft"
          className="btn btn-brand btn-xs"
        >
          <IconEdit />
          Edit
        </Link>
      )}

      {!item.isDraft && isRefusedStatus(item.status) && (
        <Link
          to={`${panel.base}/create-event?editEventId=${item.id}`}
          state={originState}
          title="Edit and resubmit event"
          className="btn btn-danger btn-xs"
        >
          <IconRefresh />
          Resubmit
        </Link>
      )}

      {/* Editable until the Dean approves it. Refused events -- rejected or
          revoked -- already have their own Resubmit action above. */}
      {!item.isDraft &&
        !isRefusedStatus(item.status) &&
        canTeacherEditEvent(item) && (
          <Link
            to={`${panel.base}/create-event?editEventId=${item.id}`}
            state={originState}
            title="Edit event"
            className="btn btn-ghost btn-xs"
          >
            <IconEdit />
            Edit
          </Link>
        )}

      {!item.isDraft && (
        <Link
          to={`${panel.base}/events/${item.id}`}
          title="View event details"
          className="btn btn-ghost btn-xs"
        >
          View
          <IconArrowRight />
        </Link>
      )}

      {panel.reports && (
        <EventReportButton
          event={item}
          onClick={() => onReport(item)}
          generating={reporting}
          className="btn btn-ghost btn-xs"
        />
      )}

      <button
        type="button"
        onClick={() => onDuplicate(item)}
        title="Duplicate as new draft"
        aria-label="Duplicate as new draft"
        className="icon-btn icon-btn-sm hover:border-ember/60 hover:text-emberink"
      >
        <IconCopy />
      </button>

      {canDelete && (
        <button
          type="button"
          onClick={() => onDelete(item)}
          title="Delete event"
          aria-label="Delete event"
          className="icon-btn icon-btn-sm hover:border-err/50 hover:text-err"
        >
          <IconTrash />
        </button>
      )}
    </>
  );
}

function MyEvents() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const originState = useOriginState();
  const panel = usePanel();
  const statusTabs = panel.approval ? STATUS_TABS : DIRECT_STATUS_TABS;

  const [selected, setSelected] = useState(() => new Set());
  const [reportingId, setReportingId] = useState("");
  const [customizingReport, setCustomizingReport] = useState(null); // { type: 'single' | 'selected', item?, eventIds?, count? }
  const [bulkDelete, setBulkDelete] = useState(null); // { confirmText } while the dialog is open
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkSubmit, setBulkSubmit] = useState(false); // the confirm dialog is open
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  const activeFilter = searchParams.get("filter") || "all";
  const activeEventType = panel.role === "event_manager" ? searchParams.get("type") || "" : "";

  // Data state. `events` is the page of saved events the server sent, under
  // the filters below; drafts kept only in this browser are filtered here.
  const [events, setEvents] = useState([]);
  const [listing, setListing] = useState({ total: 0, grandTotal: 0, counts: {}, eventTypes: [] });
  const [drafts, setDrafts] = useState([]);
  // Every event seen on any page, so a selection made on one page still
  // knows what it holds on another.
  const [knownItems, setKnownItems] = useState(() => new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Search & date filter state
  const [searchQuery, setSearchQuery] = useState("");
  // What the server is asked for: the search once typing pauses.
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFilter, setDateFilter] = useState("all_time"); // all_time | today | this_week | this_month | custom
  const [customFromDate, setCustomFromDate] = useState("");
  const [customToDate, setCustomToDate] = useState("");
  const [showDateRangeModal, setShowDateRangeModal] = useState(false);

  // Delete modal state
  const [deletingEvent, setDeletingEvent] = useState(null);
  const [deletingLoading, setDeletingLoading] = useState(false);
  const [draftReportAlertOpen, setDraftReportAlertOpen] = useState(false);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      setError("");

      const userProfile = await fetchCurrentUser();

      if (!userProfile) {
        navigate("/login", { replace: true });
        return;
      }

      if (userProfile.role !== panel.role) {
        navigate("/", { replace: true });
        return;
      }

      setProfile(userProfile);

      // Drafts kept only in this browser; the saved events load a page at a time.
      setDrafts(getTeacherDrafts(userProfile.id) || []);
    } catch (err) {
      console.error("My Events error:", err);
      setError(err.message || "Failed to load events.");
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, []);

  useEffect(() => {
    if (searchTerm === searchQuery.trim()) return undefined;
    const timer = setTimeout(() => setSearchTerm(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchTerm]);

  // Feedback is shown as a floating toast so it never pushes the list down
  // and forces the teacher to scroll.
  useEffect(() => {
    if (!successMessage) {
      return undefined;
    }

    const timer = setTimeout(() => setSuccessMessage(""), 4500);

    return () => clearTimeout(timer);
  }, [successMessage]);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const handleTabClick = (tabKey) => {
    // Replace, not push: a filter is a view of this page, not a place of its
    // own, and pushing one entry per click buried the page the teacher
    // arrived from under a pile of stale filter states.
    if (panel.role === "event_manager") {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set("filter", tabKey);
        return next;
      }, { replace: true });
    } else {
      setSearchParams({ filter: tabKey }, { replace: true });
    }
  };

  const handleClearFilters = () => {
    setSearchQuery("");
    setDateFilter("all_time");
    setCustomFromDate("");
    setCustomToDate("");
    setSearchParams({ filter: "all" }, { replace: true });
  };

  const isFiltered =
    searchQuery.trim() !== "" ||
    activeFilter !== "all" ||
    activeEventType !== "" ||
    dateFilter !== "all_time" ||
    customFromDate !== "" ||
    customToDate !== "";

  const openEventRow = (event, item) => {
    if (event.target.closest("a, button, input, select, textarea, [role='button']")) return;

    if (item.isDraft) {
      navigate(`${panel.base}/create-event?draftId=${item.id}`, { state: originState });
      return;
    }

    navigate(`${panel.base}/events/${item.id}`, { state: originState });
  };

  // Duplicate Event
  const handleDuplicate = (targetEvent) => {
    if (!profile) return;
    try {
      const newDraft = duplicateEventAsDraft(profile.id, targetEvent);
      setSuccessMessage(`Event "${targetEvent.event_name || targetEvent.eventName}" duplicated as draft.`);
      setTimeout(() => {
        navigate(`${panel.base}/create-event?draftId=${newDraft.id}`, { state: originState });
      }, 600);
    } catch (err) {
      console.error("Duplicate error:", err);
      alert("Failed to duplicate event.");
    }
  };

  // Confirm Delete
  const handleConfirmDelete = async () => {
    if (!deletingEvent || !profile) return;
    try {
      setDeletingLoading(true);
      if (deletingEvent.isDraft) {
        deleteTeacherDraft(profile.id, deletingEvent.id);
        setDrafts((prev) => prev.filter((d) => d.id !== deletingEvent.id));
      } else {
        await apiJson(`${panel.api}/events/${deletingEvent.id}`, { method: "DELETE" });
        setEvents((prev) => prev.filter((e) => e.id !== deletingEvent.id));
        reload();
      }

      setSuccessMessage("Event deleted successfully.");
      setDeletingEvent(null);
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete event: " + (err.message || "Unknown error"));
    } finally {
      setDeletingLoading(false);
    }
  };

  // The date filter as the range the server is asked for (local calendar
  // days: new Date("YYYY-MM-DD") would be UTC midnight).
  const dateRange = useMemo(() => {
    if (dateFilter === "today") return { start: localDateKey(), end: localDateKey() };
    if (dateFilter === "this_week") {
      const day = new Date().getDay();
      const sinceMonday = day === 0 ? 6 : day - 1;
      return { start: localDateKeyOffset(-sinceMonday), end: localDateKeyOffset(6 - sinceMonday) };
    }
    if (dateFilter === "this_month") {
      const month = localDateKey().slice(0, 7);
      return { start: `${month}-01`, end: `${month}-31` };
    }
    if (dateFilter === "custom") return { start: customFromDate, end: customToDate };
    return { start: "", end: "" };
  }, [dateFilter, customFromDate, customToDate]);

  // What the server is asked for, shared with the Excel download.
  const listFilters = useMemo(() => ({
    q: searchTerm,
    status: activeFilter === "submitted" ? "pending" : activeFilter,
    event_type: activeEventType,
    start_date: dateRange.start,
    end_date: dateRange.end,
  }), [searchTerm, activeFilter, activeEventType, dateRange]);

  // A new filter is a new list: back to its first page.
  const filterKey = JSON.stringify(listFilters);
  const [paging, setPaging] = useState({ key: filterKey, page: 1, per: 25 });
  if (paging.key !== filterKey) setPaging({ ...paging, key: filterKey, page: 1 });
  const currentPage = paging.page;

  useEffect(() => {
    if (!profile) return undefined;
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ paged: "true", skip: String((currentPage - 1) * paging.per), limit: String(paging.per) });
    for (const [key, value] of Object.entries(listFilters)) if (value && value !== "all") params.set(key, value);
    apiJson(`${panel.api}/events?${params}`, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        const page = (body?.events || []).map((e) => ({ ...e, isDraft: false }));
        setEvents(page);
        setListing({
          total: body?.total || 0,
          grandTotal: body?.grand_total ?? body?.total ?? 0,
          counts: body?.counts || {},
          eventTypes: body?.event_types || [],
        });
        setKnownItems((previous) => new Map([...previous, ...page.map((item) => [item.id, item])]));
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === "AbortError") return;
        console.error("My Events error:", err);
        setError(err?.message || "Failed to load events.");
      })
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [profile, panel.api, listFilters, currentPage, paging.per, reloadKey]);

  // Drafts kept only in this browser, as rows.
  const localDrafts = useMemo(
    () => drafts.map((d) => ({ ...d, isDraft: true, status: "draft" })),
    [drafts],
  );

  const eventTypeOptions = useMemo(() => [...new Set([
    activeEventType,
    ...listing.eventTypes,
    ...localDrafts.map(eventTypeOf),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b)), [listing.eventTypes, localDrafts, activeEventType]);

  // --- Filtering the browser-only drafts, as the server filters the rest ---
  const matchingLocalDrafts = useMemo(() => {
    const matchesSearch = (item) => {
      if (!searchTerm) return true;
      const q = searchTerm.toLowerCase();
      const name = (item.event_name || item.eventName || "").toLowerCase();
      const venue = (item.location || "").toLowerCase();
      const { meta } = decodeEventMetadata(item.description || "");
      const dept = (item.department || meta.department || "").toLowerCase();
      return name.includes(q) || venue.includes(q) || dept.includes(q);
    };

    const matchesDate = (item) => {
      if (dateFilter === "all_time") return true;
      const eventDateStr = item.event_date || item.eventDate;
      if (!eventDateStr) return false;

      if (dateFilter === "today") {
        return eventDateStr === localDateKey();
      }

      if (dateFilter === "this_week") {
        // Compare local calendar keys: new Date("YYYY-MM-DD") is UTC midnight.
        const day = new Date().getDay();
        const sinceMonday = day === 0 ? 6 : day - 1;
        const mondayKey = localDateKeyOffset(-sinceMonday);
        const sundayKey = localDateKeyOffset(6 - sinceMonday);
        const key = String(eventDateStr).slice(0, 10);
        return key >= mondayKey && key <= sundayKey;
      }

      if (dateFilter === "this_month") {
        return String(eventDateStr).slice(0, 7) === localDateKey().slice(0, 7);
      }

      if (dateFilter === "custom") {
        if (customFromDate && eventDateStr < customFromDate) return false;
        if (customToDate && eventDateStr > customToDate) return false;
        return true;
      }

      return true;
    };

    // Evaluates combination of Search + Date Filter (AND logic); a browser
    // draft is in the All and Draft tabs only.
    return localDrafts.filter(
      (item) => (!activeEventType || eventTypeOf(item) === activeEventType)
        && matchesSearch(item) && matchesDate(item)
    );
  }, [localDrafts, searchTerm, activeEventType, dateFilter, customFromDate, customToDate]);
  const localInTab = activeFilter === "all" || activeFilter === "draft" ? matchingLocalDrafts : [];

  // Tab counts come from the server, under the same filters as the list;
  // browser drafts are added to All and Draft.
  const tabCounts = {
    ...listing.counts,
    all: (listing.counts.all || 0) + matchingLocalDrafts.length,
    draft: (listing.counts.draft || 0) + matchingLocalDrafts.length,
  };

  // Browser drafts open the first page; the server's page follows.
  const pageItems = [...(currentPage === 1 ? localInTab : []), ...events];
  const matchingCount = listing.total + localInTab.length;

  const canDeleteItem = (item) => item.isDraft || canTeacherEditEvent(item);

  // ---- Select, then submit / report / delete ------------------------------
  // Every row can be selected, in both panels. Submit covers the drafts saved
  // on the server (a browser-only draft still lacks required details or its
  // files); Delete covers what the owner may still delete (every event for an
  // Event Manager; drafts and not-yet-approved events for a teacher); a report
  // covers the Event Manager's recorded events.
  const selectable = () => true;
  const reportable = (item) => panel.reports && !eventReportRestriction(item);
  const visibleSelectable = pageItems.map((item) => item.id);
  const allVisibleSelected =
    visibleSelectable.length > 0 && visibleSelectable.every((id) => selected.has(id));
  const selectedItems = [...selected]
    .map((id) => knownItems.get(id) || localDrafts.find((item) => item.id === id))
    .filter(Boolean);
  const draftSelectedItems = selectedItems.filter(
    (item) => item.isDraft || String(item.status || "").toLowerCase() === "draft",
  );
  const hasDraftSelected = draftSelectedItems.length > 0;
  const reportSelectionReason = selectedReportsRestriction(selectedItems);
  const selectedIds = selectedItems.filter(reportable).map((item) => item.id);
  const deletableSelected = panel.approval ? selectedItems.filter(canDeleteItem) : selectedItems;
  const submittableSelected = selectedItems.filter((item) => item.status === "draft" && !item.isDraft);
  const browserOnlySelected = selectedItems.filter((item) => item.isDraft);
  const submitVerb = panel.approval ? "Submit" : "Record";

  const toggleSelected = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((current) => {
      const next = new Set(current);
      visibleSelectable.forEach((id) => (allVisibleSelected ? next.delete(id) : next.add(id)));
      return next;
    });

  const handleReportOne = (item) => {
    const reason = eventReportRestriction(item);
    if (reason) { setError(reason); return; }
    setError("");
    setCustomizingReport({ type: "single", item });
  };

  const handleReportSelected = () => {
    if (hasDraftSelected) {
      setDraftReportAlertOpen(true);
      return;
    }
    if (reportSelectionReason) { setError(reportSelectionReason); return; }
    if (selectedIds.length > MAX_EVENTS_PER_REPORT) {
      setError(`A report can cover at most ${MAX_EVENTS_PER_REPORT} events; ${selectedIds.length} are selected.`);
      return;
    }
    // Keep the order the list shows them in.
    const ordered = pageItems.map((item) => item.id).filter((id) => selectedIds.includes(id));
    const rest = selectedIds.filter((id) => !ordered.includes(id));
    setError("");
    setCustomizingReport({
      type: "selected",
      eventIds: [...ordered, ...rest],
      count: selectedIds.length,
    });
  };

  const handleExecuteCustomReport = async (options) => {
    if (!customizingReport) return;
    try {
      if (customizingReport.type === "single") {
        const item = customizingReport.item;
        setReportingId(item.id);
        const outcome = await downloadEventReport(item.id, item.event_name, options);
        const notice = reportNotice(outcome, `Report for "${item.event_name}"`);
        if (notice) setSuccessMessage(notice);
      } else if (customizingReport.type === "selected") {
        setReportingId("selected");
        const outcome = await downloadEventsReport(customizingReport.eventIds, options);
        const notice = reportNotice(
          outcome,
          customizingReport.count === 1 ? "Report" : `Report for ${customizingReport.count} events`,
        );
        if (notice) setSuccessMessage(notice);
      }
      setCustomizingReport(null);
    } catch (err) {
      setError(err?.message || "Could not generate the report.");
    } finally {
      setReportingId("");
    }
  };

  // Delete the selection: one request for the saved events, and the
  // browser-only drafts removed here. The list updates in place -- no refetch.
  const handleBulkDelete = async () => {
    const serverIds = deletableSelected.filter((item) => !item.isDraft).map((item) => item.id);
    const localIds = deletableSelected.filter((item) => item.isDraft).map((item) => item.id);
    try {
      setBulkDeleting(true);
      let deleted = localIds.length;
      if (serverIds.length) {
        const result = await bulkDeleteEvents(serverIds, panel.api);
        const gone = new Set(
          (result?.results || []).filter((r) => r.status === "deleted").map((r) => r.event_id),
        );
        deleted += gone.size;
        setEvents((prev) => prev.filter((e) => !gone.has(e.id)));
        reload();
        const refused = (result?.results || []).filter((r) => r.status === "skipped");
        if (refused.length) setError(skippedMessage(refused, "deleted"));
      }
      if (localIds.length && profile) {
        localIds.forEach((id) => deleteTeacherDraft(profile.id, id));
        setDrafts((prev) => prev.filter((d) => !localIds.includes(d.id)));
      }
      setSelected(new Set());
      setBulkDelete(null);
      setSuccessMessage(`${deleted} event${deleted === 1 ? "" : "s"} deleted permanently.`);
    } catch (err) {
      setError(err?.message || "Could not delete the selected events.");
      setBulkDelete(null);
    } finally {
      setBulkDeleting(false);
    }
  };

  const skippedMessage = (rows, what) =>
    `${rows.length} could not be ${what}: ` +
    rows
      .slice(0, 3)
      .map((r) => `"${r.event_name || "Untitled"}" (${r.reason})`)
      .join("; ") +
    (rows.length > 3 ? `; and ${rows.length - 3} more.` : ".");

  // Submit (teacher) or record (Event Manager) the selected saved drafts in
  // one request; the list is updated in place from the answer.
  const handleBulkSubmit = async () => {
    const ids = submittableSelected.map((item) => item.id);
    if (!ids.length) return;
    try {
      setBulkSubmitting(true);
      setError("");
      const result = await bulkSubmitDrafts(ids, { api: panel.api, approval: panel.approval });
      const doneStatus = panel.approval ? "submitted" : "recorded";
      const done = new Set(
        (result?.results || []).filter((r) => r.status === doneStatus).map((r) => r.event_id),
      );
      const newStatus = panel.approval ? "pending" : "recorded";
      setEvents((prev) => prev.map((e) => (done.has(e.id) ? { ...e, status: newStatus } : e)));
      setKnownItems((previous) => new Map([...previous].map(([id, item]) => [id, done.has(id) ? { ...item, status: newStatus } : item])));
      reload();
      setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
      setBulkSubmit(false);
      if (done.size) {
        setSuccessMessage(
          panel.approval
            ? `${done.size} event${done.size === 1 ? "" : "s"} submitted for approval.`
            : `${done.size} event${done.size === 1 ? "" : "s"} recorded.`,
        );
      }
      const refused = (result?.results || []).filter((r) => r.status !== doneStatus);
      if (refused.length) setError(skippedMessage(refused, panel.approval ? "submitted" : "recorded"));
    } catch (err) {
      setError(err?.message || `Could not ${submitVerb.toLowerCase()} the selected drafts.`);
      setBulkSubmit(false);
    } finally {
      setBulkSubmitting(false);
    }
  };

  const selectBox = (item) =>
    selectable(item) ? (
      <input
        type="checkbox"
        checked={selected.has(item.id)}
        onChange={() => toggleSelected(item.id)}
        aria-label={`Select ${item.event_name || item.eventName || "untitled draft"}`}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line text-accent focus:ring-accent"
      />
    ) : null;

  // ============================================================
  // MAIN UI
  //
  // The screen is height-locked: only the list body scrolls, so the
  // toolbar, the status chips and the column headers always stay put.
  // ============================================================

  return (
    <TeacherShell
      active="events"
      profile={profile}
      onLogout={handleLogout}
      railBadge={listing.grandTotal + localDrafts.length}
      railNote={
        panel.reports
          ? "Search and filter, tick events, then record, report on or delete them together."
          : "Filter and search, then tick drafts to submit or delete several at once."
      }
      locked
    >
      {/* Toasts sit bottom-right so feedback never shifts the layout or covers
          the filter controls. */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
        {error && (
          <div className="toast toast-err pointer-events-auto" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{error}</p>
            <button
              onClick={() => setError("")}
              aria-label="Dismiss error"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}

        {successMessage && (
          <div className="toast toast-ok pointer-events-auto" role="status">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
              <IconCheck className="h-3 w-3" />
            </span>
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{successMessage}</p>
            <button
              onClick={() => setSuccessMessage("")}
              aria-label="Dismiss message"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-5 lg:px-6 lg:py-6">

        {/* ================================================
            COMMAND BAR
            Title, search, date range, status chips and the
            primary action — every control on one screen.
        ================================================ */}
        <div className="glass shrink-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:px-5">

            <div className="mr-auto min-w-0">
              <p className="eyebrow">{panel.label}</p>
              <h1 className="h3 mt-0.5 truncate text-ink">My Events</h1>
            </div>

            {/* Search */}
            <div className="relative w-full sm:w-60 xl:w-72">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
                <IconSearch className="h-4 w-4" />
              </span>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, venue, or department…"
                aria-label="Search events"
                className="input pl-10 pr-9"
              />

              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted transition hover:text-ink"
                >
                  <IconX className="h-4 w-4" />
                </button>
              )}
            </div>

            {panel.role === "event_manager" && (
              <select
                value={activeEventType}
                onChange={(event) => {
                  const type = event.target.value;
                  setSearchParams((previous) => {
                    const next = new URLSearchParams(previous);
                    if (type) next.set("type", type);
                    else next.delete("type");
                    return next;
                  }, { replace: true });
                }}
                aria-label="Filter by event type"
                className="input w-full min-w-0 sm:w-auto sm:max-w-60"
              >
                <option value="">All event types</option>
                {eventTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            )}

            {/* Date range. A select rather than five chips: it carries the
                same five choices in one control instead of a whole row. */}
            <select
              value={dateFilter}
              onChange={(e) => {
                const val = e.target.value;
                setDateFilter(val);
                if (val === "custom") {
                  setShowDateRangeModal(true);
                }
              }}
              aria-label="Filter by date range"
              className="input w-full sm:w-auto"
            >
              {DATE_FILTERS.map((df) => (
                <option key={df.key} value={df.key}>
                  {df.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setShowDateRangeModal(true)}
              className={`btn btn-sm shrink-0 ${
                dateFilter === "custom" && (customFromDate || customToDate)
                  ? "btn-primary font-medium"
                  : "btn-ghost"
              }`}
              title="Set date range"
              aria-label="Set date range"
            >
              <IconCalendar />
              <span>
                {dateFilter === "custom" && customFromDate && customToDate
                  ? `${customFromDate} – ${customToDate}`
                  : dateFilter === "custom" && customFromDate
                    ? `From ${customFromDate}`
                    : dateFilter === "custom" && customToDate
                      ? `Until ${customToDate}`
                      : "Date Range"}
              </span>
            </button>

            {dateFilter === "custom" && (
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <input
                  type="date"
                  value={customFromDate}
                  onChange={(e) => setCustomFromDate(e.target.value)}
                  aria-label="From date"
                  className="input min-w-0 flex-1 sm:w-38 sm:flex-none"
                />
                <span className="text-xs text-muted">to</span>
                <input
                  type="date"
                  value={customToDate}
                  onChange={(e) => setCustomToDate(e.target.value)}
                  aria-label="To date"
                  className="input min-w-0 flex-1 sm:w-38 sm:flex-none"
                />
              </div>
            )}

            {/* The list as filtered here. Drafts kept only in this browser
                are not on the server, so they are not in the file. */}
            <DownloadExcelButton
              className="btn btn-ghost btn-sm shrink-0"
              disabled={listing.total === 0}
              onDownload={() => downloadMyEventsExcel(listFilters, { api: panel.api })}
              onError={setError}
              title="The events listed below, as an Excel file"
            />

            <Link
              to={`${panel.base}/create-event`}
              state={originState}
              className="btn btn-primary btn-sm shrink-0"
            >
              <IconPlus />
              <span className="hidden sm:inline">New Event</span>
            </Link>
          </div>

          {/* Status tabs + result count */}
          <div className="flex flex-wrap items-center gap-1.5 border-t hairline bg-raised/35 px-4 py-2.5 sm:px-5">
            {statusTabs.map((tab) => {
              const isSelected = activeFilter === tab.key;

              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleTabClick(tab.key)}
                  aria-selected={isSelected}
                  role="tab"
                  className="tab"
                >
                  {tab.label}
                  <span className="tab-count">{tabCounts[tab.key] || 0}</span>
                </button>
              );
            })}

            <div className="ml-auto flex flex-wrap items-center gap-3">
              {visibleSelectable.length > 0 && (
                <>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-ink">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label="Select every event on this page"
                      className="h-4 w-4 cursor-pointer rounded border-line text-accent focus:ring-accent"
                    />
                    Select all on this page
                  </label>
                  <button
                    type="button"
                    onClick={() => setBulkSubmit(true)}
                    disabled={submittableSelected.length === 0 || bulkSubmitting || Boolean(reportingId)}
                    className="btn btn-primary btn-xs"
                    title={
                      browserOnlySelected.length && !submittableSelected.length
                        ? "Drafts kept only in this browser need their details completed in the form first."
                        : undefined
                    }
                  >
                    {bulkSubmitting ? <span className="spin h-3 w-3" /> : <IconCheckCircle />}
                    {submittableSelected.length > 0
                      ? `${submitVerb} selected (${submittableSelected.length})`
                      : `${submitVerb} selected`}
                  </button>
                  {panel.reports && (
                    <button
                      type="button"
                      onClick={handleReportSelected}
                      disabled={selectedItems.length === 0 || Boolean(reportSelectionReason) || Boolean(reportingId)}
                      className="btn btn-brand btn-xs"
                    >
                      {reportingId === "selected" ? <span className="spin h-3 w-3" /> : <IconDownload />}
                      Download Report
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setBulkDelete({ confirmText: "" })}
                    disabled={deletableSelected.length === 0 || bulkDeleting || Boolean(reportingId)}
                    className="btn btn-danger btn-xs"
                  >
                    <IconTrash />
                    {deletableSelected.length > 0 ? `Delete selected (${deletableSelected.length})` : "Delete selected"}
                  </button>
                </>
              )}
              <p className="num text-xs font-medium text-muted">
                {matchingCount} matching of {listing.grandTotal + localDrafts.length} events
              </p>

              {isFiltered && (
                <button type="button" onClick={handleClearFilters} className="btn btn-ghost btn-xs">
                  <IconRotateCcw />
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ================================================
            EVENTS LIST
            Fills the remaining height; its body is the only
            scrolling region on the page.
        ================================================ */}
        <div className="glass relative flex min-h-0 flex-1 flex-col overflow-hidden">

          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface/70 backdrop-blur-[1px]">
              <div className="flex items-center gap-2.5 text-sm font-medium text-muted">
                <span className="spin h-4 w-4 text-accent" />
                Loading your events…
              </div>
            </div>
          )}

          {!loading && pageItems.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
              <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
                <IconInbox className="h-6 w-6" />
              </span>

              <p className="h3 text-ink">No events found.</p>

              <p className="prose-muted mt-1 text-sm">
                {isFiltered
                  ? "No events match the selected search keywords or filter criteria."
                  : "You haven't created any events yet."}
              </p>

              {isFiltered ? (
                <button type="button" onClick={handleClearFilters} className="btn btn-brand btn-sm mt-5">
                  <IconRotateCcw />
                  Clear filters
                </button>
              ) : (
                <Link
                  to={`${panel.base}/create-event`}
                  state={originState}
                  className="btn btn-primary btn-sm mt-5"
                >
                  <IconPlus />
                  Create an event
                </Link>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">

              {/* ------------------------------------------------
                  MOBILE: a table cannot show an event's context in
                  390px, so each event becomes a card instead.
              ------------------------------------------------ */}
              <ul className="divide-y divide-line/8 md:hidden">
                {pageItems.map((item) => {
                  const { meta } = decodeEventMetadata(item.description);
                  const department = item.department || meta.department;
                  const isRejected = isRefusedStatus(item.status);
                  const refusalReason = getRefusalReason(item);

                  return (
                    <li
                      key={item.id}
                      onClick={(event) => openEventRow(event, item)}
                      style={isRejected ? { "--track": trackOf(item.status) } : undefined}
                      className={`px-4 py-3.5 ${item.isDraft ? "" : "cursor-pointer"} ${isRejected ? "bg-[color-mix(in_srgb,var(--track)_6%,transparent)]" : ""}`}
                    >
                      <div className="flex items-start gap-2.5">
                        {selectBox(item)}
                        <p className="min-w-0 truncate font-display text-sm font-semibold text-ink">
                          {item.event_name || item.eventName || "Untitled Draft"}
                        </p>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
                        <StatusChip
                          status={item.status}
                          label={!panel.approval && item.status === "recorded" ? "Submitted" : undefined}
                        />
                        {/* Joined rather than separate spans so a wrap never
                            strands a lone separator at the end of a line. */}
                        <span>
                          {[
                            department,
                            item.event_type || item.eventType,
                            item.event_date || item.eventDate,
                            item.location,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Nothing set yet"}
                        </span>
                      </div>

                      {isRejected && refusalReason && (
                        <p className="mt-1.5 text-xs" style={{ color: trackOf(item.status) }}>
                          <span className="font-semibold">
                            {item.status === "revoked" ? "Revocation reason:" : "Rejection reason:"}
                          </span>{" "}
                          {refusalReason}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <EventActions
                          item={item}
                          canDelete={canDeleteItem(item)}
                          onDuplicate={handleDuplicate}
                          onDelete={setDeletingEvent}
                          originState={originState}
                          onReport={handleReportOne}
                          reporting={reportingId === item.id}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>

              <table className="hidden w-full text-left md:table">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {COLUMNS.map((column) => (
                      <th
                        key={column.label}
                        className={`whitespace-nowrap border-b hairline bg-raised/45 px-4 py-3 text-[11px] font-semibold uppercase tracking-[.12em] text-muted backdrop-blur ${column.className}`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-line/8">
                  {pageItems.map((item) => {
                    const { description: cleanDesc, meta } = decodeEventMetadata(item.description);
                    const department = item.department || meta.department;
                    const isRejected = isRefusedStatus(item.status);
                    const refusalReason = getRefusalReason(item);

                    return (
                      <tr
                        key={item.id}
                        onClick={(event) => openEventRow(event, item)}
                        style={isRejected ? { "--track": trackOf(item.status) } : undefined}
                        className={`group transition hover:bg-raised/35 ${item.isDraft ? "" : "cursor-pointer"} ${
                          isRejected ? "bg-[color-mix(in_srgb,var(--track)_5%,transparent)]" : ""
                        }`}
                      >
                        {/* Event name, with its context on one muted line */}
                        <td className="max-w-56 px-4 py-3 xl:max-w-80">
                          <div className="flex min-w-0 items-start gap-2.5">
                          {selectBox(item)}
                          <div className="min-w-0">
                          <p
                            className="truncate font-display text-sm font-semibold text-ink"
                            title={item.event_name || item.eventName || "Untitled Draft"}
                          >
                            {item.event_name || item.eventName || "Untitled Draft"}
                          </p>

                          <p className="truncate text-xs text-muted" title={cleanDesc || undefined}>
                            {department ? `${department} • ` : ""}
                            {cleanDesc || "No description"}
                          </p>

                          {isRejected && refusalReason && (
                            <p
                              className="line-clamp-2 text-xs"
                              style={{ color: trackOf(item.status) }}
                              title={refusalReason}
                            >
                              <span className="font-semibold">Reason:</span> {refusalReason}
                            </p>
                          )}
                          </div>
                          </div>
                        </td>

                        <td className="whitespace-nowrap px-4 py-3">
                          <StatusChip
                            status={item.status}
                            label={!panel.approval && item.status === "recorded" ? "Submitted" : undefined}
                          />
                        </td>

                        <td className="whitespace-nowrap px-4 py-3 text-sm text-muted">
                          {item.event_type || item.eventType || <NotSet />}
                        </td>

                        <td className="whitespace-nowrap px-4 py-3 text-sm text-muted">
                          {item.event_date || item.eventDate || <NotSet />}
                        </td>

                        <td className="hidden max-w-48 px-4 py-3 text-sm text-muted min-[1340px]:table-cell">
                          <span className="block truncate" title={item.location}>
                            {item.location || <NotSet />}
                          </span>
                        </td>

                        {/* Actions, pinned so they stay reachable */}
                        <td className="sticky right-0 whitespace-nowrap bg-surface px-4 py-3 shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.12)] transition group-hover:bg-raised/60">
                          <div className="flex items-center justify-end gap-1.5">
                            <EventActions
                              item={item}
                              canDelete={canDeleteItem(item)}
                              onDuplicate={handleDuplicate}
                              onDelete={setDeletingEvent}
                              originState={originState}
                              onReport={handleReportOne}
                              reporting={reportingId === item.id}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {listing.total > 0 && <Pagination
            page={currentPage} perPage={paging.per} total={listing.total} disabled={loading}
            onPageChange={(page) => setPaging({ ...paging, page })}
            onPerPageChange={(per) => setPaging({ ...paging, per, page: 1 })}
          />}
        </div>
      </div>

      {/* Draft report guard: branded in-app alert with the selected drafts. */}
      <Modal
        open={draftReportAlertOpen}
        onClose={() => setDraftReportAlertOpen(false)}
        eyebrow="Report not generated"
        title="Draft events selected"
        subtitle={`${draftSelectedItems.length} draft event${draftSelectedItems.length === 1 ? " is" : "s are"} in your selection`}
        footer={
          <button
            type="button"
            onClick={() => setDraftReportAlertOpen(false)}
            className="btn btn-brand btn-sm"
          >
            Review selection
          </button>
        }
      >
        <div className="flex items-start gap-3">
          <span
            className="icon-tile icon-tile-track shrink-0"
            style={{ "--track": trackOf("rejected") }}
          >
            <IconAlertTriangle />
          </span>
          <p className="text-sm leading-6 text-ink">
            Draft events cannot be included in the report. Please select only non-draft events to
            generate the report.
          </p>
        </div>
        <div className="mt-5 rounded-xl border hairline bg-raised/50 p-3">
          <p className="eyebrow mb-2">Drafts in your selection</p>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm text-ink">
            {draftSelectedItems.map((item) => (
              <li key={item.id} className="truncate">
                {item.event_name || item.eventName || "Untitled draft"}
              </li>
            ))}
          </ul>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deletingEvent)}
        onClose={() => !deletingLoading && setDeletingEvent(null)}
        eyebrow="Confirm"
        title="Delete Event"
        subtitle={
          deletingEvent?.isDraft
            ? "Draft event deletion"
            : panel.approval ? "Submitted event deletion" : "Recorded event deletion"
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeletingEvent(null)}
              disabled={deletingLoading}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deletingLoading}
              className="btn btn-danger btn-sm"
            >
              {deletingLoading && <span className="spin h-3.5 w-3.5" />}
              {deletingLoading ? "Deleting…" : "Delete Event"}
            </button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span className="icon-tile icon-tile-track" style={{ "--track": trackOf("rejected") }}>
            <IconAlertTriangle />
          </span>
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              {deletingEvent?.event_name || deletingEvent?.eventName || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              Venue: {deletingEvent?.location || "Not set"} · Date:{" "}
              {deletingEvent?.event_date || deletingEvent?.eventDate || "Not set"}
            </p>
          </div>
        </div>

        <p className="prose-muted mt-4 text-sm">
          Are you sure you want to delete this event? This will permanently remove it from
          your records.
        </p>
      </Modal>

      {/* Bulk delete: the same safeguard as the Dean's -- type DELETE. */}
      <Modal
        open={Boolean(bulkDelete)}
        onClose={() => !bulkDeleting && setBulkDelete(null)}
        eyebrow="Delete"
        title={`Delete ${deletableSelected.length} event${deletableSelected.length === 1 ? "" : "s"} permanently?`}
        subtitle={
          deletableSelected.length < selectedItems.length
            ? `${deletableSelected.length} of ${selectedItems.length} selected; approved events are kept`
            : `${selectedItems.length} selected`
        }
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setBulkDelete(null)}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleBulkDelete}
              disabled={bulkDeleting || bulkDelete?.confirmText !== "DELETE"}
            >
              {bulkDeleting ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
              Delete {deletableSelected.length} permanently
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This removes the selected events with their photos, videos and documents.
          It cannot be undone, and download links in reports already generated stop
          working.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border hairline bg-raised/40 px-3 py-2 text-xs text-ink">
          {deletableSelected.map((item) => (
            <li key={item.id} className="truncate">
              {item.event_name || item.eventName || "Untitled draft"}
            </li>
          ))}
        </ul>
        <div className="field mt-4">
          <label htmlFor="emBulkDeleteConfirm">
            Type <span className="font-semibold">DELETE</span> to confirm
          </label>
          <input
            id="emBulkDeleteConfirm"
            type="text"
            value={bulkDelete?.confirmText || ""}
            onChange={(event) => setBulkDelete({ confirmText: event.target.value })}
            autoComplete="off"
            placeholder="DELETE"
            className="input"
          />
        </div>
      </Modal>

      {/* Bulk submit / record: a short confirmation listing what goes. */}
      <Modal
        open={bulkSubmit}
        onClose={() => !bulkSubmitting && setBulkSubmit(false)}
        eyebrow={panel.approval ? "Submit for approval" : "Record"}
        title={
          panel.approval
            ? `Submit ${submittableSelected.length} draft${submittableSelected.length === 1 ? "" : "s"} for approval?`
            : `Record ${submittableSelected.length} draft${submittableSelected.length === 1 ? "" : "s"}?`
        }
        subtitle={`${submittableSelected.length} of ${selectedItems.length} selected`}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setBulkSubmit(false)}
              disabled={bulkSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBulkSubmit}
              disabled={bulkSubmitting || submittableSelected.length === 0}
            >
              {bulkSubmitting ? <span className="spin h-3.5 w-3.5" /> : <IconCheckCircle />}
              {submitVerb} {submittableSelected.length}
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {panel.approval
            ? "Each draft goes to the Dean for review, checked exactly as the form checks it: a draft missing a mandatory photo or document, or an unfinished detail, is left as a draft and the reason is shown."
            : "Each draft is recorded at once, checked exactly as the form checks it: a draft missing a mandatory photo or document, or an unfinished detail, is left as a draft and the reason is shown."}
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border hairline bg-raised/40 px-3 py-2 text-xs text-ink">
          {submittableSelected.map((item) => (
            <li key={item.id} className="truncate">
              {item.event_name || item.eventName || "Untitled draft"}
            </li>
          ))}
        </ul>
        {browserOnlySelected.length > 0 && (
          <p className="prose-muted mt-3 text-xs">
            {browserOnlySelected.length} draft{browserOnlySelected.length === 1 ? " is" : "s are"} kept only in
            this browser and still need{browserOnlySelected.length === 1 ? "s" : ""} their details completed in the
            form, so {browserOnlySelected.length === 1 ? "it is" : "they are"} not included.
          </p>
        )}
      </Modal>

      <ReportCustomizationModal
        open={Boolean(customizingReport)}
        onClose={() => !reportingId && setCustomizingReport(null)}
        onGenerate={handleExecuteCustomReport}
        generating={Boolean(reportingId)}
        eventName={
          customizingReport?.type === "single"
            ? customizingReport.item?.event_name || customizingReport.item?.eventName || ""
            : ""
        }
        isConsolidated={customizingReport?.type === "selected"}
        eventCount={customizingReport?.count || 1}
        eventIds={customizingReport?.type === "single" ? [customizingReport.item.id] : customizingReport?.eventIds || []}
        apiBase={panel.api}
        error={error}
      />

      <DateRangeModal
        open={showDateRangeModal}
        onClose={() => setShowDateRangeModal(false)}
        startDate={customFromDate}
        endDate={customToDate}
        onApply={({ startDate, endDate }) => {
          setCustomFromDate(startDate);
          setCustomToDate(endDate);
          setDateFilter("custom");
        }}
        onClear={() => {
          setCustomFromDate("");
          setCustomToDate("");
          setDateFilter("all_time");
        }}
      />
    </TeacherShell>
  );
}

const NotSet = () => <span className="italic text-muted/70">Not set</span>;

export default MyEvents;
