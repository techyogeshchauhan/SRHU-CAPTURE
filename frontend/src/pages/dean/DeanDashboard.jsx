import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { apiJson, isAbortError } from "../../services/api";
import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import StatCard from "../../components/common/StatCard";
import { programShare } from "../../components/dean/programShades";
import { trackOf } from "../../components/teacher/status";
import useThemeTokens from "../../components/theme/useThemeTokens";
import { formatTime12h, localDateKey } from "../../utils/dates";
import {
  monthlyActivity,
  upcomingEvents,
} from "../../utils/deanInsights";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendar,
  IconChartBar,
  IconCheckCircle,
  IconLayers,
  IconRefresh,
  IconXCircle,
} from "../../components/teacher/icons";

const TOTAL_TRACK = "#0EA5E9"; // sky

/**
 * The monthly-activity stack, bottom to top. Review outcomes are states, so
 * they wear the reserved status colours -- the same ones as the KPI cards
 * above -- and the legend carries their names and totals, so identity is
 * never colour alone.
 */
const ACTIVITY_SERIES = [
  { key: "approved", label: "Approved", color: trackOf("approved") },
  { key: "pending", label: "Pending", color: trackOf("pending") },
  { key: "rejected", label: "Rejected", color: trackOf("rejected") },
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Jan" on the axis, with the year on January and on the first month. */
const monthTick = (key, index) => {
  const [year, month] = String(key).split("-");
  const label = MONTH_LONG[Number(month) - 1]?.slice(0, 3) || "";
  return index === 0 || month === "01" ? `${label} ’${year.slice(2)}` : label;
};

const monthName = (key) => {
  const [year, month] = String(key).split("-");
  return `${MONTH_LONG[Number(month) - 1] || ""} ${year}`;
};

const SEGMENT_GAP = 2;
const SEGMENT_RADIUS = 4;

/**
 * One stacked segment. The topmost non-empty segment of a month gets the
 * rounded cap; the others give up 2px at their top, which leaves a gap of
 * surface between neighbours instead of a stroke drawn round them. Months
 * still ahead are drawn faint: planned, not yet held.
 */
function StackSegment({ x, y, width, height, fill, payload, series }) {
  if (!height || height <= 0 || !width) return null;

  const topKey = [...ACTIVITY_SERIES].reverse().find((item) => payload?.[item.key] > 0)?.key;
  const opacity = payload?.isFuture ? 0.4 : 1;

  if (series !== topKey) {
    const shaved = height > SEGMENT_GAP ? SEGMENT_GAP : 0;
    return (
      <rect
        x={x}
        y={y + shaved}
        width={width}
        height={height - shaved}
        fill={fill}
        fillOpacity={opacity}
      />
    );
  }

  const r = Math.min(SEGMENT_RADIUS, width / 2, height);
  const bottom = y + height;
  return (
    <path
      d={`M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${bottom} Z`}
      fill={fill}
      fillOpacity={opacity}
    />
  );
}

/** The month under the pointer: its split, its total, and what a click does. */
function MonthTooltip({ active, payload }) {
  const month = active ? payload?.[0]?.payload : null;
  if (!month) return null;

  return (
    <div className="min-w-44 rounded-xl border hairline bg-surface px-3.5 py-2.5 text-xs shadow-lg">
      <p className="font-semibold text-ink">
        {monthName(month.key)}
        {month.isFuture && <span className="ml-1.5 font-normal text-muted">· planned</span>}
      </p>
      <ul className="mt-1.5 space-y-1">
        {ACTIVITY_SERIES.map((item) => (
          <li key={item.key} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="flex-1 text-muted">{item.label}</span>
            <span className="num font-semibold text-ink">{month[item.key]}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 flex justify-between border-t hairline pt-1.5 text-muted">
        Total <span className="num font-semibold text-ink">{month.total}</span>
      </p>
      {month.total > 0 && <p className="mt-1 text-[11px] text-accent">Click to open these events</p>}
    </div>
  );
}

/** "21" over "AUG" for an upcoming event, read straight off the date string. */
function DateBlock({ date }) {
  const [, month, day] = String(date || "").split("-");
  return (
    <span className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border hairline bg-raised/50 leading-none">
      <span className="font-display text-base font-bold text-ink">{Number(day) || "–"}</span>
      <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted">
        {MONTH_LONG[Number(month) - 1]?.slice(0, 3) || ""}
      </span>
    </span>
  );
}

const DEAN_EVENTS_CACHE_KEY = "cc_dean_events_count";

function getCachedEventsCount() {
  try {
    const raw = sessionStorage.getItem(DEAN_EVENTS_CACHE_KEY);
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    // sessionStorage might be restricted
  }
  return null;
}

function setCachedEventsCount(count) {
  if (typeof count === "number" && !Number.isNaN(count) && count >= 0) {
    try {
      sessionStorage.setItem(DEAN_EVENTS_CACHE_KEY, String(count));
    } catch {
      // sessionStorage might be restricted
    }
  }
}

const UPCOMING_PREVIEW = 4;

export default function DeanDashboard() {
  const navigate = useNavigate();
  const tokens = useThemeTokens();

  // ============================================
  // STATES
  // ============================================

  const [stats, setStats] = useState(() => {
    const cached = getCachedEventsCount();
    return {
      total_events: cached ?? 0,
      approved_events: 0,
      rejected_events: 0,
    };
  });

  const [events, setEvents] = useState([]);

  // Signed-in Dean, used for the header and rail account blocks.
  const [deanProfile, setDeanProfile] = useState(null);

  const [loadingEvents, setLoadingEvents] = useState(true);

  const [error, setError] = useState("");

  // ============================================
  // LOGOUT
  // ============================================

  const handleLogout = async () => {
    try {
      sessionStorage.removeItem(DEAN_EVENTS_CACHE_KEY);
    } catch {
      // ignore
    }
    await signOut();
    navigate("/login", { replace: true });
  };

  // ============================================
  // ERRORS
  // ============================================

  const isSignedOut = (err) => {
    if (err?.status !== 401) return false;
    navigate("/login", { replace: true });
    return true;
  };

  // ============================================
  // LOAD EVENTS
  // ============================================

  const eventsControllerRef = useRef(null);

  useEffect(() => () => eventsControllerRef.current?.abort(), []);

  const loadEvents = async () => {
    eventsControllerRef.current?.abort();
    const controller = new AbortController();
    eventsControllerRef.current = controller;

    try {
      setLoadingEvents(true);
      setError("");

      const data = await apiJson("/dean/events", { signal: controller.signal });

      if (controller.signal.aborted) return;
      const loadedEvents = data?.events || [];
      const counts = data?.counts || {};
      const total = counts.all ?? data?.total ?? loadedEvents.length;
      if (total > 0 || getCachedEventsCount() === null) {
        setCachedEventsCount(total);
      }
      setStats({
        total_events: total,
        approved_events: counts.approved || 0,
        rejected_events: counts.rejected || 0,
      });
      setEvents(loadedEvents);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      console.error("Events error:", err);
      if (isSignedOut(err)) return;

      setEvents([]);
      setError(err?.message || "Unable to load events.");
    } finally {
      if (eventsControllerRef.current === controller) setLoadingEvents(false);
    }
  };

  // ============================================
  // INITIAL LOAD
  // ============================================

  const loadDeanProfile = async () => {
    try {
      const data = await fetchCurrentUser();

      if (data) {
        setDeanProfile(data);
      }
    } catch (err) {
      console.error("Load dean profile error:", err);
    }
  };

  useEffect(() => {
    loadEvents();
    loadDeanProfile();
  }, []);

  // ============================================
  // REFRESH HANDLERS
  // ============================================

  const refreshAfterNotification = () => {
    loadEvents();
  };

  const refreshDashboard = async () => {
    setError("");
    await loadEvents();
  };

  // ============================================
  // PROGRAM MIX
  // ============================================

  const programMix = useMemo(
    () => programShare(events, tokens.accent),
    [events, tokens.accent]
  );

  const handleTypeSelect = (name) => {
    if (!name) return;
    navigate(`/dean/events?type=${encodeURIComponent(name)}`);
  };

  // The Overview panels, all from the event list already loaded above.
  const today = localDateKey();
  const activity = useMemo(() => monthlyActivity(events), [events]);
  const activityTotals = useMemo(
    () =>
      activity.reduce(
        (sum, month) => ({
          approved: sum.approved + month.approved,
          pending: sum.pending + month.pending,
          rejected: sum.rejected + month.rejected,
          total: sum.total + month.total,
        }),
        { approved: 0, pending: 0, rejected: 0, total: 0 },
      ),
    [activity],
  );
  const upcoming = useMemo(() => upcomingEvents(events), [events]);
  // A month opens All Events on that month's event dates.
  const openMonth = (key) => {
    const month = activity.find((item) => item.key === key);
    if (!month || month.total === 0) return;
    navigate(`/dean/events?start_date=${month.start}&end_date=${month.end}`);
  };

  // Each card opens All Events on the matching status tab; the tab keys are
  // the ones useTableQuery reads from ?status=.
  const statCards = [
    {
      key: "total",
      label: "Total Events",
      value: stats.total_events,
      hint: "Everything submitted across campus",
      to: "/dean/events",
      track: TOTAL_TRACK,
      Icon: IconLayers,
    },
    {
      key: "approved",
      label: "Approved",
      value: stats.approved_events,
      hint: "Cleared to go ahead",
      to: "/dean/events?status=approved",
      track: trackOf("approved"),
      Icon: IconCheckCircle,
    },
    {
      key: "rejected",
      label: "Rejected",
      value: stats.rejected_events,
      hint: "Sent back to the teacher",
      to: "/dean/events?status=rejected",
      track: trackOf("rejected"),
      Icon: IconXCircle,
    },
  ];

  const busy = loadingEvents;
  const resolvedEventCount = useMemo(() => {
    const live = stats.total_events || events.length;
    if (live > 0) return live;
    const cached = getCachedEventsCount();
    if (cached !== null && cached > 0) return cached;
    if (busy) return undefined;
    return 0;
  }, [stats.total_events, events.length, busy]);

  // ============================================
  // RENDER
  // ============================================

  return (
    <DeanShell
      active="dashboard"
      profile={deanProfile}
      onLogout={handleLogout}
      railBadge={resolvedEventCount}
      railNote="Track campus events, monthly activity, and upcoming schedules."
      onNotification={refreshAfterNotification}
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero
          compact
          title="Campus Event"
          accent="Overview"
          actions={
            <>
              <button
                type="button"
                onClick={refreshDashboard}
                disabled={busy}
                className="btn btn-ghost"
              >
                {busy ? <span className="spin h-4 w-4" /> : <IconRefresh />}
                Refresh
              </button>
            </>
          }
        />

        {error && (
          <div
            className="mt-6 flex items-start gap-3 rounded-2xl border p-4"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Something didn’t load</p>
              <p className="prose-muted mt-0.5 text-sm">{error}</p>
            </div>
            <button
              type="button"
              onClick={refreshDashboard}
              className="btn btn-ghost btn-xs shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* ======================================================= ONE VIEW
            Event totals, monthly activity, and upcoming events. */}

        {/* The shared KPI cards, compact */}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {statCards.map((card, i) => (
            <StatCard
              key={card.key}
              compact
              index={i}
              to={card.to}
              label={card.label}
              value={loadingEvents ? "—" : card.value}
              Icon={card.Icon}
              track={card.track}
              hint={card.hint}
            />
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* ---- Monthly activity ---- */}
          <section className="glass reveal overflow-hidden lg:col-span-12" style={{ "--i": 5 }}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b hairline px-4 py-2.5">
              <div className="flex items-center gap-2">
                <IconChartBar className="h-4 w-4 text-accent" />
                <h2 className="h3 text-base text-ink">Monthly activity</h2>
              </div>

              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Legend">
                {ACTIVITY_SERIES.map((item) => (
                  <li key={item.key} className="flex items-center gap-1.5 text-muted">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} />
                    {item.label}
                    <span className="num font-semibold text-ink">{activityTotals[item.key]}</span>
                  </li>
                ))}
                <li className="flex items-center gap-1.5 text-muted">
                  <span className="h-2.5 w-2.5 rounded-sm opacity-40" style={{ background: trackOf("approved") }} />
                  Ahead
                </li>
              </ul>
            </div>

            <div className="px-4 pb-3 pt-3">
              {loadingEvents ? (
                <div className="flex h-40 items-center justify-center">
                  <span className="spin h-8 w-8 text-accent" />
                </div>
              ) : activityTotals.total === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center text-center">
                  <p className="h3 text-base text-ink">No events in these months</p>
                  <p className="prose-muted mt-1 text-xs">
                    Events dated in the last eight months or the next three appear here.
                  </p>
                </div>
              ) : (
                <>
                  {/* The table below carries the same numbers for screen
                      readers, so the drawing itself is hidden from them. */}
                  <div className="h-40 w-full" aria-hidden="true">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={activity}
                        margin={{ top: 6, right: 10, bottom: 0, left: -22 }}
                        barCategoryGap="26%"
                        onClick={(state) => openMonth(state?.activeLabel)}
                        style={{ cursor: "pointer" }}
                      >
                        <CartesianGrid vertical={false} stroke={`rgb(${tokens.muted} / .14)`} />
                        <XAxis
                          dataKey="key"
                          tickFormatter={monthTick}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: `rgb(${tokens.muted})`, fontSize: 11 }}
                          tickMargin={6}
                          minTickGap={10}
                        />
                        <YAxis
                          allowDecimals={false}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: `rgb(${tokens.muted})`, fontSize: 11 }}
                        />
                        <Tooltip
                          cursor={{ fill: `rgb(${tokens.muted} / .08)`, radius: 6 }}
                          content={<MonthTooltip />}
                          isAnimationActive={false}
                        />
                        {ACTIVITY_SERIES.map((item) => (
                          <Bar
                            key={item.key}
                            dataKey={item.key}
                            name={item.label}
                            stackId="month"
                            fill={item.color}
                            isAnimationActive={false}
                            shape={(props) => <StackSegment {...props} series={item.key} />}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <table className="sr-only">
                    <caption>Events per month, by review outcome</caption>
                    <thead>
                      <tr>
                        <th scope="col">Month</th>
                        {ACTIVITY_SERIES.map((item) => (
                          <th key={item.key} scope="col">{item.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activity.map((month) => (
                        <tr key={month.key}>
                          <th scope="row">{monthName(month.key)}</th>
                          {ACTIVITY_SERIES.map((item) => (
                            <td key={item.key}>{month[item.key]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {programMix.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t hairline pt-2.5">
                  <span className="mr-1 text-xs font-medium text-muted">By type</span>
                  {programMix.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => handleTypeSelect(entry.name)}
                      title={`View ${entry.name} events`}
                      className="chip chip-sm cursor-pointer gap-1.5 transition hover:border-accent/40 hover:text-ink"
                    >
                      {entry.name}
                      <span className="num font-semibold text-ink">{entry.value}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ---- Upcoming events ---- */}
          <section className="glass reveal overflow-hidden lg:col-span-12" style={{ "--i": 7 }}>
            <div className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5">
              <div className="flex items-center gap-2">
                <IconCalendar className="h-4 w-4 text-accent" />
                <h2 className="h3 text-base text-ink">Upcoming events</h2>
                <span className="text-xs text-muted">next 30 days</span>
              </div>
              {upcoming.total > 0 && (
                <Link
                  to={`/dean/events?status=approved&start_date=${today}&end_date=${upcoming.until}`}
                  className="btn btn-ghost btn-xs"
                >
                  View all {upcoming.total}
                  <IconArrowRight />
                </Link>
              )}
            </div>

            <div className="p-3">
              {loadingEvents ? (
                <div className="flex h-20 items-center justify-center">
                  <span className="spin h-8 w-8 text-accent" />
                </div>
              ) : upcoming.items.length === 0 ? (
                <p className="prose-muted px-1 py-4 text-center text-sm">Nothing scheduled in the next 30 days.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {upcoming.items.slice(0, UPCOMING_PREVIEW).map((event) => {
                    const time = formatTime12h(event.start_time);
                    const meta = [time, event.location].filter(Boolean).join(" · ");
                    return (
                      <li key={event.id} className="min-w-0">
                        <Link
                          to={`/dean/events/${event.id}`}
                          className="flex items-center gap-3 rounded-xl border hairline bg-raised/30 p-2 transition hover:border-accent/30 hover:bg-raised/60"
                        >
                          <DateBlock date={event.event_date} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-ink" title={event.event_name}>
                              {event.event_name || "Untitled event"}
                            </p>
                            <p className="truncate text-xs text-muted" title={meta}>
                              {meta || "Time and venue not set"}
                            </p>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

        </div>
      </div>

    </DeanShell>
  );
}
