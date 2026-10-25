import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import StatCard from "../common/StatCard";
import { trackOf } from "../teacher/status";
import { IconAlertTriangle, IconAward, IconDownload, IconShield, IconUsers } from "../teacher/icons";
import { isAbortError } from "../../services/api";
import { downloadResearchCv, exportNaac, researchAnalytics } from "../../services/research";

// One fixed slot per category, never re-ordered or cycled (index.css).
const ORDER = ["journal", "conference", "patent", "book", "funded_project", "other"];
const SERIES = {
  journal: "var(--series-1)",
  conference: "var(--series-2)",
  patent: "var(--series-3)",
  book: "var(--series-5)",
  other: "var(--series-6)",
};
const SINGLE = "var(--series-1)";

const whole = new Intl.NumberFormat("en-IN");

const TOOLTIP = {
  contentStyle: {
    background: "rgb(var(--c-surface))",
    border: "1px solid rgb(var(--c-line) / .15)",
    borderRadius: 12,
    color: "rgb(var(--c-ink))",
    fontSize: 12,
    boxShadow: "0 12px 32px -12px rgb(0 0 0 / .35)",
  },
  labelStyle: { color: "rgb(var(--c-ink))", fontWeight: 600 },
  itemStyle: { color: "rgb(var(--c-ink))" },
  cursor: { fill: "rgb(var(--c-line) / .06)" },
};

const AXIS = { stroke: "var(--chart-axis)", tick: { fill: "rgb(var(--c-muted))", fontSize: 12 }, tickLine: false };

/**
 * A chart in a card, with the same numbers as a table one click away -- the
 * relief the palette check asks for, and a way to read exact values.
 */
