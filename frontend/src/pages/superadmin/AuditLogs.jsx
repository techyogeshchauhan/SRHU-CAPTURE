import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiJson, isAbortError } from "../../services/api";
import useLatestRead from "../../hooks/useLatestRead";
import { useAuth } from "../../context/AuthContext";
import SuperAdminShell from "../../components/superadmin/SuperAdminShell";
import PageHero from "../../components/teacher/PageHero";
import Pagination from "../../components/common/Pagination";
import {
  IconActivity,
  IconAlertTriangle,
  IconInbox,
  IconRefresh,
  IconSearch,
  IconShield,
} from "../../components/teacher/icons";

const ACTION_FILTERS = [
  { key: "all", label: "All Actions" },
  { key: "role_change", label: "Role Changes" },
  { key: "user_deactivated", label: "Deactivations" },
  { key: "user_activated", label: "Activations" },
  { key: "user_password_reset", label: "Password Resets" },
  { key: "user_profile_updated", label: "Profile Updates" },
  { key: "dean_created", label: "Dean Created" },
  { key: "event_manager_created", label: "Event Manager Created" },
  { key: "event_manager_invite_resent", label: "Invites Resent" },
  { key: "teachers_bulk_onboarded", label: "Bulk Onboarding" },
  { key: "teachers_credentials_sent", label: "Credentials Sent" },
  { key: "user_deleted", label: "User Deletions" },
  { key: "event_deleted", label: "Event Deletions" },
  { key: "events_bulk_deleted", label: "Bulk Event Deletions" },
  { key: "upload_limits_updated", label: "Upload Limits" },
  { key: "upload_limits_reset", label: "Limits Reset" },
  { key: "events_exported", label: "Exports" },
];

const TABLE_COLUMNS = ["Timestamp", "Action", "Actor", "Target & Details"];

const formatTimestamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const actionTone = (action) => {
  if (action?.includes("deleted") || action?.includes("deactivated")) {
    return "bg-err/10 text-err border-err/30";
  }
  if (action?.includes("created") || action?.includes("activated")) {
    return "bg-ok/10 text-ok border-ok/30";
  }
  if (action?.includes("reset") || action?.includes("role")) {
    return "chip-ember";
  }
  return "bg-accent/10 text-accent border-accent/30";
};

