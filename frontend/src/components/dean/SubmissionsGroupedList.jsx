import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import StatusChip from "../teacher/StatusChip";
import Modal from "../teacher/Modal";
import ProgressTimeline from "../teacher/ProgressTimeline";
import { SubmitterLine } from "../common/submitter";
import readEventFields from "../../utils/eventFields";
import { formatDateRange, formatTime12h } from "../../utils/dates";
import {
  calculateGroupSelectionState,
  formatRowDate,
  getSubmissionsSummary,
  groupSubmissionsByDate,
  groupSubmissionsByStatus,
} from "../../utils/submissionGrouping";
import useEventReportDownload from "../../hooks/useEventReportDownload";
import {
  IconArrowRight,
  IconCalendar,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconDownload,
  IconEye,
  IconFileText,
  IconInbox,
  IconMapPin,
  IconRotateCcw,
  IconX,
} from "../teacher/icons";

/**
 * Accessible checkbox supporting checked, unchecked, and indeterminate states.
 */
function IndeterminateCheckbox({ checked, indeterminate, onChange, ariaLabel, id, title }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = Boolean(indeterminate);
    }
  }, [indeterminate]);

  return (
    <input
      id={id}
      ref={ref}
      type="checkbox"
      checked={Boolean(checked)}
      onChange={onChange}
      aria-label={ariaLabel}
      aria-checked={indeterminate ? "mixed" : checked}
      title={title || ariaLabel}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-line text-accent focus:ring-accent"
    />
  );
}

/**
 * Reusable Grouped submissions view for the Dean Dashboard and All Events.
 * Groups workshop/program submissions hierarchically: Year -> Month -> Items.
 *
 * Props:
 * - events: array of submission objects
 * - loading: boolean
 * - isFiltered: boolean
 * - onClearFilters: func
 * - selectedEventType: string
 * - title: string
 * - showReviewQueueLink: boolean
 * - warningBanner: ReactNode
 * - renderRowActions: (event, { isExpanded, isDownloading }) => ReactNode
 * - renderDrawerActions: (event) => ReactNode
 * - allowDecisions: boolean
 * - bulkActions: ({ selectedCount, selectedIds, selectedEvents, clearSelection }) => ReactNode
 * - selectedIds: Set (controlled selection from parent)
 * - onToggleSelect: (event) => void
 * - onToggleSelectGroup: (events) => void
 * - onClearSelection: () => void
 */
