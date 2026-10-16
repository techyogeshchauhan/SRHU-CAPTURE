import { Link } from "react-router-dom";

import { formatEventDay } from "../../utils/dates";
import { recordFacts } from "../../utils/research";
import { IconSparkle } from "../teacher/icons";
import CategoryIcon from "./CategoryIcon";
import { OutcomeChip, VerificationChip } from "./ResearchChips";

const ORDER = ["journal", "conference", "patent", "book", "other"];

function when(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function RecordCard({ record, category, to, highlight, showStatus }) {
  const displayCategory = category || record.category_definition;
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="icon-tile h-8 w-8 rounded-lg">
          <CategoryIcon category={record.category} className="h-3.5 w-3.5" />
        </span>
        <OutcomeChip category={displayCategory} outcome={record.outcome_status} />
        {showStatus && record.verification_status !== "verified" && <VerificationChip status={record.verification_status} />}
        {highlight && (
          <span className="chip chip-sm chip-track" style={{ "--track": "var(--series-4)" }}>
            <IconSparkle className="h-3 w-3" />
            Highlight
          </span>
        )}
      </span>
      <span className="mt-2 block font-semibold leading-snug text-ink">{record.title}</span>
      <span className="prose-muted mt-1 block text-xs">{recordFacts(record)}</span>
      <span className="mt-2 flex flex-wrap gap-x-2 text-xs">
        <span className="font-medium text-ink">{record.faculty?.name}</span>
        {record.record_date && <span className="num text-muted">· {formatEventDay(record.record_date)}</span>}
      </span>
    </>
  );
  const className = `block h-full rounded-2xl border p-4 transition ${highlight ? "bg-raised/40" : ""} hairline ${
    to ? "hover:border-accent/40 hover:bg-accent/5" : ""
  }`;
  // A highlight is ringed in the same hue as its badge.
  const style = highlight ? { boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--series-4) 55%, transparent)" } : undefined;
  return to ? (
    <Link to={to} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/**
 * A showcase as the Dean sees it: the narrative, the headline numbers, the
 * highlighted records, then every record under its category.
 *
 * `recordLink(record)` gives each card its link (the viewer's own record
 * page), or null for none. `showStatus` flags records no longer verified,
 * for the author's preview.
 */
export default function ShowcaseView({ showcase, categories = [], recordLink, showStatus = false }) {
  const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
  const records = showcase.records || [];
  const legacyKeys = [...new Set(records.map((record) => record.category).filter((key) => !ORDER.includes(key)))];
  const highlights = new Set(showcase.highlight_ids || []);
  const chosen = records.filter((r) => highlights.has(r.id));
  const stats = showcase.stats || {};
  const faculty = new Set(records.map((r) => r.faculty_id)).size;

  return (
    <article className="space-y-6">
      <header className="glass p-6 sm:p-8">
        <p className="eyebrow">Research Showcase</p>
        <h2 className="hero-title mt-2 text-2xl uppercase text-ink sm:text-3xl">{showcase.title}</h2>
        <p className="prose-muted mt-2 text-sm">
          Presented by <span className="font-medium text-ink">{showcase.owner_name}</span>
          {showcase.sent_at && ` · sent ${when(showcase.sent_at)}`} · {records.length}{" "}
          {records.length === 1 ? "record" : "records"} · {faculty} faculty {faculty === 1 ? "member" : "members"}
        </p>
        {showcase.description && (
          <div className="mt-5 max-w-3xl space-y-3 text-[15px] leading-relaxed text-ink">
            {showcase.description.split(/\n{2,}/).map((para, i) => (
              <p key={i} className="whitespace-pre-line">
                {para}
              </p>
            ))}
          </div>
        )}
        <dl className="mt-6 flex flex-wrap gap-2">
          {ORDER.filter((key) => stats.by_category?.[key]).map((key) => (
            <div key={key} className="chip gap-2">
              <CategoryIcon category={key} className="h-3.5 w-3.5" />
              <dt className="text-muted">{byKey[key]?.short || key}</dt>
              <dd className="num font-semibold text-ink">{stats.by_category[key]}</dd>
            </div>
          ))}
          {stats.patents?.granted ? (
            <div className="chip gap-2">
              <dt className="text-muted">Patents granted</dt>
              <dd className="num font-semibold text-ink">{stats.patents.granted}</dd>
            </div>
          ) : null}
        </dl>
      </header>

      {chosen.length > 0 && (
        <section>
          <h3 className="h3 mb-3 text-base text-ink">Highlights</h3>
          <ul className="grid list-none gap-3 p-0 md:grid-cols-2">
            {chosen.map((record) => (
              <li key={record.id}>
                <RecordCard record={record} category={byKey[record.category]} to={recordLink?.(record)} highlight showStatus={showStatus} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {ORDER.map((key) => {
        const rows = records.filter((r) => r.category === key);
        if (!rows.length) return null;
        return (
          <section key={key}>
            <h3 className="h3 mb-3 flex items-center gap-2 text-base text-ink">
              <CategoryIcon category={key} />
              {byKey[key]?.label || key}
              <span className="text-sm font-normal text-muted">({rows.length})</span>
            </h3>
            <ul className="grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((record) => (
                <li key={record.id}>
                  <RecordCard
                    record={record}
                    category={byKey[record.category]}
                    to={recordLink?.(record)}
                    highlight={highlights.has(record.id)}
                    showStatus={showStatus}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {legacyKeys.map((key) => {
        const rows = records.filter((record) => record.category === key);
        const label = rows[0]?.category_label || rows[0]?.category_definition?.label || key;
        return (
          <section key={`legacy-${key}`}>
            <h3 className="h3 mb-3 flex items-center gap-2 text-base text-ink">
              <CategoryIcon category={key} />
              {label} (legacy records)
              <span className="text-sm font-normal text-muted">({rows.length})</span>
            </h3>
            <ul className="grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((record) => (
                <li key={record.id}>
                  <RecordCard
                    record={record}
                    category={record.category_definition}
                    to={recordLink?.(record)}
                    highlight={highlights.has(record.id)}
                    showStatus={showStatus}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {records.length === 0 && (
        <p className="prose-muted glass p-8 text-center text-sm">No verified records in this showcase.</p>
      )}
    </article>
  );
}