const formatActionLabel = (action) => {
  if (!action) return "Unknown";
  return action
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

export default function AuditLogs() {
  const beginRead = useLatestRead();
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const rawPer = Number(searchParams.get("per")) || 25;
  const per = [25, 50, 100].includes(rawPer) ? rawPer : 25;
  const skip = (page - 1) * per;

  const urlQ = searchParams.get("q") || "";
  const [searchDraft, setSearchDraft] = useState(urlQ);

  useEffect(() => {
    setSearchDraft(urlQ);
  }, [urlQ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed !== urlQ) {
        const next = new URLSearchParams(searchParams);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        next.delete("page");
        setSearchParams(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, urlQ, searchParams, setSearchParams]);

  const actionFilter = ACTION_FILTERS.some((t) => t.key === searchParams.get("action"))
    ? searchParams.get("action")
    : "all";

  const setActionFilter = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key === "all") next.delete("action");
    else next.set("action", key);
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const setPage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage > 1) next.set("page", String(nextPage));
    else next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const setPerPage = (nextPer) => {
    const next = new URLSearchParams(searchParams);
    if (nextPer !== 25) next.set("per", String(nextPer));
    else next.delete("per");
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const loadLogs = useCallback(async () => {
    const controller = beginRead();
    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams({
        skip: String(skip),
        limit: String(per),
      });
      if (actionFilter !== "all") params.set("action", actionFilter);
      if (urlQ) params.set("q", urlQ);

      const res = await apiJson(`/superadmin/audit-logs?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setLogs(res?.logs || []);
      setTotal(res?.total || 0);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      if (err?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      console.error("Load audit logs error:", err);
      setError(err?.message || "Failed to load audit logs.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [skip, per, actionFilter, urlQ, navigate, beginRead]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <SuperAdminShell
      active="audit-logs"
      profile={profile}
      onLogout={handleLogout}
      railNote="Immutable administrative log of all critical system mutations and security-sensitive events."
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">
        <PageHero
          eyebrow="Security & Governance"
          title="System Audit"
          accent="Logs"
          subtitle="Complete audit trail of role modifications, user activations, password resets, upload limits, and administrative overrides."
          actions={
            <button
              type="button"
              onClick={loadLogs}
              disabled={loading}
              className="btn btn-ghost"
            >
              {loading ? <span className="spin h-4 w-4" /> : <IconRefresh />}
              Refresh
            </button>
          }
        />

        {error && (
          <div className="toast toast-err mt-6" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="flex-1 text-sm font-medium text-ink">{error}</p>
          </div>
        )}

        {/* ----------------------------------------------------- toolbar */}
        <div className="reveal mt-7 flex flex-col gap-3 md:flex-row md:items-center md:justify-between" style={{ "--i": 1 }}>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by action">
            {ACTION_FILTERS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={actionFilter === tab.key}
                onClick={() => setActionFilter(tab.key)}
                className="tab text-xs"
              >
                {tab.label}
              </button>
            ))}
          </div>

          <label className="relative block w-full md:w-72">
            <span className="sr-only">Search audit logs</span>
            <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search actor, action, or the person or event affected"
              className="input pl-10"
            />
          </label>
        </div>

        {/* ----------------------------------------------------- results */}
        <section className="glass reveal mt-4 overflow-hidden" style={{ "--i": 2 }}>
          <div className="flex items-center justify-between gap-3 border-b hairline px-5 py-4">
            <div>
              <p className="eyebrow">Audit Trail</p>
              <h2 className="h3 text-ink">Recorded Operations</h2>
            </div>
            {!loading && (
              <p className="num text-sm text-muted">
                <span className="font-semibold text-ink">
                  {total === 0 ? 0 : `${skip + 1}–${Math.min(skip + logs.length, total)}`}
                </span>
                {" of "}
                {total}
              </p>
            )}
          </div>

          {loading ? (
            <div className="px-6 py-16 text-center">
              <span className="spin mx-auto mb-4 block h-9 w-9 text-accent" />
              <p className="prose-muted text-sm">Loading audit logs…</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <span className="icon-tile mx-auto">
                <IconInbox />
              </span>
              <p className="h3 mt-4 text-ink">
                {total === 0 && !urlQ && actionFilter === "all" ? "No audit records yet" : "No matches"}
              </p>
              <p className="prose-muted mt-1 text-sm">
                {total === 0 && !urlQ && actionFilter === "all"
                  ? "Security and administrative actions will appear here automatically."
                  : "Try a different search query or clear the filter."}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile View */}
              <ul className="divide-y divide-line/8 md:hidden">
                {logs.map((log) => (
                  <li key={log.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-2">
                      <span className={`chip chip-sm ${actionTone(log.action)}`}>
                        {formatActionLabel(log.action)}
                      </span>
                      <span className="text-[11px] text-muted">
                        {formatTimestamp(log.created_at)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs">
                      <span className="font-semibold text-ink">{log.actor_name}</span>
                      <span className="text-muted"> ({log.actor_email})</span>
                    </div>
                    {log.details && Object.keys(log.details).length > 0 && (
                      <div className="mt-2 rounded-xl bg-raised/60 p-2 text-xs font-mono text-muted">
                        {Object.entries(log.details).map(([k, v]) => (
                          <div key={k} className="truncate">
                            <span className="font-semibold text-ink">{k}: </span>
                            <span>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {/* Desktop Table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b hairline bg-raised/40">
                      {TABLE_COLUMNS.map((col) => (
                        <th
                          key={col}
                          scope="col"
                          className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/8">
                    {logs.map((log) => (
                      <tr key={log.id} className="transition hover:bg-raised/40">
                        <td className="whitespace-nowrap px-5 py-3.5 text-xs text-muted">
                          {formatTimestamp(log.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <span className={`chip chip-sm ${actionTone(log.action)}`}>
                            {formatActionLabel(log.action)}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="text-xs">
                            <p className="font-semibold text-ink">{log.actor_name}</p>
                            <p className="prose-muted truncate">{log.actor_email}</p>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-xs">
                          <div className="max-w-md">
                            <span className="chip chip-sm chip-solid font-mono text-[10px]">
                              {log.target_type}
                            </span>
                            {log.details && Object.keys(log.details).length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted">
                                {Object.entries(log.details).map(([k, v]) => (
                                  <span key={k} className="inline-block">
                                    <strong className="text-ink font-medium">{k}:</strong>{" "}
                                    {typeof v === "object" ? JSON.stringify(v) : String(v)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {total > 0 && (
            <Pagination
              page={page}
              perPage={per}
              total={total}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
              disabled={loading}
            />
          )}
        </section>
      </div>
    </SuperAdminShell>
  );
}
