import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import Pagination from "../../components/common/Pagination";
import Modal from "../../components/teacher/Modal";
import PageHero from "../../components/teacher/PageHero";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { trackOf } from "../../components/teacher/status";
import { IconAlertTriangle, IconAward, IconCheckCircle, IconDownload, IconPlus, IconTrash } from "../../components/teacher/icons";
import ResearchFilters from "../../components/research/ResearchFilters";
import ResearchNav from "../../components/research/ResearchNav";
import { OutcomesDuePanel } from "../../components/research/ResearchNotices";
import ResearchRow from "../../components/research/ResearchRow";
import useResearchQuery from "../../components/research/useResearchQuery";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { isAbortError } from "../../services/api";
import {
  bulkRecordResearch,
  bulkDeleteResearch,
  deletableResearchIds,
  downloadResearchCv,
  exportResearch,
  listResearch,
} from "../../services/research";
import { AUTHOR_TABS, MANAGER_TAB_LABELS, MANAGER_TABS } from "../../utils/research";

/**
 * The research portfolio. Shared by both authoring panels:
 *
 * - Event Manager: every teacher's records -- the register they keep for the
 *   whole faculty. Search also finds a teacher by name.
 * - Teacher: their own records, including those an Event Manager entered.
 */
export default function Research() {
  const panel = usePanel();
  const manager = panel.role === "event_manager";
  const { category: routeCategory = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const recordsPath = `${panel.base}/research`;
  const { profile, logout } = useShellProfile();
  const { categories, byKey } = useResearchCategories();
  const { query, setFilter, setPage, setPerPage, reset } = useResearchQuery({ category: routeCategory });
  const setResearchFilter = useCallback((name, value, options) => {
    if (name !== "category" || !manager) {
      setFilter(name, value, options);
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("category");
    params.delete("page");
    const path = value ? `${recordsPath}/category/${encodeURIComponent(value)}` : recordsPath;
    navigate(`${path}${params.size ? `?${params}` : ""}`, { replace: options?.replace });
  }, [location.search, manager, navigate, recordsPath, setFilter]);
  const clearResearchFilters = useCallback(() => {
    if (manager && routeCategory) {
      const params = new URLSearchParams();
      const per = new URLSearchParams(location.search).get("per");
      if (per) params.set("per", per);
      navigate(`${recordsPath}${params.size ? `?${params}` : ""}`);
      return;
    }
    reset();
  }, [location.search, manager, navigate, recordsPath, reset, routeCategory]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const controllerRef = useRef(null);
  // Event Manager bulk actions share one selection across pages.
  const [selected, setSelected] = useState(() => new Map());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRecord, setConfirmRecord] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [notice, setNotice] = useState("");
  const [deletableTotal, setDeletableTotal] = useState(null);

  const run = async (name, task) => {
    setBusy(name);
    setError("");
    try {
      await task();
    } catch (err) {
      setError(err?.message || "The file could not be generated.");
    } finally {
      setBusy("");
    }
  };

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const body = await listResearch(
        {
          status: query.status,
          category: query.category,
          academic_year: query.year,
          q: query.q,
          skip: query.skip,
          limit: query.per,
        },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setData(body);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err?.message || "Research records could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [query.status, query.category, query.year, query.q, query.skip, query.per]);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  // A new filter is a new list: start the selection again.
  const filterKey = `${query.status}|${query.category}|${query.year}|${query.q}`;
  const [selectionFor, setSelectionFor] = useState(filterKey);
  if (selectionFor !== filterKey) {
    setSelectionFor(filterKey);
    setSelected(new Map());
    setDeletableTotal(null);
  }

  const records = data?.records || [];
  const selectedCategory = categories.find((category) => category.key === query.category);
  const deletable = manager ? records.filter((record) => record.permissions?.can_delete) : [];
  const selectedRecordable = [...selected.entries()].filter(([, item]) => item.canSubmit);
  const pageSelected = deletable.length > 0 && deletable.every((record) => selected.has(record.id));

  const toggle = (record) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(record.id)) next.delete(record.id);
      else next.set(record.id, { title: record.title, canSubmit: Boolean(record.permissions?.can_submit) });
      return next;
    });

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const record of deletable) {
        if (pageSelected) next.delete(record.id);
        else next.set(record.id, { title: record.title, canSubmit: Boolean(record.permissions?.can_submit) });
      }
      return next;
    });

  // Every deletable record under the current filters, not just this page.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    setError("");
    try {
      const body = await deletableResearchIds({
        status: query.status,
        category: query.category,
        academic_year: query.year,
        q: query.q,
      });
      setSelected(new Map(body.records.map((record) => [record.id, {
        title: record.title,
        canSubmit: Boolean(record.can_submit),
      }])));
      setDeletableTotal(body.total);
      if (body.total > body.records.length) {
        setNotice(`Selected the first ${body.records.length} of ${body.total}: one bulk action covers at most ${body.limit}.`);
      }
    } catch (err) {
      setError(err?.message || "The records could not be selected.");
    } finally {
      setSelectingAll(false);
    }
  };

  const deleteSelected = async () => {
    setDeleting(true);
    setError("");
    try {
      const body = await bulkDeleteResearch([...selected.keys()]);
      const skipped = body.skipped || [];
      const why = skipped
        .slice(0, 3)
        .map((item) => `\u201c${item.title || item.id}\u201d: ${item.reason}`)
        .join(" ");
      setNotice(
        body.message + (skipped.length ? ` ${why}` + (skipped.length > 3 ? ` \u2026and ${skipped.length - 3} more.` : "") : ""),
      );
      setSelected(new Map());
      setDeletableTotal(null);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setError(err?.message || "The records could not be deleted.");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const recordSelected = async () => {
    const ids = selectedRecordable.map(([id]) => id);
    if (ids.length === 0) return;
    setRecording(true);
    setError("");
    try {
      const body = await bulkRecordResearch(ids);
      const skipped = body.skipped || [];
      const remaining = new Map(selected);
      for (const id of body.recorded || []) remaining.delete(id);
      for (const item of skipped) {
        const old = remaining.get(item.id);
        remaining.set(item.id, { title: item.title || old?.title || item.id, canSubmit: true });
      }
      setSelected(remaining);
      setDeletableTotal(null);
      const reasons = skipped
        .slice(0, 3)
        .map((item) => `“${item.title || item.id}”: ${item.reason}`)
        .join(" ");
      setNotice(body.message + (reasons ? ` ${reasons}` + (skipped.length > 3 ? ` …and ${skipped.length - 3} more.` : "") : ""));
      setConfirmRecord(false);
      await load();
    } catch (err) {
      setError(err?.message || "The selected records could not be recorded.");
      setConfirmRecord(false);
    } finally {
      setRecording(false);
    }
  };
  const filtered = Boolean(query.q || query.category || query.year || query.status !== "all");

  return (
    <TeacherShell
      active="research"
      profile={profile}
      onLogout={logout}
      railNote={
        manager
          ? "Maintain and present the faculty's research portfolio."
          : "Your journal and conference papers, patents, books and achievements, verified by the Dean."
      }
    >
      <div className={`mx-auto w-full max-w-wrap px-5 sm:px-8 ${manager ? "py-6" : "py-8"}`}>
        <PageHero
          compact={manager}
          eyebrow={manager ? undefined : "Research portfolio"}
          title={routeCategory ? selectedCategory?.label || "Research" : manager ? "Faculty" : "My"}
          accent={routeCategory ? "Records" : "Research"}
          subtitle={
            manager
              ? undefined
              : "Your journal and conference papers, patents, books and achievements, with the evidence behind them. Records the Event Manager adds for you appear here too."
          }
          actions={
            <>
              {manager && routeCategory && (
                <Link to={recordsPath} className="btn btn-ghost">Back to research page</Link>
              )}
              <Link to={`${panel.base}/research/new`} className="btn btn-primary">
                <IconPlus />
                Add research
              </Link>
              {!manager && (
                <button
                  type="button"
                  onClick={() =>
                    run("excel", () =>
                      exportResearch({ status: query.status, category: query.category, academic_year: query.year, q: query.q }),
                    )
                  }
                  disabled={Boolean(busy)}
                  className="btn btn-ghost"
                  title="The records as filtered below, one sheet per category"
                >
                  {busy === "excel" ? <span className="spin h-4 w-4" /> : <IconDownload />}
                  Excel
                </button>
              )}
              {!manager && profile?.id && (
                <button
                  type="button"
                  onClick={() => run("cv", () => downloadResearchCv(profile.id))}
                  disabled={Boolean(busy)}
                  className="btn btn-ghost"
                  title="Your verified research as a PDF"
                >
                  {busy === "cv" ? <span className="spin h-4 w-4" /> : <IconDownload />}
                  My research CV
                </button>
              )}
            </>
          }
        />
        <ResearchNav base={`${panel.base}/research`} active="records" role={panel.role} />
        <OutcomesDuePanel base={`${panel.base}/research`} showFaculty={manager} />

        <div className={manager ? "mt-4" : "mt-6"}>
          <ResearchFilters
            query={query}
            setFilter={setResearchFilter}
            reset={clearResearchFilters}
            tabs={manager ? MANAGER_TABS : AUTHOR_TABS}
            labels={manager ? MANAGER_TAB_LABELS : {}}
            counts={data?.counts}
            categories={categories}
            years={data?.academic_years || []}
            searchLabel={manager ? "Search by title or teacher" : "Search by title"}
            searchPlaceholder={manager ? "Search titles or teachers…" : "Search titles…"}
          />
        </div>

        {notice && (
          <div className="toast toast-ok mt-5" role="status">
            <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{notice}</p>
            <button type="button" onClick={() => setNotice("")} className="btn btn-ghost btn-xs shrink-0">
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div
            className="mt-5 flex items-start gap-3 rounded-2xl border p-4"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm text-ink">{error}</p>
            <button type="button" onClick={load} className="btn btn-ghost btn-xs shrink-0">
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
            <p className="h3 text-ink">{filtered ? "Nothing matches these filters" : "No research recorded yet"}</p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              {filtered
                ? "Try another search, category or year — or clear the filters."
                : manager
                  ? "Add a journal or conference paper, patent, book or achievement for any teacher, attach its evidence and record it in the faculty portfolio."
                  : "Add a journal or conference paper, patent, book or achievement, attach its evidence and send it to the Dean for verification."}
            </p>
            {!filtered && (
              <Link to={`${panel.base}/research/new`} className="btn btn-primary btn-sm mt-5">
                <IconPlus />
                Add research
              </Link>
            )}
          </div>
        ) : (
          <div className={`glass mt-5 overflow-hidden transition-opacity ${loading ? "opacity-60" : ""}`}>
            {manager && (deletable.length > 0 || selected.size > 0) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b hairline px-4 py-2.5 sm:px-5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={pageSelected}
                    onChange={togglePage}
                    disabled={deletable.length === 0}
                    className="h-4 w-4 accent-accent"
                  />
                  Select all on this page
                </label>
                {pageSelected && (data?.total || 0) > records.length && deletableTotal === null && (
                  <button
                    type="button"
                    onClick={selectAllMatching}
                    disabled={selectingAll}
                    className="text-sm font-semibold text-accent hover:underline"
                  >
                    {selectingAll ? "Selecting\u2026" : "Select every available record matching these filters"}
                  </button>
                )}
                {selected.size > 0 && (
                  <>
                    <span className="text-sm text-muted">{selected.size} selected</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(new Map());
                        setDeletableTotal(null);
                      }}
                      className="text-sm font-medium text-muted hover:text-ink"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="btn btn-danger btn-xs ml-auto"
                    >
                      <IconTrash />
                      Delete {selected.size} selected
                    </button>
                    {selectedRecordable.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setConfirmRecord(true)}
                        className="btn btn-primary btn-xs"
                      >
                        <IconCheckCircle />
                        Record {selectedRecordable.length} selected
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <ul className="list-none p-0">
              {records.map((record) => (
                <ResearchRow
                  key={record.id}
                  record={record}
                  category={byKey[record.category]}
                  to={`${panel.base}/research/${record.id}`}
                  showFaculty={manager}
                  showStatus={!manager || record.recorded_by_manager}
                  leading={
                    manager ? (
                      <input
                        type="checkbox"
                        checked={selected.has(record.id)}
                        onChange={() => toggle(record)}
                        disabled={!record.permissions?.can_delete && !record.permissions?.can_submit}
                        title={
                          record.permissions?.can_delete || record.permissions?.can_submit
                            ? undefined
                            : "This record cannot be selected for a bulk action"
                        }
                        aria-label={`Select ${record.title}`}
                        className="h-4 w-4 accent-accent disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    ) : null
                  }
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

      <Modal
        open={confirmRecord}
        onClose={() => !recording && setConfirmRecord(false)}
        eyebrow="Record research"
        title={`Record ${selectedRecordable.length} research ${selectedRecordable.length === 1 ? "record" : "records"}?`}
        subtitle="Ready records will be added to the Dean's Event Manager list directly. No Dean verification is required. Records missing required details or evidence will be skipped."
        footer={
          <>
            <button type="button" onClick={() => setConfirmRecord(false)} disabled={recording} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={recordSelected} disabled={recording || selectedRecordable.length === 0} className="btn btn-primary">
              {recording ? <span className="spin h-4 w-4" /> : <IconCheckCircle />}
              Record {selectedRecordable.length}
            </button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {selectedRecordable.slice(0, 8).map(([id, item]) => (
            <li key={id}>{item.title}</li>
          ))}
          {selectedRecordable.length > 8 && <li className="list-none text-muted">…and {selectedRecordable.length - 8} more.</li>}
        </ul>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        eyebrow="Delete research"
        title={`Delete ${selected.size} research ${selected.size === 1 ? "record" : "records"}?`}
        subtitle="Drafts are deleted for good. Records already submitted are removed from your list only: they stay on the Dean's side, with their evidence."
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={deleteSelected} disabled={deleting} className="btn btn-danger">
              {deleting ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete {selected.size}
            </button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {[...selected.values()].slice(0, 8).map((item, index) => (
            <li key={index}>{item.title}</li>
          ))}
          {selected.size > 8 && <li className="list-none text-muted">…and {selected.size - 8} more.</li>}
        </ul>
      </Modal>
    </TeacherShell>
  );
}