export default function SubmissionsGroupedList({
  events = [],
  loading = false,
  isFiltered = false,
  onClearFilters,
  selectedEventType = "",
  title = "Dean's Review Queue",
  showReviewQueueLink = true,
  warningBanner = null,
  renderRowActions = null,
  renderDrawerActions = null,
  allowDecisions = false,
  bulkActions = null,
  selectedIds: controlledSelectedIds = null,
  onToggleSelect = null,
  onToggleSelectGroup = null,
  onClearSelection = null,
  defaultExpanded = false,
}) {
  const [groupBy, setGroupBy] = useState("date"); // "date" | "status"
  const [internalSelectedIds, setInternalSelectedIds] = useState(() => new Set());
  const [expandedYears, setExpandedYears] = useState(() => new Set());
  const [expandedMonths, setExpandedMonths] = useState(() => new Set());
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const [showBulkViewModal, setShowBulkViewModal] = useState(false);
  const [bulkActionNotice, setBulkActionNotice] = useState("");

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
      setBulkActionNotice(downloadNotice);
      setDownloadNotice("");
    }
  }, [downloadNotice, setDownloadNotice]);

  useEffect(() => {
    if (downloadError) {
      setBulkActionNotice(downloadError);
      setDownloadError("");
    }
  }, [downloadError, setDownloadError]);

  // Use controlled selection if provided by parent, otherwise fall back to internal
  const effectiveSelectedIds = controlledSelectedIds || internalSelectedIds;

  // Derive grouped datasets
  const yearGroups = useMemo(() => groupSubmissionsByDate(events), [events]);
  const statusGroups = useMemo(() => groupSubmissionsByStatus(events), [events]);
  const summary = useMemo(() => getSubmissionsSummary(events), [events]);

  // Default expansion (only if defaultExpanded is explicitly true)
  const initialExpansionDoneRef = useRef(false);
  useEffect(() => {
    if (defaultExpanded && yearGroups.length > 0 && !initialExpansionDoneRef.current) {
      initialExpansionDoneRef.current = true;
      const currentCalendarYear = new Date().getFullYear();
      const currentYear = yearGroups.find((y) => y.year === currentCalendarYear) || yearGroups[0];
      setExpandedYears(new Set([currentYear.year]));
      const currentYearMonthKeys = currentYear.months.map((m) => m.monthKey);
      setExpandedMonths(new Set(currentYearMonthKeys));
    }
  }, [defaultExpanded, yearGroups]);

  // Map of event by ID for quick lookups
  const eventMap = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  // ============================================
  // SELECTION HANDLERS
  // ============================================

  const handleToggleSelectRow = (event) => {
    if (onToggleSelect) {
      onToggleSelect(event);
      return;
    }
    setInternalSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(event.id)) {
        next.delete(event.id);
      } else {
        next.add(event.id);
      }
      return next;
    });
  };

  const handleToggleSelectGroup = (items) => {
    if (!items || items.length === 0) return;

    if (onToggleSelectGroup) {
      onToggleSelectGroup(items);
      return;
    }

    const itemIds = items.map((it) => it.id);
    const { checked } = calculateGroupSelectionState(itemIds, effectiveSelectedIds);

    setInternalSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const id of itemIds) {
          next.delete(id);
        }
      } else {
        for (const id of itemIds) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    if (onClearSelection) {
      onClearSelection();
      return;
    }
    setInternalSelectedIds(new Set());
  };

  // ============================================
  // EXPANSION HANDLERS
  // ============================================

  const toggleExpandYear = (year) => {
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) {
        next.delete(year);
        // Also collapse its months when the year is collapsed
        const group = yearGroups.find((g) => g.year === year);
        if (group) {
          setExpandedMonths((mPrev) => {
            const mNext = new Set(mPrev);
            for (const m of group.months) {
              mNext.delete(m.monthKey);
            }
            return mNext;
          });
        }
      } else {
        next.add(year);
      }
      return next;
    });
  };

  const toggleExpandMonth = (monthKey) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(monthKey)) {
        next.delete(monthKey);
      } else {
        next.add(monthKey);
      }
      return next;
    });
  };

  const toggleExpandRow = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // ============================================
  // DOWNLOAD HANDLERS (Default fallback)
  // ============================================

  const handleDownloadSingle = async (event) => {
    if (!event) return;
    await downloadSingle(event);
  };

  const handleBulkDownload = async () => {
    if (selectedEventsList.length === 0) return;
    await downloadBulk(selectedEventsList);
  };

  // Selected items array for bulk modal
  const selectedEventsList = useMemo(() => {
    return events.filter((e) => effectiveSelectedIds.has(e.id));
  }, [events, effectiveSelectedIds]);

  // ============================================
  // RENDER: LOADING OR EMPTY
  // ============================================

  if (loading) {
    return (
      <div className="glass mt-4 flex items-center justify-center gap-3 p-12 text-sm font-medium text-muted">
        <span className="spin h-5 w-5 text-accent" />
        Loading submissions…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="glass mt-4 flex flex-col items-center px-6 py-16 text-center">
        <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
          <IconInbox className="h-6 w-6" />
        </span>
        <h3 className="h3 text-ink">No submissions yet</h3>
        <p className="prose-muted mt-1 text-sm">
          {isFiltered
            ? "No workshop or program submissions match the current filters."
            : "No submissions have been recorded yet."}
        </p>
        {isFiltered && onClearFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="btn btn-brand btn-sm mt-5"
          >
            <IconRotateCcw />
            Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Optional Warning Banner (e.g. 1000 cap reached) */}
      {warningBanner}

      {/* ------------------------------------------------------------------
          TOP-OF-PANEL TOOLBAR (matches Dinshaw's reference header)
          Summary on left · Group by pills & review queue link on right
      ------------------------------------------------------------------ */}
      <div className="glass flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-display font-semibold text-ink">
            {selectedEventType ? `${selectedEventType}` : title}
          </span>
          <span className="text-muted">·</span>
          <span className="font-medium text-muted">
            {summary.totalSubmissions} submission{summary.totalSubmissions !== 1 ? "s" : ""}
          </span>
          <span className="text-muted">·</span>
          <span className="font-medium text-muted">
            {summary.totalWorkshops} program{summary.totalWorkshops !== 1 ? "s" : ""}
          </span>
          <span className="text-muted">·</span>
          <span className="text-xs text-muted">
            Data through {summary.lastUpdatedFormatted}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Segmented Group By pill toggle */}
          <div className="flex items-center gap-1.5 rounded-lg border border-line/60 bg-raised/35 p-1 text-xs">
            <span className="px-1.5 font-medium text-muted">Group by</span>
            <button
              type="button"
              onClick={() => setGroupBy("date")}
              aria-pressed={groupBy === "date"}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                groupBy === "date"
                  ? "bg-surface font-semibold text-accent shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              Date
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("status")}
              aria-pressed={groupBy === "status"}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                groupBy === "status"
                  ? "bg-surface font-semibold text-accent shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              Status
            </button>
          </div>

          {showReviewQueueLink && (
            <Link
              to="/dean/events"
              className="btn btn-ghost btn-xs border border-line/70 font-medium text-ink"
              title="Open Dean review queue"
            >
              Review queue
              <IconArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Bulk action feedback notice */}
      {bulkActionNotice && (
        <div className="flex items-center justify-between rounded-xl border border-accent/20 bg-accent/8 px-4 py-2.5 text-xs text-ink">
          <span>{bulkActionNotice}</span>
          <button
            type="button"
            onClick={() => setBulkActionNotice("")}
            className="text-muted hover:text-ink"
            aria-label="Dismiss notice"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------
          VIEW MODE 1: GROUP BY DATE (Default: Year -> Month -> Items)
      ------------------------------------------------------------------ */}
      {groupBy === "date" && (
        <div className="space-y-6">
          {yearGroups.map((yearGroup) => {
            const isYearExpanded = expandedYears.has(yearGroup.year);
            const allYearItems = yearGroup.months.flatMap((m) => m.items);
            const allYearItemIds = allYearItems.map((it) => it.id);
            const yearSelection = calculateGroupSelectionState(allYearItemIds, effectiveSelectedIds);

            return (
              <section
                key={yearGroup.yearKey}
                className="space-y-3"
                aria-labelledby={`year-heading-${yearGroup.year}`}
              >
                {/* YEAR HEADER: Collapsible, select all checkbox, count badge */}
                <div className="flex items-center justify-between rounded-xl border border-line/60 bg-surface/75 px-4 py-2.5 shadow-2xs">
                  <div className="flex items-center gap-3">
                    <IndeterminateCheckbox
                      id={`year-checkbox-${yearGroup.year}`}
                      checked={yearSelection.checked}
                      indeterminate={yearSelection.indeterminate}
                      onChange={() => handleToggleSelectGroup(allYearItems)}
                      ariaLabel={`Select all submissions in year ${yearGroup.year}`}
                      title={`Select all in ${yearGroup.year}`}
                    />

                    <button
                      type="button"
                      onClick={() => toggleExpandYear(yearGroup.year)}
                      aria-expanded={isYearExpanded}
                      className="flex items-center gap-2 text-left font-display text-base font-bold text-ink transition hover:text-accent focus:outline-none focus:ring-1 focus:ring-accent rounded-sm"
                    >
                      <span className="text-muted">
                        {isYearExpanded ? (
                          <IconChevronDown className="h-4 w-4" />
                        ) : (
                          <IconChevronRight className="h-4 w-4" />
                        )}
                      </span>
                      <span id={`year-heading-${yearGroup.year}`}>
                        {yearGroup.year}
                      </span>
                    </button>

                    <span className="chip chip-track chip-sm text-xs font-semibold" style={{ "--track": "#0EA5E9" }}>
                      {yearGroup.count} submission{yearGroup.count !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <span className="text-xs text-muted">
                    {yearGroup.months.length} month{yearGroup.months.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* YEAR CONTENT: Rendered lazily when year is expanded */}
                {isYearExpanded && (
                  <div className="space-y-5 pl-2 sm:pl-4">
                    {yearGroup.months.map((monthGroup) => {
                      const isMonthExpanded = expandedMonths.has(monthGroup.monthKey);
                      const monthItemIds = monthGroup.items.map((it) => it.id);
                      const monthSelection = calculateGroupSelectionState(monthItemIds, effectiveSelectedIds);

                      return (
                        <div key={monthGroup.monthKey} className="space-y-2">
                          {/* MONTH SUB-HEADER:
                              Small, uppercase, bold, gray style matching reference
                              e.g. "OCTOBER 2026", "SEPTEMBER 2026"
                          */}
                          <div className="flex items-center justify-between px-1 py-1">
                            <div className="flex items-center gap-2.5">
                              <IndeterminateCheckbox
                                id={`month-checkbox-${monthGroup.monthKey}`}
                                checked={monthSelection.checked}
                                indeterminate={monthSelection.indeterminate}
                                onChange={() => handleToggleSelectGroup(monthGroup.items)}
                                ariaLabel={`Select all submissions in ${monthGroup.monthLabel}`}
                                title={`Select all in ${monthGroup.monthLabel}`}
                              />

                              <button
                                type="button"
                                onClick={() => toggleExpandMonth(monthGroup.monthKey)}
                                aria-expanded={isMonthExpanded}
                                className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted hover:text-ink transition focus:outline-none"
                              >
                                <span>{monthGroup.monthLabel}</span>
                                <span className="text-[11px] font-semibold text-muted">
                                  ({monthGroup.count})
                                </span>
                                <span className="text-muted ml-0.5">
                                  {isMonthExpanded ? (
                                    <IconChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <IconChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </span>
                              </button>
                            </div>
                          </div>

                          {/* BORDERED CARD:
                              Rendered when month is expanded (current year's months expanded by default)
                          */}
                          {isMonthExpanded && (
                            <div className="overflow-hidden rounded-xl border border-line/60 bg-surface shadow-xs divide-y divide-line/30">
                              {monthGroup.items.map((event) => (
                                <SubmissionRow
                                  key={event.id}
                                  event={event}
                                  isSelected={effectiveSelectedIds.has(event.id)}
                                  onToggleSelect={() => handleToggleSelectRow(event)}
                                  isExpanded={expandedRows.has(event.id)}
                                  onToggleExpand={() => toggleExpandRow(event.id)}
                                  onDownloadSingle={() => handleDownloadSingle(event)}
                                  isDownloading={downloadingRowId === event.id}
                                  canDownload={canDownload}
                                  renderRowActions={renderRowActions}
                                  renderDrawerActions={renderDrawerActions}
                                  allowDecisions={allowDecisions}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------------------------
          VIEW MODE 2: GROUP BY STATUS (Alternative grouping option)
      ------------------------------------------------------------------ */}
      {groupBy === "status" && (
        <div className="space-y-6">
          {statusGroups.map((group) => {
            const groupItemIds = group.items.map((it) => it.id);
            const selection = calculateGroupSelectionState(groupItemIds, effectiveSelectedIds);

            return (
              <section key={group.statusKey} className="space-y-2">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <div className="flex items-center gap-2.5">
                    <IndeterminateCheckbox
                      id={`status-checkbox-${group.statusKey}`}
                      checked={selection.checked}
                      indeterminate={selection.indeterminate}
                      onChange={() => handleToggleSelectGroup(group.items)}
                      ariaLabel={`Select all in ${group.statusLabel}`}
                    />
                    <span className="text-xs font-bold uppercase tracking-wider text-muted">
                      {group.statusLabel}
                    </span>
                    <span className="text-xs font-semibold text-muted">
                      ({group.count})
                    </span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-line/60 bg-surface shadow-xs divide-y divide-line/30">
                  {group.items.map((event) => (
                    <SubmissionRow
                      key={event.id}
                      event={event}
                      isSelected={effectiveSelectedIds.has(event.id)}
                      onToggleSelect={() => handleToggleSelectRow(event)}
                      isExpanded={expandedRows.has(event.id)}
                      onToggleExpand={() => toggleExpandRow(event.id)}
                      onDownloadSingle={() => handleDownloadSingle(event)}
                      isDownloading={downloadingRowId === event.id}
                      canDownload={canDownload}
                      renderRowActions={renderRowActions}
                      renderDrawerActions={renderDrawerActions}
                      allowDecisions={allowDecisions}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------------------------
          STICKY BULK-ACTION BAR
          When >= 1 row is selected
      ------------------------------------------------------------------ */}
      {effectiveSelectedIds.size > 0 && (
        <aside
          aria-label="Bulk actions for selected submissions"
          className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 transform animate-in fade-in slide-in-from-bottom-4 duration-200"
        >
          <div className="flex items-center gap-3 rounded-2xl border border-line/80 bg-surface/95 px-5 py-3 shadow-xl backdrop-blur-md">
            <span className="text-sm font-semibold text-ink whitespace-nowrap">
              {effectiveSelectedIds.size} selected
            </span>

            <span className="text-muted">·</span>

            {/* Custom bulk actions if provided, otherwise default View/Download/Clear */}
            {bulkActions ? (
              bulkActions({
                selectedCount: effectiveSelectedIds.size,
                selectedIds: effectiveSelectedIds,
                selectedEvents: selectedEventsList,
                clearSelection: handleClearSelection,
              })
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setShowBulkViewModal(true)}
                  className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink inline-flex items-center gap-1.5"
                >
                  <IconEye className="h-3.5 w-3.5" />
                  View
                </button>

                <button
                  type="button"
                  onClick={handleBulkDownload}
                  disabled={isBulkDownloading}
                  className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink inline-flex items-center gap-1.5"
                  title="Download report for selected events"
                >
                  {isBulkDownloading ? (
                    <span className="spin h-3.5 w-3.5" />
                  ) : (
                    <IconDownload className="h-3.5 w-3.5" />
                  )}
                  <span>{downloadProgress || "Download"}</span>
                </button>

                <span className="text-muted">·</span>

                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="btn btn-ghost btn-xs text-muted hover:text-ink font-medium"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </aside>
      )}

      {/* ------------------------------------------------------------------
          BULK VIEW MODAL: Review Selected Submissions (Default fallback)
      ------------------------------------------------------------------ */}
      <Modal
        open={showBulkViewModal}
        onClose={() => setShowBulkViewModal(false)}
        eyebrow="Review Selection"
        title={`Selected Submissions (${selectedEventsList.length})`}
        subtitle="Quick overview of the submissions you selected."
        wide
        footer={
          <div className="flex items-center justify-between w-full">
            <button
              type="button"
              onClick={handleClearSelection}
              className="btn btn-ghost btn-sm"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={() => setShowBulkViewModal(false)}
              className="btn btn-brand btn-sm"
            >
              Done
            </button>
          </div>
        }
      >
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {selectedEventsList.map((item) => (
            <div
              key={item.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-line/60 bg-raised/20 p-4 transition hover:bg-raised/40"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-ink truncate">
                    {item.event_name}
                  </span>
                  <StatusChip status={item.status} size="sm" />
                </div>
                <p className="text-xs text-muted">
                  {formatRowDate(item.event_date || item.start_date || item.created_at)} · {item.event_type || "Event"} · {readEventFields(item).department}
                </p>
                <div className="text-xs text-muted">
                  <SubmitterLine event={item} />
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Link
                  to={`/dean/events/${item.id}`}
                  className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink inline-flex items-center gap-1"
                >
                  <IconEye className="h-3.5 w-3.5" />
                  Open
                </Link>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/**
 * Individual Submission Row matching the Dinshaw's visual reference:
 * Left to right:
 * [Checkbox] [Chevron] [Bold Date + Title + Subtitle] [Short Status Text] [Actions]
 */
function SubmissionRow({
  event,
  isSelected,
  onToggleSelect,
  isExpanded,
  onToggleExpand,
  onDownloadSingle,
  isDownloading,
  canDownload,
  renderRowActions,
  renderDrawerActions,
  allowDecisions,
}) {
  const fields = useMemo(() => readEventFields(event), [event]);
  const dateFormatted = formatRowDate(
    event.event_date || event.start_date || event.created_at
  );

  const reportCheck = canDownload ? canDownload(event) : { canDownload: true };

  return (
    <div className="group transition-colors hover:bg-raised/20">
      {/* ------------------------------------------------
          PRIMARY ROW (Matches reference layout)
      ------------------------------------------------ */}
      <div className="flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5">
        {/* 1. Checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          aria-label={`Select submission ${event.event_name}`}
          className="h-4 w-4 shrink-0 cursor-pointer rounded border-line text-accent focus:ring-accent"
        />

        {/* 2. Expand/collapse chevron */}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label={`Toggle full details for ${event.event_name}`}
          className="p-1 text-muted transition-transform duration-200 hover:text-ink focus:outline-none focus:ring-1 focus:ring-accent rounded-sm"
        >
          {isExpanded ? (
            <IconChevronDown className="h-4 w-4 text-ink" />
          ) : (
            <IconChevronRight className="h-4 w-4 text-muted group-hover:text-ink" />
          )}
        </button>

        {/* 3. Bold date + Workshop/Program title + secondary details */}
        <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
          <span className="whitespace-nowrap font-bold text-ink text-sm">
            {dateFormatted}
          </span>

          <div className="flex min-w-0 items-center gap-2">
            <span
              className="truncate font-semibold text-ink text-sm hover:text-accent cursor-pointer"
              onClick={onToggleExpand}
              title={event.event_name}
            >
              {event.event_name}
            </span>

            {/* Muted details line */}
            <span className="hidden truncate text-xs text-muted md:inline">
              · {event.event_type || "Program"} · {fields.department}
            </span>
          </div>
        </div>

        {/* 4. Short status text in muted/accent colors */}
        <div className="shrink-0">
          <StatusChip status={event.status} size="sm" />
        </div>

        {/* 5. Right side action buttons */}
        {renderRowActions ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {renderRowActions(event, { isExpanded, isDownloading, canDownload })}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to={`/dean/events/${event.id}`}
              className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink hover:bg-raised/60 inline-flex items-center gap-1.5"
              title="View submission details"
            >
              <IconEye className="h-3.5 w-3.5 text-muted" />
              <span>View</span>
            </Link>

            <button
              type="button"
              onClick={onDownloadSingle}
              disabled={isDownloading || !reportCheck.canDownload}
              className={`hidden sm:inline-flex btn btn-ghost btn-xs border border-line/80 font-medium ${
                !reportCheck.canDownload
                  ? "opacity-45 cursor-not-allowed text-muted"
                  : "text-ink hover:bg-raised/60"
              } items-center gap-1.5`}
              title={reportCheck.reason || "Download report"}
              aria-label={`Download report for ${event.event_name}`}
            >
              {isDownloading ? (
                <span className="spin h-3.5 w-3.5" />
              ) : (
                <IconDownload className="h-3.5 w-3.5 text-muted" />
              )}
              <span>Report</span>
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------
          EXPANDED ACCORDION: FULL SUBMISSION DETAILS
      ------------------------------------------------ */}
      {isExpanded && (
        <div className="border-t border-line/40 bg-raised/15 px-6 py-5 space-y-5 animate-in fade-in duration-150">
          {/* Header & Department */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h4 className="font-display text-base font-bold text-ink">
                {event.event_name}
              </h4>
              <p className="text-xs text-muted">
                Department: <span className="font-medium text-ink">{fields.department}</span>
                {fields.organizer ? ` · Organizer: ${fields.organizer}` : ""}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                to={`/dean/events/${event.id}`}
                className="btn btn-brand btn-xs"
              >
                Open Full Review Page
                <IconArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          {/* Grid: Submitter, Schedule, Venue */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 rounded-xl border border-line/50 bg-surface/80 p-4 text-xs">
            <div className="space-y-1">
              <p className="text-muted font-medium flex items-center gap-1.5">
                <IconCalendar className="h-3.5 w-3.5 text-accent" />
                Date & Time
              </p>
              <p className="font-semibold text-ink">
                {formatDateRange(event.event_date || event.start_date, event.end_date)}
              </p>
              {(fields.startTime || fields.endTime) && (
                <p className="text-muted flex items-center gap-1">
                  <IconClock className="h-3 w-3" />
                  {formatTime12h(fields.startTime)} – {formatTime12h(fields.endTime)}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-muted font-medium flex items-center gap-1.5">
                <IconMapPin className="h-3.5 w-3.5 text-accent" />
                Location & Venue
              </p>
              <p className="font-semibold text-ink">
                {event.location || "On Campus"}
              </p>
              <p className="text-muted">Type: {event.event_type || "Standard"}</p>
            </div>

            <div className="space-y-1">
              <p className="text-muted font-medium">Faculty / Submitter</p>
              <SubmitterLine event={event} />
            </div>
          </div>

          {/* Description if present */}
          {fields.description && (
            <div className="rounded-xl border border-line/40 bg-surface/50 p-3.5 text-xs">
              <p className="font-medium text-muted mb-1">Description / Summary</p>
              <p className="text-ink leading-relaxed whitespace-pre-line">
                {fields.description}
              </p>
            </div>
          )}

          {/* Documents Section */}
          <div className="rounded-xl border border-line/50 bg-surface/60 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <IconFileText className="h-4 w-4 text-accent" />
              Attached Documents & Files
            </div>

            {Array.isArray(event.documents) && event.documents.length > 0 ? (
              <ul className="divide-y divide-line/30 text-xs">
                {event.documents.map((doc, idx) => (
                  <li key={doc.id || idx} className="flex items-center justify-between py-2">
                    <span className="font-medium text-ink truncate">
                      {doc.filename || doc.name || `Document #${idx + 1}`}
                    </span>
                    {doc.url && (
                      <a
                        href={doc.url}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-ghost btn-xs text-accent"
                      >
                        Download
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">
                No supplemental documents attached to this submission.
              </p>
            )}
          </div>

          {/* Status History & Audit Trail */}
          <div className="space-y-2">
            <h5 className="text-xs font-semibold text-ink flex items-center gap-1.5">
              <IconClock className="h-3.5 w-3.5 text-accent" />
              Submission Review History
            </h5>
            <div className="rounded-xl border border-line/50 bg-surface/80 p-4">
              <ProgressTimeline event={event} perspective="dean" />
            </div>
          </div>

          {/* Optional decision actions in drawer */}
          {(allowDecisions || renderDrawerActions) && renderDrawerActions && (
            <div className="pt-3 border-t border-line/30 flex flex-wrap items-center gap-2">
              {renderDrawerActions(event)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
