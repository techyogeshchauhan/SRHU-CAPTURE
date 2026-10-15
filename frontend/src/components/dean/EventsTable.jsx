import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

import StatusChip from "../teacher/StatusChip";
import { trackOf } from "../teacher/status";
import { getRefusalReason, getStatusBucket } from "../../utils/constants";
import { IconInbox, IconRotateCcw } from "../teacher/icons";
import { SubmitterCell, SubmitterLine } from "../common/submitter";
import { getEventDepartmentName } from "../../utils/eventFields";

/**
 * The Dean's event list: a card list on narrow screens, a table on wide ones.
 *
 * Extracted from All Events so the Archive page shows the same rows with the
 * same columns rather than a second copy that slowly drifts — which is exactly
 * what happened to the three role shells.
 *
 * Actions are a render prop because they are the one part that genuinely
 * differs: All Events approves and rejects, the Archive restores and deletes.
 *
 * `selection` (optional) adds a checkbox per row and a select-all box in the
 * header: `{ isSelected(id), onToggle(event), allSelected, someSelected,
 * onToggleAll() }`. Without it the table is exactly as before.
 */

function SelectBox({ checked, indeterminate = false, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-line text-accent focus:ring-accent"
    />
  );
}

export const COLUMNS = [
  { label: "Event", className: "" },
  { label: "Submitted By", className: "" },
  { label: "Status", className: "" },
  { label: "Type", className: "" },
  { label: "Date", className: "" },
  { label: "Location", className: "hidden min-[1340px]:table-cell" },
  { label: "Action", className: "sticky right-0 text-right" },
];

function EventsTable({
  events,
  loading,
  renderActions,
  formatEventDate,
  emptyTitle = "No events found",
  emptyHint = "No events have been submitted yet.",
  onClearFilters,
  linkBase = "/dean/events",
  selection = null,
}) {
  return (
    <>
        {!loading && events.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconInbox className="h-6 w-6" />
            </span>

            <p className="h3 text-ink">{emptyTitle}</p>

            <p className="prose-muted mt-1 text-sm">{emptyHint}</p>

            {onClearFilters && (
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
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">

            {/* ------------------------------------------------
                MOBILE: a table cannot show a decision's context
                in 390px, so each event becomes a card instead.
            ------------------------------------------------ */}
            <ul className="divide-y divide-line/8 md:hidden">
              {events.map((event) => {
                const rejected = getStatusBucket(event.status) === "rejected";

                return (
                  <li
                    key={event.id}
                    style={rejected ? { "--track": trackOf(event.status) } : undefined}
                    className={`px-4 py-3.5 ${
                      rejected
                        ? "bg-[color-mix(in_srgb,var(--track)_6%,transparent)]"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {selection && (
                        <SelectBox
                          checked={selection.isSelected(event.id)}
                          onChange={() => selection.onToggle(event)}
                          label={`Select ${event.event_name || "event"}`}
                        />
                      )}
                      <Link
                        to={`${linkBase}/${event.id}`}
                        className="block w-full min-w-0 truncate text-left font-display text-sm font-semibold text-ink"
                        title={event.event_name}
                      >
                        {event.event_name || "Untitled Event"}
                      </Link>
                    </div>
                    <p className="mt-1 whitespace-normal break-words text-xs leading-5 text-muted">
                      {getEventDepartmentName(event)}
                    </p>
                    <SubmitterLine event={event} className="mt-1" />

                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
                      <StatusChip status={event.status} />
                      {/* Joined rather than separate spans so a wrap never
                          strands a lone separator at the end of a line. */}
                      <span>
                        {[
                          event.event_type,
                          formatEventDate(event.event_date),
                          event.location,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>

                    {rejected && getRefusalReason(event) && (
                      <p className="mt-1.5 text-xs" style={{ color: trackOf(event.status) }}>
                        <span className="font-semibold">Reason:</span>{" "}
                        {getRefusalReason(event)}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {renderActions(event)}
                    </div>
                  </li>
                );
              })}
            </ul>

            <table className="hidden w-full text-left md:table">
              <thead className="sticky top-0 z-10">
                <tr>
                  {selection && (
                    <th className="w-10 border-b hairline bg-raised/45 py-3 pl-4 pr-1 backdrop-blur">
                      <SelectBox
                        checked={selection.allSelected}
                        indeterminate={!selection.allSelected && selection.someSelected}
                        onChange={selection.onToggleAll}
                        label="Select all events on this page"
                      />
                    </th>
                  )}
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
                {events.map((event) => {
                  const rejected = getStatusBucket(event.status) === "rejected";

                  return (
                    <tr
                      key={event.id}
                      style={rejected ? { "--track": trackOf(event.status) } : undefined}
                      className={`group transition hover:bg-raised/35 ${
                        rejected
                          ? "bg-[color-mix(in_srgb,var(--track)_5%,transparent)]"
                          : ""
                      }`}
                    >
                      {selection && (
                        <td className="py-3 pl-4 pr-1 align-middle">
                          <SelectBox
                            checked={selection.isSelected(event.id)}
                            onChange={() => selection.onToggle(event)}
                            label={`Select ${event.event_name || "event"}`}
                          />
                        </td>
                      )}

                      {/* Event */}
                      <td className="max-w-56 px-4 py-3 xl:max-w-72">
                        <Link
                          to={`${linkBase}/${event.id}`}
                          title={event.event_name}
                          className="block max-w-full truncate text-left font-display text-sm font-semibold text-ink transition hover:text-accent"
                        >
                          {event.event_name || "Untitled Event"}
                        </Link>

                        <p className="mt-1 whitespace-normal break-words text-xs leading-5 text-muted">
                          {getEventDepartmentName(event)}
                        </p>

                        {rejected && getRefusalReason(event) && (
                          <p
                            title={getRefusalReason(event)}
                            className="max-w-full truncate text-xs"
                            style={{ color: trackOf(event.status) }}
                          >
                            <span className="font-semibold">Reason:</span>{" "}
                            {getRefusalReason(event)}
                          </p>
                        )}
                      </td>

                      {/* Submitted by: who sent it, and in which role */}
                      <td className="max-w-44 px-4 py-3">
                        <SubmitterCell event={event} />
                      </td>

                      {/* Status */}
                      <td className="whitespace-nowrap px-4 py-3">
                        <StatusChip status={event.status} />
                      </td>

                      {/* Type */}
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-muted">
                        {event.event_type || "—"}
                      </td>

                      {/* Date */}
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-muted">
                        {formatEventDate(event.event_date)}
                      </td>

                      {/* Location */}
                      <td className="hidden max-w-48 px-4 py-3 text-sm text-muted min-[1340px]:table-cell">
                        <span className="block truncate" title={event.location}>
                          {event.location || "—"}
                        </span>
                      </td>

                      {/* Action */}
                      <td className="sticky right-0 whitespace-nowrap bg-surface px-4 py-3 shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.12)] transition group-hover:bg-raised/60">
                        <div className="flex items-center justify-end gap-1.5">
                          {renderActions(event)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

export default EventsTable;
