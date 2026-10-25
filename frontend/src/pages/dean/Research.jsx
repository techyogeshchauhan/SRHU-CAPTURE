import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import DeanShell from "../../components/dean/DeanShell";
import DateRangeModal from "../../components/common/DateRangeModal";
import DownloadExcelButton from "../../components/common/DownloadExcelButton";
import Modal from "../../components/teacher/Modal";
import Pagination from "../../components/common/Pagination";
import PageHero from "../../components/teacher/PageHero";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconAward,
  IconCalendar,
  IconTrash,
  IconUsers,
} from "../../components/teacher/icons";
import FacultyFilterNotice from "../../components/research/FacultyFilterNotice";
import ResearchNav from "../../components/research/ResearchNav";
import ResearchFilters from "../../components/research/ResearchFilters";
import ResearchRow from "../../components/research/ResearchRow";
import useResearchQuery from "../../components/research/useResearchQuery";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { isAbortError } from "../../services/api";
import {
  deanBulkDeleteResearch,
  deanListResearch,
  deanResearchOverview,
  exportNaac,
  exportResearch,
} from "../../services/research";
import { GALLERY_PERIODS, periodOf, periodRange } from "../../utils/galleryAlbums";

// The Dean's lists. What the Event Manager submitted is recorded as it is,
// with no status and nothing to verify -- the page opens on it. A teacher's
// own submission waits for the Dean, who verifies it or sends it back from
// the record's page.
const SUBMITTED = "event_manager";
const DEAN_RESEARCH_TABS = [SUBMITTED, "submitted", "verified", "changes_requested", "rejected"];
const DEAN_RESEARCH_TAB_LABELS = {
  [SUBMITTED]: "Event Manager records",
  submitted: "Teacher submissions",
  verified: "Verified (teachers)",
  changes_requested: "Sent back",
};

/**
 * The Dean's research page: every record the Event Manager has submitted,
 * newest research date first, with a period filter, a category filter and
 * search. The filters live in the URL, so a filtered view can be shared.
 */
