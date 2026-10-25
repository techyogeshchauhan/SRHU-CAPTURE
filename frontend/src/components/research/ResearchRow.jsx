import { Link } from "react-router-dom";

import { formatEventDay } from "../../utils/dates";
import { authorNames } from "../../utils/research";
import { trackOf } from "../teacher/status";
import { IconChevronRight, IconClock, IconCopy, IconFile } from "../teacher/icons";
import CategoryIcon from "./CategoryIcon";
import { OutcomeChip, VerificationChip } from "./ResearchChips";

/**
 * One research record in a list: what it is, whose it is, where it stands.
 * `showFaculty` for the Event Manager's and the Dean's lists, which span
 * every teacher. `leading` is an optional control before it (the Dean's
 * bulk-select checkbox). `showStatus={false}` leaves out the verification
 * chip (the Event Manager's submissions, as the Dean sees them).
 */
export default function ResearchRow({ record, category, to, showFaculty = false, leading = null, showStatus = true }) {
  const evidence = record.evidence?.length || 0;
  const faculty = authorNames(record);
  // A teacher's own list also holds work they co-authored with someone else.
  const coAuthored = Boolean(record.permissions?.co_author);
  const entered =
    record.created_by && record.created_by !== record.faculty_id && record.created_by_name
      ? `Entered by ${record.created_by_name}`
      : "";

  return (
    <li className="flex items-stretch border-b hairline last:border-b-0">
      {leading && <div className="flex items-center pl-4 sm:pl-5">{leading}</div>}
      <Link
        to={to}
        className="group flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 transition hover:bg-accent/5 sm:gap-4 sm:px-5"
      >
        <span className="icon-tile hidden h-10 w-10 shrink-0 rounded-xl sm:flex">
          <CategoryIcon category={record.category} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">
              {category?.short || record.category_label}
            </span>
            {showStatus && (
              <VerificationChip status={record.verification_status} recorded={record.recorded_by_manager} />
            )}
            <OutcomeChip category={category} outcome={record.outcome_status} />
            {record.reminders?.length > 0 && (
              <span className="chip chip-sm chip-track" style={{ "--track": trackOf("pending") }} title={record.reminders[0].message}>
                <IconClock className="h-3 w-3" />
                Update due
              </span>
            )}
            {record.duplicates?.length > 0 && (
              <span
                className="chip chip-sm chip-track"
                style={{ "--track": trackOf("under_review") }}
                title={`Also recorded: ${record.duplicates.map((d) => `${d.title} (${d.faculty_name})`).join("; ")}`}
              >
                <IconCopy className="h-3 w-3" />
                {record.duplicates.some((d) => d.same_faculty) ? "Possible duplicate" : "Also claimed"}
              </span>
            )}
          </span>
          <span className="mt-1 block truncate font-semibold text-ink transition group-hover:text-accent">
            {record.title}
          </span>
          <span className="prose-muted mt-0.5 flex flex-wrap gap-x-2 text-xs">
            {showFaculty && faculty && <span className="font-medium text-ink">{faculty}</span>}
            {!showFaculty && coAuthored && <span className="font-medium text-ink">Co-author · {faculty}</span>}
            {record.record_date && <span className="num">{formatEventDay(record.record_date)}</span>}
            {/* Research takes no uploads now; older records may still carry files. */}
            {evidence > 0 && (
              <span className="inline-flex items-center gap-1">
                <IconFile className="h-3 w-3" />
                {evidence} {evidence === 1 ? "file" : "files"}
              </span>
            )}
            {showFaculty && entered && <span>· {entered}</span>}
          </span>
        </span>

        <IconChevronRight className="h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </Link>
    </li>
  );
}
