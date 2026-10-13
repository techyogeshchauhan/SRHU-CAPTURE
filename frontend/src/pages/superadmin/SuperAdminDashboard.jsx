import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { apiJson } from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import SuperAdminShell from "../../components/superadmin/SuperAdminShell";
import StatCard from "../../components/common/StatCard";
import PageHero from "../../components/teacher/PageHero";
import { ROLE_TRACK } from "../../components/common/roles";
import { trackOf } from "../../components/teacher/status";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconAward,
  IconCalendar,
  IconClock,
  IconRefresh,
  IconShield,
  IconUser,
  IconUserPlus,
  IconUsers,
} from "../../components/teacher/icons";

const EMPTY_STATS = {
  total_users: 0,
  teachers: 0,
  deans: 0,
  superadmins: 0,
  event_managers: 0,
  pending_events: 0,
};

const ALL_USERS_TRACK = "#10B981"; // emerald: the whole directory, no single role

const CATEGORY_PALETTE = [
  "#0EA5E9",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#6366F1",
  "#14B8A6",
  "#F97316",
];

function SuperAdminDashboard() {
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();

  const [stats, setStats] = useState(EMPTY_STATS);
  const [analytics, setAnalytics] = useState({
    kpis: {},
    monthly_trends: [],
    category_distribution: [],
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // The charts are optional: a failure there keeps the counts on screen, but
  // must not pass for "nothing recorded yet".
  const [analyticsFailed, setAnalyticsFailed] = useState(false);

  const loadStats = useCallback(async ({ silent = false } = {}) => {
    try {
      if (silent) setRefreshing(true);

      const [statsData, analyticsData] = await Promise.all([
        apiJson("/superadmin/dashboard/stats"),
        apiJson("/superadmin/dashboard/analytics").catch(() => null),
      ]);
      setError("");
      setStats({ ...EMPTY_STATS, ...statsData });
      if (analyticsData) setAnalytics(analyticsData);
      setAnalyticsFailed(!analyticsData);
    } catch (err) {
      if (err?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      console.error("Super Admin Dashboard Error:", err);
      setError(err?.message || "Unable to load dashboard statistics.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigate]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const summaryCards = [
    {
      key: "all",
      label: "Total Users",
      value: stats.total_users,
      hint: "Open the directory",
      to: "/superadmin/users",
      track: ALL_USERS_TRACK,
      Icon: IconUsers,
    },
    {
      key: "teachers",
      label: "Teachers",
      value: stats.teachers,
      hint: "View teachers",
      to: "/superadmin/users?role=teacher",
      track: ROLE_TRACK.teacher,
      Icon: IconUser,
    },
    {
      key: "deans",
      label: "Deans",
      value: stats.deans,
      hint: "View deans",
      to: "/superadmin/users?role=dean",
      track: ROLE_TRACK.dean,
      Icon: IconAward,
    },
    {
      key: "pending",
      label: "Pending Events",
      value: stats.pending_events,
      hint: "Awaiting a Dean decision",
      track: trackOf("pending"),
      Icon: IconClock,
    },
  ];

  const roleShare = [
    { key: "teacher", label: "Teachers", value: stats.teachers, track: ROLE_TRACK.teacher },
    { key: "dean", label: "Deans", value: stats.deans, track: ROLE_TRACK.dean },
    { key: "superadmin", label: "Super Admins", value: stats.superadmins, track: ROLE_TRACK.superadmin },
    { key: "event_manager", label: "Event Managers", value: stats.event_managers, track: ROLE_TRACK.event_manager },
  ];
  const roleTotal = roleShare.reduce((sum, r) => sum + (r.value || 0), 0);

  const managementCards = [
    {
      key: "users",
      to: "/superadmin/users",
      track: ROLE_TRACK.teacher,
      Icon: IconUsers,
      title: "User Management",
      body: "Directory of all accounts with soft-deactivation, profile edit overrides, and password resets.",
      cta: "Manage users",
    },
    {
      key: "audit-logs",
      to: "/superadmin/audit-logs",
      track: "#F59E0B",
      Icon: IconActivity,
      title: "System Audit Logs",
      body: "Immutable chronological trail of role changes, activations, overrides, and security events.",
      cta: "View audit trail",
    },
    {
      key: "create-dean",
      to: "/superadmin/create-dean",
      track: "#10B981",
      Icon: IconUserPlus,
      title: "Create Dean",
      body: "Register a verified Dean account with a temporary password to oversee events.",
      cta: "Create a Dean",
    },
    {
      key: "create-event-manager",
      to: "/superadmin/create-event-manager",
      track: ROLE_TRACK.event_manager,
      Icon: IconUserPlus,
      title: "Create Event Manager",
      body: "Invite an Event Manager by email; they verify their address and set their own password.",
      cta: "Invite an Event Manager",
    },
  ];

  if (loading) {
    return (
      <div className="hv-root flex min-h-screen items-center justify-center">
        <div className="text-center">
          <span className="spin mx-auto mb-4 block h-10 w-10 text-accent" />
          <p className="prose-muted text-sm">Loading super admin console…</p>
        </div>
      </div>
    );
  }

  return (
    <SuperAdminShell
      active="dashboard"
      profile={profile}
      onLogout={handleLogout}
      railBadge={stats.total_users}
      railNote="Roles decide what a person can do: teachers propose events, Deans approve them, super admins manage accounts."
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">

        <PageHero
          eyebrow="Super Admin"
          title="Super Admin"
          accent="Console"
          subtitle={`Welcome back, ${profile?.name || "Super Admin"}. Manage accounts, roles and accreditation data for Campus Capture.`}
          actions={
            <>
              <button
                type="button"
                onClick={() => loadStats({ silent: true })}
                disabled={refreshing}
                className="btn btn-ghost"
              >
                {refreshing ? <span className="spin h-4 w-4" /> : <IconRefresh />}
                Refresh
              </button>
              <Link to="/superadmin/create-dean" className="btn btn-primary">
                <IconUserPlus />
                Create Dean
              </Link>
            </>
          }
        />

        {error && (
          <div
            className="mt-6 flex items-start gap-3 rounded-2xl border p-4"
            data-tint=""
            style={{ "--track": "#EF4444" }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Statistics unavailable</p>
              <p className="prose-muted mt-0.5 text-sm">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => loadStats({ silent: true })}
              className="btn btn-ghost btn-xs shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* ------------------------------------------------ summary cards */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {summaryCards.map((card, i) => (
            <StatCard
              key={card.key}
              index={i}
              to={card.to}
              label={card.label}
              value={card.value}
              Icon={card.Icon}
              track={card.track}
              hint={card.hint}
            />
          ))}
        </div>

        {/* -------------------------------- role share + management cards */}
        <div className="mt-6 grid gap-4 lg:grid-cols-5">

          <section className="glass reveal p-6 lg:col-span-2" style={{ "--i": 5 }}>
            <div className="flex items-center gap-3">
              <span className="icon-tile">
                <IconShield />
              </span>
              <div>
                <p className="eyebrow">Directory</p>
                <h2 className="h3 text-ink">Accounts by role</h2>
              </div>
            </div>

            {roleTotal === 0 ? (
              <p className="prose-muted mt-5 text-sm">No accounts registered yet.</p>
            ) : (
              <>
                <div
                  className="mt-5 flex h-3 w-full overflow-hidden rounded-full bg-raised"
                  role="img"
                  aria-label={roleShare.map((r) => `${r.label}: ${r.value}`).join(", ")}
                >
                  {roleShare
                    .filter((r) => r.value > 0)
                    .map((r) => (
                      <span
                        key={r.key}
                        style={{ width: `${(r.value / roleTotal) * 100}%`, background: r.track }}
                        className="h-full min-w-1 transition-[width] duration-300"
                      />
                    ))}
                </div>

                <ul className="mt-4 space-y-2.5">
                  {roleShare.map((r) => (
                    <li key={r.key} className="flex items-center gap-3 text-sm">
                      <span className="dot dot-sm" style={{ "--track": r.track }} />
                      <span className="text-muted">{r.label}</span>
                      <span className="num ml-auto font-semibold text-ink">{r.value}</span>
                      <span className="num w-10 text-right text-xs text-muted">
                        {Math.round((r.value / roleTotal) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-3">
            {managementCards.map((card, i) => (
              <Link
                key={card.key}
                to={card.to}
                style={{ "--track": card.track, "--i": 6 + i }}
                // An odd card out spans the row, so the grid never ends in a gap.
                className={`stat-card reveal group ${
                  managementCards.length % 2 === 1 && i === managementCards.length - 1 ? "sm:col-span-2" : ""
                }`}
              >
                <div className="relative">
                  <span className="icon-tile icon-tile-track">
                    <card.Icon />
                  </span>
                  <h2 className="h3 mt-4 text-ink">{card.title}</h2>
                  <p className="prose-muted mt-2 text-sm">{card.body}</p>
                </div>
                <span className="mt-auto flex items-center gap-1.5 pt-5 font-display text-sm font-semibold text-accent">
                  {card.cta}
                  <IconArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>

        {/* -------------------------------- EXECUTIVE ANALYTICS CHARTS */}
        <div className="mt-8 space-y-6">
          <div>
            <p className="eyebrow">Executive Analytics</p>
            <h2 className="h2 text-ink">Campus Event Insights</h2>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Monthly Trend Chart */}
            <section className="glass reveal p-6" style={{ "--i": 7 }}>
              <div className="mb-4">
                <h3 className="h3 text-ink">Monthly Event Volume</h3>
                <p className="prose-muted text-xs">Submissions and approval status over time</p>
              </div>

              {analytics.monthly_trends?.length === 0 ? (
                <div className="flex h-64 items-center justify-center text-sm text-muted">
                  {analyticsFailed ? "The trend could not be loaded. Refresh to try again." : "No monthly trend data recorded yet."}
                </div>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analytics.monthly_trends}>
                      <defs>
                        <linearGradient id="colorApproved" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10B981" stopOpacity={0.4}/>
                          <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorPending" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.4}/>
                          <stop offset="95%" stopColor="#F59E0B" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                      <XAxis dataKey="month" stroke="currentColor" className="text-xs text-muted" />
                      <YAxis stroke="currentColor" className="text-xs text-muted" allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "rgba(15, 23, 42, 0.85)",
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                          borderRadius: "12px",
                          color: "#fff",
                        }}
                      />
                      <Legend verticalAlign="top" height={36} />
                      <Area
                        type="monotone"
                        dataKey="approved"
                        name="Approved"
                        stroke="#10B981"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorApproved)"
                      />
                      <Area
                        type="monotone"
                        dataKey="pending"
                        name="Pending"
                        stroke="#F59E0B"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorPending)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            {/* Category Distribution Donut */}
            <section className="glass reveal p-6" style={{ "--i": 8 }}>
              <div className="mb-4">
                <h3 className="h3 text-ink">Category Distribution</h3>
                <p className="prose-muted text-xs">Breakdown of event types across university</p>
              </div>

              {analytics.category_distribution?.length === 0 ? (
                <div className="flex h-64 items-center justify-center text-sm text-muted">
                  {analyticsFailed ? "The categories could not be loaded. Refresh to try again." : "No category data recorded yet."}
                </div>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={analytics.category_distribution}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={4}
                        dataKey="value"
                      >
                        {analytics.category_distribution.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "rgba(15, 23, 42, 0.85)",
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                          borderRadius: "12px",
                          color: "#fff",
                        }}
                      />
                      <Legend layout="horizontal" verticalAlign="bottom" align="center" />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
          </div>

        </div>
      </div>
    </SuperAdminShell>
  );
}

export default SuperAdminDashboard;
