import { formatEventDay } from "../../utils/dates";
import { formatFieldValue } from "../../utils/research";
import { IconExternalLink } from "../teacher/icons";

/** Everything the record says, as a definition list. Empty fields are left out. */
export default function ResearchFacts({ record, category }) {
  const rows = [
    { label: category?.date_label || "Date", value: record.record_date ? formatEventDay(record.record_date) : "" },
    { label: "Academic year", value: record.academic_year || "" },
    ...(category?.fields || []).map((field) => ({
      label: field.label,
      value: formatFieldValue(field, record.details?.[field.key]),
      wide: field.type === "textarea",
    })),
  ].filter((row) => row.value);

  return (
    <div>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className={row.wide ? "sm:col-span-2" : ""}>
            <dt className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">{row.label}</dt>
            <dd className="mt-0.5 whitespace-pre-line break-words text-sm text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>

      {record.abstract && (
        <div className="mt-5 border-t hairline pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Abstract / summary</p>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">{record.abstract}</p>
        </div>
      )}

      {record.link && (
        <a
          href={record.link}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost btn-xs mt-4 max-w-full"
        >
          <IconExternalLink />
          <span className="truncate">{record.link}</span>
        </a>
      )}
    </div>
  );
}