export default function Research() {
  const { category: routeCategory = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const recordsPath = "/dean/research";
  const { profile, logout } = useShellProfile();
  const { categories, byKey } = useResearchCategories();
  const { query, setFilter, setFilters, setPage, setPerPage, reset } = useResearchQuery({ status: SUBMITTED, category: routeCategory });
  // Anything else in the URL is not one of the Dean's lists.
  const view = DEAN_RESEARCH_TABS.includes(query.status) ? query.status : SUBMITTED;
  const setResearchFilter = useCallback((name, value, options) => {
    if (name !== "category") {
      setFilter(name, value, options);
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("category");
    params.delete("page");
    const path = value ? `${recordsPath}/category/${encodeURIComponent(value)}` : recordsPath;
    navigate(`${path}${params.size ? `?${params}` : ""}`, { replace: options?.replace });
  }, [location.search, navigate, recordsPath, setFilter]);
  const clearResearchFilters = useCallback(() => {
    if (routeCategory) {
      const params = new URLSearchParams();
      const per = new URLSearchParams(location.search).get("per");
      if (per) params.set("per", per);
      navigate(`${recordsPath}${params.size ? `?${params}` : ""}`);
      return;
    }
    reset();
  }, [location.search, navigate, recordsPath, reset, routeCategory]);

  const [data, setData] = useState(null);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showRange, setShowRange] = useState(false);
  const [selected, setSelected] = useState(() => new Map());
  const filterKey = `${view}|${query.category}|${query.year}|${query.q}|${query.from}|${query.to}|${query.faculty}|${query.skip}|${query.per}`;
  const [selectionFor, setSelectionFor] = useState(filterKey);
  if (selectionFor !== filterKey) {
    setSelectionFor(filterKey);
    setSelected(new Map());
  }
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const controllerRef = useRef(null);
  // Overview filters do not include pagination. Keep only this page's latest
  // summary request/result; paging can reuse it, even while it is in flight.
  const overviewRef = useRef(null);

  const invalidateOverview = useCallback(() => {
    overviewRef.current?.controller.abort();
    overviewRef.current = null;
  }, []);
  useEffect(() => invalidateOverview, [invalidateOverview]);

  // The page's filters as API parameters, shared by the list and figures.
  const filters = useMemo(
    () => ({
      category: query.category,
      academic_year: query.year,
      q: query.q,
      start_date: query.from,
      end_date: query.to,
      faculty_id: query.faculty,
    }),
    [query.category, query.year, query.q, query.from, query.to, query.faculty],
  );

  const load = useCallback(async ({ refreshOverview = false } = {}) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const key = JSON.stringify(filters);
      if (refreshOverview || overviewRef.current?.key !== key || overviewRef.current?.controller.signal.aborted) {
        invalidateOverview();
        const overviewController = new AbortController();
        const pending = {
          key, controller: overviewController,
          promise: deanResearchOverview(filters, { signal: overviewController.signal }),
        };
        overviewRef.current = pending;
        // Failed summaries are retryable; an older failure cannot evict a
        // newer filter's request. Unmount/filter changes cancel their reads.
        pending.promise.catch(() => {
          if (overviewRef.current === pending) overviewRef.current = null;
        });
      }
      const [list, figures] = await Promise.all([
        deanListResearch(
          { ...filters, status: view, skip: query.skip, limit: query.per },
          { signal: controller.signal },
        ),
        overviewRef.current.promise,
      ]);
      if (controller.signal.aborted) return;
      setData(list);
      setOverview(figures);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err?.message || "Research records could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filters, view, query.skip, query.per, invalidateOverview]);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const records = data?.records || [];
  const pageSelected = records.length > 0 && records.every((record) => selected.has(record.id));
  const selectedCategory = categories.find((category) => category.key === query.category);
  const period = periodOf(query.from, query.to);
  const rangeLabel =
    period !== "custom"
      ? "Custom range"
      : query.from && query.to
        ? `${query.from} – ${query.to}`
        : query.from
          ? `From ${query.from}`
          : `Until ${query.to}`;
  const downloads = (
    <>
      <DownloadExcelButton
        className="btn btn-ghost btn-sm shrink-0"
        onDownload={() => exportResearch({ ...filters, status: view }, { dean: true })}
        onError={setError}
        title="The records as filtered below, one sheet per category"
      />
      <DownloadExcelButton
        className="btn btn-ghost btn-sm shrink-0"
        label="NAAC Excel"
        onDownload={() => exportNaac(query.year, { dean: true })}
        onError={setError}
        title="Verified research in NAAC Criterion III format, for the chosen academic year"
      />
    </>
  );
  // The faculty-wise view, under the same period and year.
  const facultyWise = (() => {
    const params = new URLSearchParams();
    for (const [key, given] of [["year", query.year], ["from", query.from], ["to", query.to]]) {
      if (given) params.set(key, given);
    }
    return `${recordsPath}/faculty${params.size ? `?${params}` : ""}`;
  })();
  const dateRangeControls = (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Research date range">
        {GALLERY_PERIODS.filter((option) => option.key === "" || option.key === "month").map((option) => (
          <button
            key={option.key || "all"}
            type="button"
            role="tab"
            aria-selected={period === option.key}
            onClick={() => {
              const { startDate, endDate } = periodRange(option.key);
              setFilters({ from: startDate, to: endDate });
            }}
            className="tab"
          >
            {option.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setShowRange(true)}
        className={`btn btn-sm shrink-0 ${period === "custom" ? "btn-primary font-medium" : "btn-ghost"}`}
        title="Filter by research date range"
      >
        <IconCalendar />
        <span>{rangeLabel}</span>
      </button>
    </>
  );

  const toggleRecord = (record) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(record.id)) next.delete(record.id);
      else next.set(record.id, record.title);
      return next;
    });

  const togglePage = () =>
    setSelected((current) => {
      const next = new Map(current);
      for (const record of records) {
        if (pageSelected) next.delete(record.id);
        else next.set(record.id, record.title);
      }
      return next;
    });

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const body = await deanBulkDeleteResearch([...selected.keys()]);
      const skipped = body.skipped || [];
      const reasons = skipped.slice(0, 3).map((item) => `“${item.title || item.id}”: ${item.reason}`).join(" ");
      setNotice(body.message + (reasons ? ` ${reasons}${skipped.length > 3 ? ` …and ${skipped.length - 3} more.` : ""}` : ""));
      setSelected(new Map());
      setConfirmDelete(false);

      invalidateOverview();
      const deletedOnPage = records.filter((record) => (body.deleted || []).some((item) => item.id === record.id)).length;
      if (query.page > 1 && deletedOnPage === records.length) setPage(query.page - 1);
      else await load();
    } catch (err) {
      setError(err?.message || "The selected research records could not be deleted.");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DeanShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero
          compact
          title={routeCategory ? selectedCategory?.label || "Research" : "Faculty"}
          accent={routeCategory ? "Records" : "Research"}
          actions={!routeCategory && (
            <>
              {dateRangeControls}
              <Link to={facultyWise} className="btn btn-ghost btn-sm shrink-0" title="How much research each faculty member has">
                <IconUsers />
                Faculty-wise
              </Link>
              {downloads}
            </>
          )}
        >
          {routeCategory && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {dateRangeControls}
                {downloads}
              </div>
              <Link to={recordsPath} className="btn btn-ghost self-start sm:self-auto">
                Back to research page
              </Link>
            </div>
          )}
        </PageHero>
        <ResearchNav base="/dean/research" active="records" role="dean" />
        {query.faculty && (
          <FacultyFilterNotice
            name={records[0]?.faculty?.name}
            facultyWise={facultyWise}
            onClear={() => setFilter("faculty", "")}
          />
        )}

        <div className="mt-4">
          <ResearchFilters
            query={query}
            setFilter={setResearchFilter}
            reset={clearResearchFilters}
            tabs={DEAN_RESEARCH_TABS}
            labels={DEAN_RESEARCH_TAB_LABELS}
            counts={data?.counts}
            categories={categories}
            years={data?.academic_years || overview?.academic_years || []}
            defaultStatus={SUBMITTED}
            searchLabel="Search by title or teacher"
            searchPlaceholder="Search titles or teachers…"
          />
        </div>

        {notice && (
          <div className="toast toast-ok mt-4" role="status">
            <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{notice}</p>
            <button type="button" onClick={() => setNotice("")} className="btn btn-ghost btn-xs shrink-0">
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm text-ink">{error}</p>
            <button type="button" onClick={() => load({ refreshOverview: true })} className="btn btn-ghost btn-xs shrink-0">
              Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="flex h-60 items-center justify-center">
            <span className="spin h-9 w-9 text-accent" />
          </div>
        ) : records.length === 0 && !error ? (
          <div className="glass mt-5 flex flex-col items-center px-6 py-14 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconAward className="h-6 w-6" />
            </span>
            <p className="h3 text-ink">No research records here</p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              {view === SUBMITTED
                ? "Research the Event Manager submits appears here. Try another period, category or search."
                : view === "submitted"
                  ? "No teacher is waiting for your review. Records teachers submit themselves appear here."
                  : "Try another period, category or search."}
            </p>
          </div>
        ) : (
          <div className={`glass mt-5 overflow-hidden transition-opacity ${loading ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b hairline px-4 py-2.5 sm:px-5">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={pageSelected}
                  onChange={togglePage}
                  disabled={records.length === 0 || loading}
                  aria-label="Select  records on this page"
                  className="h-4 w-4 accent-accent"
                />
                Select all on this page
              </label>
              {selected.size > 0 && (
                <>
                  <span className="text-sm text-muted">{selected.size} selected</span>
                  <button type="button" onClick={() => setSelected(new Map())} className="text-sm font-medium text-muted hover:text-ink">
                    Clear
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-danger btn-xs ml-auto">
                    <IconTrash />
                    Delete {selected.size} selected
                  </button>
                </>
              )}
            </div>
            <ul className="list-none p-0">
              {records.map((record) => (
                <ResearchRow
                  key={record.id}
                  record={record}
                  category={byKey[record.category]}
                  to={`/dean/research/${record.id}`}
                  showFaculty
                  showStatus={view !== SUBMITTED}
                  leading={(
                    <input
                      type="checkbox"
                      checked={selected.has(record.id)}
                      onChange={() => toggleRecord(record)}
                      aria-label={`Select ${record.title}`}
                      className="h-4 w-4 accent-accent"
                    />
                  )}
                />
              ))}
            </ul>
            <div className="border-t hairline">
              <Pagination
                page={query.page}
                perPage={query.per}
                total={data?.total || 0}
                onPageChange={(page) => {
                  setPage(page);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onPerPageChange={setPerPage}
                disabled={loading}
              />
            </div>
          </div>
        )}
      </div>

      <DateRangeModal
        open={showRange}
        onClose={() => setShowRange(false)}
        startDate={query.from}
        endDate={query.to}
        onApply={({ startDate, endDate }) => setFilters({ from: startDate, to: endDate })}
        onClear={() => setFilters({ from: "", to: "" })}
      />

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        eyebrow="Delete research"
        title={`Delete ${selected.size} research ${selected.size === 1 ? "record" : "records"}?`}
        subtitle="This permanently deletes the selected records and their evidence files from the Dean’s research portfolio."
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn btn-ghost btn-sm">
              Cancel
            </button>
            <button type="button" onClick={deleteSelected} disabled={deleting || selected.size === 0} className="btn btn-danger btn-sm">
              {deleting ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete {selected.size}
            </button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {[...selected.values()].slice(0, 8).map((title, index) => <li key={`${title}-${index}`}>{title}</li>)}
          {selected.size > 8 && <li className="list-none text-muted">…and {selected.size - 8} more.</li>}
        </ul>
      </Modal>
    </DeanShell>
  );
}
