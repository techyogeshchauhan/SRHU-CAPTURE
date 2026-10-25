import { useEffect, useState } from "react";

import { tabLabel, verificationMeta } from "../../utils/research";
import { IconSearch, IconX } from "../teacher/icons";

/**
 * Search, category, academic year and the verification tabs with their
 * counts -- the same bar on the authors' list and the Dean's.
 */
export default function ResearchFilters({
  query,
  setFilter,
  reset,
  tabs,
  counts = {},
  categories = [],
  years = [],
  searchLabel = "Search by title",
  searchPlaceholder = "Search titles…",
  defaultStatus = "all",
  // Per-panel names for a status -- the Event Manager's "Recorded".
  labels = {},
}) {
  // Typed freely, written to the URL once the typing pauses.
  const [draft, setDraft] = useState(query.q);
  useEffect(() => {
    if (draft === query.q) return undefined;
    const timer = setTimeout(() => setFilter("q", draft, { replace: true }), 350);
    return () => clearTimeout(timer);
  }, [draft, query.q, setFilter]);

  const active = Boolean(
    query.q || query.category || query.year || query.from || query.to || query.faculty || query.status !== defaultStatus,
  );

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 sm:px-5">
        <div className="relative min-w-0 flex-1 basis-56">
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
            <IconSearch className="h-4 w-4" />
          </span>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            className="input pl-10 pr-9"
          />
          {draft && (
            <button
              type="button"
              onClick={() => setDraft("")}
              aria-label="Clear search"
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          )}
        </div>

        <select
          value={query.category}
          onChange={(e) => setFilter("category", e.target.value)}
          aria-label="Filter by category"
          className="input min-w-0 flex-1 basis-40 sm:w-52 sm:flex-none"
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category.key} value={category.key}>
              {category.label}
            </option>
          ))}
        </select>

        <select
          value={query.year}
          onChange={(e) => setFilter("year", e.target.value)}
          aria-label="Filter by academic year"
          className="input min-w-0 flex-1 basis-32 sm:w-40 sm:flex-none"
        >
          <option value="">All years</option>
          {query.year && !years.includes(query.year) && <option value={query.year}>{query.year}</option>}
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>

        {active && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              reset();
            }}
            className="btn btn-ghost btn-sm shrink-0"
          >
            <IconX />
            Clear
          </button>
        )}
      </div>

      {/* No tabs given (the Dean's research list): no status row at all. */}
      {tabs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t hairline px-4 py-2.5 sm:px-5" role="tablist" aria-label="Research record filters">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={query.status === key}
              onClick={() => setFilter("status", key)}
              className="tab"
            >
              {key !== "all" && <span className="dot dot-sm" style={{ "--track": verificationMeta(key).track }} />}
              {labels[key] || tabLabel(key)}
              <span className="tab-count">{counts[key] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
