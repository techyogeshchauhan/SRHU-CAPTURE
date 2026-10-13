import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { apiJson, isAbortError } from "../../services/api";
import DeanShell from "../../components/dean/DeanShell";
import Modal from "../../components/teacher/Modal";
import PageHero from "../../components/teacher/PageHero";
import StatusChip from "../../components/teacher/StatusChip";
import StatCard from "../../components/common/StatCard";
import { programShare } from "../../components/dean/programShades";
import { trackOf } from "../../components/teacher/status";
import useThemeTokens from "../../components/theme/useThemeTokens";
import { formatRowDate } from "../../utils/submissionGrouping";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendar,
  IconChartBar,
  IconChartPie,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconEye,
  IconInbox,
  IconLayers,
  IconRefresh,
  IconX,
  IconXCircle,
} from "../../components/teacher/icons";
import {
  canApprove,
  canReject,
  getApproveLabel,
  getStatusBucket,
  normalizeStatus,
} from "../../utils/constants";

const TOTAL_TRACK = "#0EA5E9"; // sky

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

/**
 * Filter predicate: only events awaiting Dean review.
 * Includes pending, submitted, under_review, and resubmitted/correction events.
 * Excludes already approved, completed, published, recorded, rejected, revoked, and draft.
 */
function isAwaitingDeanReview(event) {
  if (!event) return false;
  const status = normalizeStatus(event.status);
  if (
    status === "approved" ||
    status === "published" ||
    status === "completed" ||
    status === "recorded" ||
    status === "in_progress" ||
    status === "draft" ||
    status === "rejected" ||
    status === "revoked"
  ) {
    return false;
  }
  return (
    getStatusBucket(status) === "pending" ||
    status === "resubmitted" ||
    status === "needs_correction" ||
    status === "changes_requested" ||
    status.includes("resubmit") ||
    status.includes("correct") ||
    Boolean(event.is_resubmitted)
  );
}

/**
 * Earliest date timestamp for sorting oldest-waiting first.
 */
