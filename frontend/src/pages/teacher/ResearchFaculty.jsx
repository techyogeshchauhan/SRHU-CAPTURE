import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import DownloadExcelButton from "../../components/common/DownloadExcelButton";
import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import TeacherShell from "../../components/teacher/TeacherShell";
import { trackOf } from "../../components/teacher/status";
import { IconAlertTriangle, IconDownload, IconEye, IconSearch, IconUsers, IconX } from "../../components/teacher/icons";
import useResearchQuery from "../../components/research/useResearchQuery";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { isAbortError } from "../../services/api";
import { downloadResearchCv, exportFacultySummary, exportResearch, researchFacultySummary } from "../../services/research";

/**
 * Research faculty-wise: every faculty member with research, how much of
 * each kind they have, and their records to open or download.
 *
 * - Event Manager: what they have recorded.
 * - Dean (`dean`): what the Event Manager has submitted -- the same records
 *   the Dean's research page lists, under its period filter when linked from it.
 */
export default function ResearchFaculty({ dean = false }) {
  const base = dean ? "/dean/research" : "/event_manager/research";
  const Shell = dean ? DeanShell : TeacherShell;
  const { profile, logout } = useShellProfile();
  const { categories } = useResearchCategories();
  const { query, setFilter, setFilters } = useResearchQuery();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  // Typed freely, written to the URL once the typing pauses.
  const [draft, setDraft] = useState(query.q);
  useEffect(() => {
    if (draft === query.q) return undefined;
    const timer = setTimeout(() => setFilter("q", draft, { replace: true }), 350);
    return () => clearTimeout(timer);
  }, [draft, query.q, setFilter]);

  // What the counts cover, as API parameters: the same for the list, the
  // links to each person's records and their Excel.
  const filters = useMemo(
    () => ({
      academic_year: query.year,
      ...(dean ? { start_date: query.from, end_date: query.to } : {}),
    }),
    [dean, query.year, query.from, query.to],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    researchFacultySummary({ ...filters, q: query.q }, { dean, signal: controller.signal })
      .then((body) => !controller.signal.aborted && setData(body))
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          setError(err?.message || "The faculty-wise research could not be loaded.");
        }
      })
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [dean, filters, query.q, reload]);

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

  // The records the counts are made of: the Event Manager's recorded ones,
  // the Dean's Event Manager submissions.
  const status = dean ? "event_manager" : "verified";
  const recordsOf = (row) => {
    const params = new URLSearchParams({ faculty: row.faculty_id });
    if (!dean) params.set("status", status);
    for (const [key, value] of [["year", query.year], ["from", dean && query.from], ["to", dean && query.to]]) {
      if (value) params.set(key, value);
    }
    return `${base}?${params}`;
  };

  const rows = data?.faculty || [];
  const years = data?.academic_years || [];
  const period = dean && (query.from || query.to) ? [query.from, query.to].filter(Boolean).join(" – ") : "";
  const filtered = Boolean(query.q || query.year || period);

  return (
    <Shell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero
          compact
          title="Faculty-wise"
          accent="Research"
          actions={
            <>
              <DownloadExcelButton
                onDownload={() => exportFacultySummary({ ...filters, q: query.q }, { dean })}
                onError={setError}
                title="This table as an Excel file"
              />
              <Link to={base} className="btn btn-ghost">
                Back to research page
              </Link>
            </>
          }
        />

        <div className="glass mt-4 flex flex-wrap items-center gap-2.5 px-4 py-3 sm:px-5">
          <div className="relative min-w-0 flex-1 basis-56">
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
              <IconSearch className="h-4 w-4" />
            </span>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search teachers or titles…"
              aria-label="Search by teacher or title"
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
          {period && (
            <span className="chip chip-sm">
              Research date: {period}
              <button type="button" onClick={() => setFilters({ from: "", to: "" })} aria-label="Clear the date range">
                <IconX className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm text-ink">{error}</p>
            <button type="button" onClick={() => setReload((n) => n + 1)} className="btn btn-ghost btn-xs shrink-0">
              Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="flex h-60 items-center justify-center">
            <span className="spin h-9 w-9 text-accent" />
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="glass mt-5 flex flex-col items-center px-6 py-14 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconUsers className="h-6 w-6" />
            </span>
            <p className="h3 text-ink">No faculty research here</p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              {filtered ? "Try another year, period or search." : "Research appears here once the Event Manager records it."}
            </p>
          </div>
        ) : (
          <section className={`glass mt-5 overflow-hidden transition-opacity ${loading ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pb-3 pt-5">
              <h2 className="h3 text-base text-ink">Research by faculty member</h2>
              <p className="prose-muted text-xs">
                {rows.length} faculty member{rows.length === 1 ? "" : "s"} · {data?.total ?? 0} record{data?.total === 1 ? "" : "s"}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[62rem] text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[.1em] text-muted">
                    <th className="px-5 py-2 font-semibold">Faculty member</th>
                    {categories.map((category) => (
                      <th key={category.key} className="px-2 py-2 text-right font-semibold">
                        {category.short}
                      </th>
                    ))}
                    <th className="px-2 py-2 text-right font-semibold">Total</th>
                    <th className="px-5 py-2 text-right font-semibold">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.faculty_id} className="border-t hairline">
                      <td className="px-5 py-2.5">
                        <Link to={recordsOf(row)} className="font-medium text-ink hover:text-accent">
                          {row.name}
                        </Link>
                        {row.designation && <span className="block text-xs text-muted">{row.designation}</span>}
                      </td>
                      {categories.map((category) => (
                        <td key={category.key} className={`num px-2 py-2.5 text-right ${row[category.key] ? "text-ink" : "text-muted"}`}>
                          {row[category.key] ?? 0}
                        </td>
                      ))}
                      <td className="num px-2 py-2.5 text-right font-semibold text-ink">{row.total}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <Link to={recordsOf(row)} className="btn btn-ghost btn-xs" aria-label={`View ${row.name}'s research`}>
                            <IconEye />
                            View
                          </Link>
                          <button
                            type="button"
                            onClick={() =>
                              run(`xlsx-${row.faculty_id}`, () =>
                                exportResearch({ ...filters, status, faculty_id: row.faculty_id }, { dean }),
                              )
                            }
                            disabled={Boolean(busy)}
                            className="btn btn-ghost btn-xs"
                            aria-label={`Download ${row.name}'s research as Excel`}
                          >
                            {busy === `xlsx-${row.faculty_id}` ? <span className="spin h-3 w-3" /> : <IconDownload />}
                            Download Excel
                          </button>
                          <button
                            type="button"
                            onClick={() => run(`cv-${row.faculty_id}`, () => downloadResearchCv(row.faculty_id, { dean }))}
                            disabled={Boolean(busy)}
                            className="btn btn-ghost btn-xs"
                            title="Research CV: every accepted record, all years"
                            aria-label={`Download ${row.name}'s research CV as PDF`}
                          >
                            {busy === `cv-${row.faculty_id}` ? <span className="spin h-3 w-3" /> : <IconDownload />}
                            PDF
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}