function ChartCard({ title, subtitle, rows, columns, children, height = 260, empty }) {
  return (
    <section className="glass flex min-w-0 flex-col p-5">
      <h3 className="h3 text-base text-ink">{title}</h3>
      {subtitle && <p className="prose-muted mt-0.5 text-xs">{subtitle}</p>}
      {empty ? (
        <p className="prose-muted flex flex-1 items-center justify-center py-10 text-sm">{empty}</p>
      ) : (
        <>
          <div className="mt-4 min-w-0" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-xs font-semibold text-accent">View as table</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted">
                    {columns.map((column) => (
                      <th key={column.key} className="py-1.5 pr-3 font-semibold">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index} className="border-t hairline">
                      {columns.map((column) => (
                        <td key={column.key} className="num py-1.5 pr-3 text-ink">
                          {column.format ? column.format(row[column.key]) : row[column.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/** Horizontal bars, labelled at their ends; `color` per row or one hue. */
function Bars({ data, valueKey = "value", format = (v) => whole.format(v), colorOf }) {
  return (
    <BarChart data={data} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 8 }} barCategoryGap={6}>
      <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
      <XAxis type="number" {...AXIS} allowDecimals={false} tickFormatter={format} />
      <YAxis type="category" dataKey="label" {...AXIS} width={128} axisLine={false} />
      <Tooltip {...TOOLTIP} formatter={(value) => [format(value), ""]} separator="" />
      <Bar dataKey={valueKey} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
        {data.map((row) => (
          <Cell key={row.label} fill={colorOf ? colorOf(row) : SINGLE} />
        ))}
        <LabelList dataKey={valueKey} position="right" formatter={format} fill="rgb(var(--c-ink))" fontSize={12} />
      </Bar>
    </BarChart>
  );
}

/**
 * The research numbers for the Dean (and, read-only, the Event Manager):
 * output by category and year, the patent pipeline, indexing, and
 * who it comes from. Verified records only unless
 * "Include pending" is ticked.
 */
// `compactCards`: the small KPI boxes of the Dean's pages (the Dean always gets them).
export default function ResearchAnalytics({ dean = false, categories = [], cvLinks = false, recordsPath = "", compactCards = dean }) {
  const [filters, setFilters] = useState({ academic_year: "", category: "", include_pending: false });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const controllerRef = useRef(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const body = await researchAnalytics(
        { ...filters, include_pending: filters.include_pending || undefined },
        { dean, signal: controller.signal },
      );
      if (!controller.signal.aborted) setData(body);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err?.message || "The numbers could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filters, dean]);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const label = (key) => categories.find((c) => c.key === key)?.short || key;
  const outcomeLabel = (category, key) =>
    categories.find((c) => c.key === category)?.outcomes?.find((o) => o.key === key)?.label || key;

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

  const shown = ORDER.filter((key) => !filters.category || filters.category === key);
  const byCategory = data
    ? shown.map((key) => ({ key, label: label(key), value: data.by_category?.[key] || 0 }))
    : [];
  const trend = (data?.by_year || []).map((row) => ({ ...row, label: row.academic_year }));
  // Refused and abandoned only appear when there are some: they are the
  // exception, and two empty rows would crowd the pipeline.
  const patents = data
    ? Object.entries(data.patents || {})
        .filter(([key, value]) => value || !["refused", "abandoned"].includes(key))
        .map(([key, value]) => ({ key, label: outcomeLabel("patent", key), value }))
    : [];
  const indexing = Object.entries(data?.indexing || {}).map(([key, value]) => ({ label: key, value }));
  const scope = filters.include_pending ? "verified and awaiting verification" : "verified";
  // A card opens the records it counts, under the same year and category.
  const recordsLink = (category = filters.category) => {
    if (!recordsPath) return undefined;
    const params = new URLSearchParams({ status: filters.include_pending ? "all" : "verified" });
    if (filters.academic_year) params.set("year", filters.academic_year);
    const path = category ? `${recordsPath}/category/${encodeURIComponent(category)}` : recordsPath;
    return `${path}?${params}`;
  };

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ filters */}
      <div className="glass flex flex-wrap items-center gap-2.5 px-4 py-3 sm:px-5">
        <select
          value={filters.academic_year}
          onChange={(e) => setFilters((f) => ({ ...f, academic_year: e.target.value }))}
          aria-label="Academic year"
          className="input min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none"
        >
          <option value="">All years</option>
          {(data?.academic_years || []).map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
        <select
          value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
          aria-label="Category"
          className="input min-w-0 flex-1 basis-36 sm:w-52 sm:flex-none"
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category.key} value={category.key}>
              {category.label}
            </option>
          ))}
        </select>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={filters.include_pending}
            onChange={(e) => setFilters((f) => ({ ...f, include_pending: e.target.checked }))}
            className="h-4 w-4 accent-accent"
          />
          Include records awaiting verification
        </label>
        <button
          type="button"
          onClick={() => run("naac", () => exportNaac(filters.academic_year, { dean }))}
          disabled={Boolean(busy)}
          className="btn btn-ghost btn-sm sm:ml-auto"
          title="Verified records in NAAC Criterion III's layout"
        >
          {busy === "naac" ? <span className="spin h-4 w-4" /> : <IconDownload />}
          NAAC export
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
          <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
          <p className="min-w-0 flex-1 text-sm text-ink">{error}</p>
          <button type="button" onClick={load} className="btn btn-ghost btn-xs">
            Retry
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="flex h-60 items-center justify-center">
          <span className="spin h-9 w-9 text-accent" />
        </div>
      ) : data ? (
        <div className={`space-y-5 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {/* The Dean's overview lives on the records page; these figures support analytics. */}
          <div className={`grid grid-cols-2 gap-3 ${dean ? "" : "lg:grid-cols-3"}`}>
            <StatCard compact={compactCards} index={0} label="Research records" value={whole.format(data.total)} Icon={IconAward} track={trackOf("approved")} hint={`All ${scope}`} to={recordsLink()} />
            {!dean && <StatCard compact={compactCards} index={1} label="Faculty contributing" value={whole.format(data.faculty_count)} Icon={IconUsers} track={trackOf("under_review")} hint="With at least one record" to="#top-contributors" />}
            <StatCard compact={compactCards} index={dean ? 1 : 2} label="Patents granted" value={whole.format(data.patents?.granted || 0)} Icon={IconShield} track={trackOf("published")} hint={`${data.patents?.filed || 0} filed · ${data.patents?.published || 0} published`} to={recordsLink("patent")} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard
              title="Output by category"
              subtitle={`Records ${scope}`}
              rows={byCategory}
              columns={[{ key: "label", label: "Category" }, { key: "value", label: "Records" }]}
              empty={data.total === 0 ? "Nothing to count yet." : null}
            >
              <Bars data={byCategory} colorOf={(row) => SERIES[row.key]} />
            </ChartCard>

            <ChartCard
              title="Year by year"
              subtitle="Records per academic year, by category"
              rows={trend}
              columns={[{ key: "label", label: "Academic year" }, ...shown.map((key) => ({ key, label: label(key) }))]}
              empty={trend.length === 0 ? "No dated records yet." : null}
            >
              <BarChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} allowDecimals={false} axisLine={false} />
                <Tooltip {...TOOLTIP} />
                {/* Legend in the categories' fixed order (Recharts sorts by
                    name otherwise), its text in ink -- the dot carries the hue. */}
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  iconType="circle"
                  iconSize={8}
                  itemSorter={(item) => shown.indexOf(item.dataKey)}
                  formatter={(value) => <span style={{ color: "rgb(var(--c-ink))" }}>{value}</span>}
                />
                {shown.map((key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    name={label(key)}
                    stackId="year"
                    fill={SERIES[key]}
                    stroke="rgb(var(--c-surface))"
                    strokeWidth={1}
                    maxBarSize={44}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ChartCard>

            {(!filters.category || filters.category === "patent") && (
              <ChartCard
                title="Patent pipeline"
                subtitle="Where each patent stands"
                rows={patents}
                columns={[{ key: "label", label: "Status" }, { key: "value", label: "Patents" }]}
                empty={patents.every((row) => !row.value) ? "No patents recorded for this selection." : null}
                height={220}
              >
                <Bars data={patents} />
              </ChartCard>
            )}

            {(!filters.category || filters.category === "journal") && (
              <ChartCard
                title="Journal indexing"
                subtitle="Papers by the databases that index them (a paper can be in several)"
                rows={indexing}
                columns={[{ key: "label", label: "Indexed in" }, { key: "value", label: "Papers" }]}
                empty={indexing.length === 0 ? "No journal papers for this selection." : null}
                height={220}
              >
                <Bars data={indexing} />
              </ChartCard>
            )}

          </div>

          {/* ------------------------------------------------ who
              No department table: the platform serves one school (SST). */}
          <div>
            <section id="top-contributors" className="glass min-w-0 scroll-mt-24 overflow-hidden">
              <div className="px-5 pb-3 pt-5">
                <h3 className="h3 text-base text-ink">Top contributors</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-[.1em] text-muted">
                      <th className="px-5 py-2 font-semibold">Faculty member</th>
                      <th className="px-2 py-2 text-right font-semibold">Records</th>
                      <th className="px-2 py-2 font-semibold">Mostly</th>
                      {cvLinks && <th className="px-5 py-2 text-right font-semibold">CV</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(data.top_contributors || []).map((row) => {
                      const leading = ORDER.filter((key) => row[key]).sort((a, b) => row[b] - row[a]).slice(0, 2);
                      return (
                        <tr key={row.faculty_id} className="border-t hairline">
                          <td className="px-5 py-2 font-medium text-ink">{row.name}</td>
                          <td className="num px-2 py-2 text-right font-semibold text-ink">{row.total}</td>
                          <td className="px-2 py-2 text-xs text-muted">
                            {leading.map((key) => `${label(key)} ${row[key]}`).join(" · ")}
                          </td>
                          {cvLinks && (
                            <td className="px-5 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => run(`cv-${row.faculty_id}`, () => downloadResearchCv(row.faculty_id, { dean }))}
                                disabled={Boolean(busy)}
                                className="btn btn-ghost btn-xs"
                                aria-label={`Download ${row.name}'s research CV`}
                              >
                                {busy === `cv-${row.faculty_id}` ? <span className="spin h-3 w-3" /> : <IconDownload />}
                                PDF
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {(data.top_contributors || []).length === 0 && (
                      <tr>
                        <td colSpan={cvLinks ? 4 : 3} className="prose-muted px-5 py-6 text-center">
                          Nothing yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