function getWaitingTimestamp(event) {
  if (!event) return Infinity;
  const raw =
    event.submitted_at ||
    event.created_at ||
    event.event_date ||
    event.start_date ||
    event.date;
  if (!raw) return Infinity;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

export default function DeanDashboard() {
  const navigate = useNavigate();
  const tokens = useThemeTokens();

  // "overview" is the numbers and the program mix; "submissions" is the Review Queue
  // of items awaiting the Dean's action.
  const [activeView, setActiveView] = useState("overview");

  // ============================================
  // STATES
  // ============================================

  const [stats, setStats] = useState(() => {
    const cached = getCachedEventsCount();
    return {
      total_events: cached ?? 0,
      pending_events: 0,
      approved_events: 0,
      rejected_events: 0,
    };
  });

  const [events, setEvents] = useState([]);

  // Signed-in Dean, used for the header and rail account blocks.
  const [deanProfile, setDeanProfile] = useState(null);

  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Decision state for direct Approve / Reject in the Review Queue
  const [decision, setDecision] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [processingId, setProcessingId] = useState(null);

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
  // LOAD STATS
  // ============================================

  const loadStats = async () => {
    try {
      setLoadingStats(true);

      const data = await apiJson("/dean/dashboard/stats");

      const total = data?.total_events ?? 0;
      if (total > 0 || getCachedEventsCount() === null) {
        setCachedEventsCount(total);
      }

      setStats({
        total_events: total,
        pending_events: data?.pending_events || 0,
        approved_events: data?.approved_events || 0,
        rejected_events: data?.rejected_events || 0,
      });
    } catch (err) {
      console.error("Stats error:", err);
      if (isSignedOut(err)) return;
      setError(err?.message || "Unable to load dashboard statistics.");
    } finally {
      setLoadingStats(false);
    }
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
      if (loadedEvents.length > 0) {
        setCachedEventsCount(loadedEvents.length);
      }
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
    loadStats();
    loadEvents();
    loadDeanProfile();
  }, []);

  // ============================================
  // REFRESH HANDLERS
  // ============================================

  const refreshAfterNotification = () => {
    loadStats();
    loadEvents();
  };

  const refreshDashboard = async () => {
    setError("");
    await Promise.all([loadStats(), loadEvents()]);
  };

  // Auto-dismiss success toast
  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(""), 4500);
    return () => clearTimeout(timer);
  }, [success]);

  // ============================================
  // REVIEW QUEUE (Oldest-waiting first)
  // ============================================

  const reviewQueueEvents = useMemo(() => {
    return (events || [])
      .filter(isAwaitingDeanReview)
      .sort((a, b) => {
        const diff = getWaitingTimestamp(a) - getWaitingTimestamp(b);
        if (diff !== 0) return diff;
        return (a.id || "").localeCompare(b.id || "");
      });
  }, [events]);

  // ============================================
  // DECISION HANDLERS (Approve / Reject)
  // ============================================

  const openDecision = (event, kind) => {
    setDecision({ event, kind });
    setRejectReason("");
    setReasonError("");
  };

  const closeDecision = () => {
    if (processingId) return;
    setDecision(null);
    setRejectReason("");
    setReasonError("");
  };

  const confirmApprove = async () => {
    const event = decision?.event;
    if (!event) return;

    try {
      setProcessingId(event.id);
      setError("");
      setSuccess("");

      const data = await apiJson(`/dean/events/${event.id}/approve`, {
        method: "PATCH",
      });

      setSuccess(data?.message || "Event approved successfully.");
      setDecision(null);
      await Promise.all([loadStats(), loadEvents()]);
    } catch (err) {
      console.error("Approve error:", err);
      if (isSignedOut(err)) return;
      setError(err?.message || "Failed to approve event.");
      setDecision(null);
    } finally {
      setProcessingId(null);
    }
  };

  const confirmReject = async () => {
    const event = decision?.event;
    if (!event) return;

    const reason = rejectReason.trim();
    if (!reason) {
      setReasonError("A reason is required — the teacher sees it verbatim.");
      return;
    }

    try {
      setProcessingId(event.id);
      setError("");
      setSuccess("");
      setReasonError("");

      const data = await apiJson(`/dean/events/${event.id}/reject`, {
        method: "PATCH",
        body: { rejection_reason: reason },
      });

      setSuccess(data?.message || "Event rejected successfully.");
      setDecision(null);
      await Promise.all([loadStats(), loadEvents()]);
    } catch (err) {
      console.error("Reject error:", err);
      if (isSignedOut(err)) return;
      setError(err?.message || "Failed to reject event.");
      setDecision(null);
    } finally {
      setProcessingId(null);
    }
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

  const statCards = [
    {
      key: "total",
      label: "Total Events",
      value: stats.total_events,
      hint: "Everything submitted across campus",
      track: TOTAL_TRACK,
      Icon: IconLayers,
    },
    {
      key: "pending",
      label: "Pending",
      value: stats.pending_events,
      hint: "Awaiting your decision",
      track: trackOf("pending"),
      Icon: IconClock,
    },
    {
      key: "approved",
      label: "Approved",
      value: stats.approved_events,
      hint: "Cleared to go ahead",
      track: trackOf("approved"),
      Icon: IconCheckCircle,
    },
    {
      key: "rejected",
      label: "Rejected",
      value: stats.rejected_events,
      hint: "Sent back to the teacher",
      track: trackOf("rejected"),
      Icon: IconXCircle,
    },
  ];

  const busy = loadingStats || loadingEvents;
  const decisionEvent = decision?.event;

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
      railNote="Teachers propose events, you approve them. Pending submissions are the queue that needs you."
      onNotification={refreshAfterNotification}
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">
        <PageHero
          eyebrow="Dean Panel"
          title="Campus Event"
          accent="Overview"
          subtitle={`Welcome back, ${
            deanProfile?.name || "Dean"
          }. Review, filter and track every event submitted across campus.`}
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

              <Link to="/dean/events" className="btn btn-primary">
                <IconCalendar />
                Review queue
              </Link>
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

        {success && (
          <div
            className="mt-6 flex items-start gap-3 rounded-2xl border p-4"
            data-tint=""
            style={{ "--track": trackOf("approved") }}
            role="status"
          >
            <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Success</p>
              <p className="prose-muted mt-0.5 text-sm">{success}</p>
            </div>
            <button
              type="button"
              onClick={() => setSuccess("")}
              className="btn btn-ghost btn-xs shrink-0"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ------------------------------------------------------- the views */}
        <div
          role="tablist"
          aria-label="Dashboard views"
          className="mt-7 flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "overview"}
            onClick={() => setActiveView("overview")}
            className="tab"
          >
            <IconChartPie className="h-4 w-4" />
            Overview
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeView === "submissions"}
            onClick={() => setActiveView("submissions")}
            className="tab"
          >
            <IconInbox className="h-4 w-4" />
            Submissions
            <span className="tab-count">{reviewQueueEvents.length}</span>
          </button>
        </div>

        {/* ==================================================== OVERVIEW === */}
        {activeView === "overview" && (
          <>
            {/* The shared KPI cards */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {statCards.map((card, i) => (
                <StatCard
                  key={card.key}
                  index={i}
                  label={card.label}
                  value={loadingStats ? "—" : card.value}
                  Icon={card.Icon}
                  track={card.track}
                  hint={card.hint}
                />
              ))}
            </div>

            {/* ---------------------------------------------- program mix */}
            <section className="glass reveal mt-6 overflow-hidden" style={{ "--i": 5 }}>
              <div className="flex flex-col gap-3 border-b hairline px-6 py-5 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  <span className="icon-tile">
                    <IconChartPie />
                  </span>
                  <div>
                    <p className="eyebrow">Distribution</p>
                    <h2 className="h3 text-ink">Programs by type</h2>
                    <p className="prose-muted mt-0.5 text-xs">
                      Pick a program to view its events.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-6">
                {loadingEvents ? (
                  <div className="flex h-65 flex-col items-center justify-center gap-3">
                    <span className="spin h-10 w-10 text-accent" />
                    <p className="prose-muted text-sm">Loading programs…</p>
                  </div>
                ) : programMix.length === 0 ? (
                  <div className="flex h-65 flex-col items-center justify-center text-center">
                    <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
                      <IconChartBar className="h-6 w-6" />
                    </span>
                    <p className="h3 text-ink">No program data yet</p>
                    <p className="prose-muted mt-1 text-sm">
                      Once teachers submit events, their mix appears here.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-8 lg:flex-row">
                    {/* The ring */}
                    <div
                      className="h-60 w-full shrink-0 lg:w-75"
                      role="img"
                      aria-label={`Programs by type: ${programMix
                        .map((entry) => `${entry.name} ${entry.value}`)
                        .join(", ")}`}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={programMix}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            outerRadius={104}
                            innerRadius={68}
                            paddingAngle={2}
                            onClick={(slice) => handleTypeSelect(slice?.name)}
                            cursor="pointer"
                            isAnimationActive={false}
                          >
                            {programMix.map((entry) => (
                              <Cell
                                key={entry.name}
                                fill={entry.shade}
                                stroke={`rgb(${tokens.surface})`}
                                strokeWidth={2}
                              />
                            ))}
                          </Pie>

                          <text
                            x="50%"
                            y="50%"
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill={`rgb(${tokens.ink})`}
                            style={{ fontFamily: "Sora, system-ui, sans-serif" }}
                          >
                            <tspan x="50%" dy="-6" fontSize="28" fontWeight="700">
                              {events.length}
                            </tspan>
                            <tspan
                              x="50%"
                              dy="26"
                              fontSize="11"
                              fontWeight="600"
                              letterSpacing="1.6"
                              fill={`rgb(${tokens.muted})`}
                            >
                              EVENTS
                            </tspan>
                          </text>

                          <Tooltip
                            cursor={false}
                            formatter={(value, name) => [
                              `${value} event${value !== 1 ? "s" : ""}`,
                              name,
                            ]}
                            contentStyle={{
                              background: `rgb(${tokens.surface})`,
                              border: "1px solid rgb(15 23 42 / .1)",
                              borderRadius: "0.75rem",
                              boxShadow: "0 18px 50px -20px rgb(15 23 42 / .28)",
                              fontSize: "0.8rem",
                              padding: "0.5rem 0.7rem",
                            }}
                            itemStyle={{ color: `rgb(${tokens.ink})` }}
                            labelStyle={{ color: `rgb(${tokens.muted})` }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    {/* The rows */}
                    <ul className="w-full min-w-0 flex-1 space-y-1">
                      {programMix.map((entry) => {
                        const total = events.length || 1;
                        const pct = Math.round((entry.value / total) * 100);

                        return (
                          <li key={entry.name}>
                            <button
                              type="button"
                              onClick={() => handleTypeSelect(entry.name)}
                              title={`View ${entry.name} events`}
                              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-raised/45"
                            >
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ background: entry.shade }}
                              />

                              <span className="w-24 shrink-0 truncate text-sm font-medium text-ink">
                                {entry.name}
                              </span>

                              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                                <span
                                  className="block h-full rounded-full transition-[width] duration-300"
                                  style={{ width: `${pct}%`, background: entry.shade }}
                                />
                              </span>

                              <span className="num shrink-0 text-right text-sm font-semibold text-ink">
                                {entry.value}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* ============================================== REVIEW QUEUE === */}
        {activeView === "submissions" && (
          <section className="glass reveal mt-6 overflow-hidden rounded-xl border border-line/60 bg-surface shadow-xs">
            {/* Card Header */}
            <div className="flex items-center justify-between border-b border-line/60 px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <span className="icon-tile h-9 w-9 rounded-xl">
                  <IconClock className="h-4 w-4 text-accent" />
                </span>
                <div>
                  <h2 className="font-display text-base font-semibold text-ink">
                    Review Queue
                  </h2>
                  <p className="prose-muted text-xs">
                    Submissions awaiting Dean approval, sorted oldest first
                  </p>
                </div>
              </div>

              <span className="chip chip-solid text-xs">
                {reviewQueueEvents.length} {reviewQueueEvents.length === 1 ? "event" : "events"}
              </span>
            </div>

            {/* Card Body */}
            {loadingEvents ? (
              <div className="flex h-48 flex-col items-center justify-center gap-3">
                <span className="spin h-8 w-8 text-accent" />
                <p className="prose-muted text-sm">Loading review queue…</p>
              </div>
            ) : reviewQueueEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <span className="icon-tile mb-4 h-12 w-12 rounded-2xl">
                  <IconInbox className="h-6 w-6 text-muted" />
                </span>
                <p className="font-display text-base font-semibold text-ink">
                  Nothing needs your attention right now.
                </p>
                <p className="prose-muted mt-1 text-xs sm:text-sm max-w-sm">
                  All submitted events have been reviewed. New submissions from teachers will appear here.
                </p>
                <Link
                  to="/dean/events"
                  className="btn btn-ghost btn-sm mt-5 inline-flex items-center gap-1.5"
                >
                  <span>View all events</span>
                  <IconArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            ) : (
              <>
                <div className="divide-y divide-line/30">
                  {reviewQueueEvents.map((event) => (
                    <div
                      key={event.id}
                      className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 transition-colors hover:bg-raised/20"
                    >
                      {/* Left: Date + Event title + Subtitle */}
                      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                        <span className="whitespace-nowrap font-bold text-xs sm:text-sm text-ink">
                          {formatRowDate(event.event_date || event.start_date || event.created_at)}
                        </span>

                        <div className="flex min-w-0 items-center gap-2">
                          <Link
                            to={`/dean/events/${event.id}`}
                            className="truncate font-semibold text-sm text-ink hover:text-accent"
                            title={event.event_name}
                          >
                            {event.event_name || "Untitled Event"}
                          </Link>

                          <span className="hidden truncate text-xs text-muted md:inline">
                            · {event.event_type || "Event"}
                            {event.department ? ` · ${event.department}` : ""}
                          </span>
                        </div>
                      </div>

                      {/* Middle: Status chip */}
                      <div className="shrink-0">
                        <StatusChip status={event.status} size="sm" />
                      </div>

                      {/* Right: Actions */}
                      <div className="flex shrink-0 items-center gap-2">
                        <Link
                          to={`/dean/events/${event.id}`}
                          className="btn btn-ghost btn-xs border border-line/80 font-medium text-ink hover:bg-raised/60 inline-flex items-center gap-1.5"
                          title="View submission details"
                        >
                          <IconEye className="h-3.5 w-3.5 text-muted" />
                          <span>View</span>
                        </Link>

                        {canApprove(event) && (
                          <button
                            type="button"
                            onClick={() => openDecision(event, "approve")}
                            disabled={processingId === event.id}
                            title={getApproveLabel(event)}
                            className="btn btn-ok btn-xs inline-flex items-center gap-1"
                          >
                            {processingId === event.id ? (
                              <span className="spin h-3.5 w-3.5" />
                            ) : (
                              <IconCheck className="h-3.5 w-3.5" />
                            )}
                            <span>{getApproveLabel(event)}</span>
                          </button>
                        )}

                        {canReject(event) && (
                          <button
                            type="button"
                            onClick={() => openDecision(event, "reject")}
                            disabled={processingId === event.id}
                            title="Reject this event"
                            className="btn btn-danger btn-xs inline-flex items-center gap-1"
                          >
                            {processingId === event.id ? (
                              <span className="spin h-3.5 w-3.5" />
                            ) : (
                              <IconX className="h-3.5 w-3.5" />
                            )}
                            <span>Reject</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Footer */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-t border-line/60 bg-raised/20 px-5 py-3.5 text-xs text-muted sm:px-6">
                  <span>
                    Showing {reviewQueueEvents.length} event{reviewQueueEvents.length === 1 ? "" : "s"} awaiting review.
                  </span>
                  <Link
                    to="/dean/events"
                    className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  >
                    <span>View all events</span>
                    <IconArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </>
            )}
          </section>
        )}
      </div>

      {/* ==================================================================
          DECISION MODAL (Approve / Reject)
      ================================================================== */}
      <Modal
        open={Boolean(decision)}
        onClose={closeDecision}
        eyebrow="Confirm"
        title={
          decision?.kind === "approve"
            ? "Do you want to approve?"
            : "Reject event"
        }
        subtitle={
          decision?.kind === "approve"
            ? "The teacher is notified of the decision."
            : "The teacher sees the reason you give."
        }
        footer={
          <>
            <button
              type="button"
              onClick={closeDecision}
              disabled={Boolean(processingId)}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>

            {decision?.kind === "approve" && (
              <button
                type="button"
                onClick={() =>
                  navigate(`/dean/events/${decisionEvent?.id}?action=approve`)
                }
                disabled={Boolean(processingId)}
                className="btn btn-ghost btn-sm"
              >
                Open event and approve
              </button>
            )}

            {decision?.kind === "approve" ? (
              <button
                type="button"
                onClick={confirmApprove}
                disabled={Boolean(processingId)}
                className="btn btn-ok btn-sm"
              >
                {processingId ? <span className="spin h-3.5 w-3.5" /> : <IconCheck />}
                {processingId ? "Approving…" : "Approve"}
              </button>
            ) : (
              <button
                type="button"
                onClick={confirmReject}
                disabled={Boolean(processingId)}
                className="btn btn-danger btn-sm"
              >
                {processingId ? <span className="spin h-3.5 w-3.5" /> : <IconX />}
                {processingId ? "Rejecting…" : "Reject"}
              </button>
            )}
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span
            className="icon-tile icon-tile-track"
            style={{
              "--track":
                decision?.kind === "approve" ? trackOf("approved") : trackOf("rejected"),
            }}
          >
            {decision?.kind === "approve" ? <IconCheckCircle /> : <IconAlertTriangle />}
          </span>

          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              {decisionEvent?.event_name || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              {[
                decisionEvent?.event_type,
                formatRowDate(decisionEvent?.event_date || decisionEvent?.created_at),
                decisionEvent?.location,
              ]
                .filter(Boolean)
                .join(" · ") || "No details recorded"}
            </p>
          </div>
        </div>

        {decision?.kind === "reject" && (
          <div className="field mt-5">
            <label htmlFor="rejectReason">
              Reason for rejection
              <span className="req">*</span>
            </label>

            <textarea
              id="rejectReason"
              value={rejectReason}
              onChange={(e) => {
                setRejectReason(e.target.value);
                if (reasonError) setReasonError("");
              }}
              rows={4}
              autoFocus
              placeholder="What needs to change before this can be approved?"
              aria-invalid={reasonError ? "true" : undefined}
              aria-describedby={reasonError ? "rejectReasonError" : undefined}
              className="input"
            />

            {reasonError && (
              <p id="rejectReasonError" className="error mt-1 text-xs text-err" role="alert">
                {reasonError}
              </p>
            )}
          </div>
        )}
      </Modal>
    </DeanShell>
  );
}
