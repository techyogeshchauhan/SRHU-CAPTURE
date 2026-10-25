import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { DEFAULT_PER_PAGE, PER_PAGE_OPTIONS } from "../../hooks/useTableQuery";

// `from` and `to`: a research-date range (the Dean's period filter).
// `faculty`: one faculty member's records (from the faculty-wise view).
const KEYS = ["q", "status", "category", "year", "from", "to", "faculty"];

/**
 * The research lists' filters and paging, held in the URL (as useTableQuery
 * does for events) so a filtered list can be linked and survives a reload.
 * Changing a filter returns to the first page.
 */
export default function useResearchQuery({ status: defaultStatus = "all", category: defaultCategory = "" } = {}) {
  const [params, setParams] = useSearchParams();

  const query = useMemo(() => {
    const page = Math.max(1, Number(params.get("page")) || 1);
    const rawPer = Number(params.get("per")) || DEFAULT_PER_PAGE;
    const per = PER_PAGE_OPTIONS.includes(rawPer) ? rawPer : DEFAULT_PER_PAGE;
    return {
      q: params.get("q") || "",
      status: params.get("status") || defaultStatus,
      category: params.has("category") ? params.get("category") || "" : defaultCategory,
      year: params.get("year") || "",
      from: params.get("from") || "",
      to: params.get("to") || "",
      faculty: params.get("faculty") || "",
      page,
      per,
      skip: (page - 1) * per,
    };
  }, [params, defaultStatus, defaultCategory]);

  const write = useCallback(
    (next, { replace = false } = {}) => {
      const out = new URLSearchParams();
      for (const key of KEYS) {
        const value = next[key];
        if (
          value &&
          !(key === "status" && value === defaultStatus) &&
          !(key === "category" && value === defaultCategory)
        ) {
          out.set(key, value);
        }
      }
      if (next.page > 1) out.set("page", String(next.page));
      if (next.per !== DEFAULT_PER_PAGE) out.set("per", String(next.per));
      setParams(out, { replace });
    },
    [setParams, defaultStatus, defaultCategory],
  );

  const setFilter = useCallback(
    (name, value, options) => write({ ...query, [name]: value, page: 1 }, options),
    [query, write],
  );
  // Several filters in one step (a period sets both ends of the range).
  const setFilters = useCallback(
    (patch, options) => write({ ...query, ...patch, page: 1 }, options),
    [query, write],
  );
  const setPage = useCallback((page) => write({ ...query, page: Math.max(1, page) }), [query, write]);
  const setPerPage = useCallback((per) => write({ ...query, per, page: 1 }), [query, write]);
  const reset = useCallback(
    () => write({ q: "", status: defaultStatus, category: "", year: "", from: "", to: "", faculty: "", page: 1, per: query.per }),
    [write, defaultStatus, query.per],
  );

  return { query, setFilter, setFilters, setPage, setPerPage, reset };
}
