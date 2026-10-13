import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiJson } from "../services/api";
import { checkResearchReminders } from "../services/research";
import { useOriginState } from "../hooks/useOriginState";
import {
  clearAllNotifications,
  deleteNotification,
  evaluateEventReminders,
  fetchNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  timeAgo,
} from "../utils/notificationService";
import Modal from "./teacher/Modal";
import { trackOf } from "./teacher/status";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconAward,
  IconBell,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconEdit,
  IconInbox,
  IconLayers,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
  IconXCircle,
} from "./teacher/icons";

/**
 * How each kind of notification looks. Tints come from the status palette,
 * so a notification about an approval is the same green as the Approved pill.
 */
const TYPE_META = {
  approved: { Icon: IconCheckCircle, track: trackOf("approved"), label: "Approved" },
  rejected: { Icon: IconXCircle, track: trackOf("rejected"), label: "Rejected" },
  // The server emits this whenever a Dean revokes an approval; without an
  // entry here it fell through to the generic bell with no label of its own.
  revoked: { Icon: IconXCircle, track: trackOf("revoked"), label: "Revoked" },
  needs_changes: { Icon: IconAlertTriangle, track: trackOf("pending"), label: "Changes" },
  progress: { Icon: IconActivity, track: trackOf("completed"), label: "Progress" },
  published: { Icon: IconLayers, track: trackOf("published"), label: "Published" },
  reminder: { Icon: IconClock, track: "#0EA5E9", label: "Reminders" },
  submitted: { Icon: IconInbox, track: trackOf("pending"), label: "New" },
  resubmitted: { Icon: IconRefresh, track: trackOf("under_review"), label: "Resubmitted" },
  // Research portfolio (routers/research.py)
  research_verified: { Icon: IconCheckCircle, track: trackOf("approved"), label: "Verified" },
  research_changes: { Icon: IconAlertTriangle, track: trackOf("under_review"), label: "Research changes" },
  research_unverified: { Icon: IconAlertTriangle, track: trackOf("revoked"), label: "Unverified" },
  research_rejected: { Icon: IconXCircle, track: trackOf("rejected"), label: "Research rejected" },
  research_added: { Icon: IconAward, track: trackOf("published"), label: "Research added" },
  research_flagged: { Icon: IconAlertTriangle, track: trackOf("pending"), label: "Correction" },
  research_removed: { Icon: IconTrash, track: trackOf("rejected"), label: "Research removed" },
  research_submitted: { Icon: IconAward, track: trackOf("pending"), label: "Research" },
  research_reminder: { Icon: IconClock, track: trackOf("pending"), label: "Research due" },
  research_showcase: { Icon: IconLayers, track: trackOf("published"), label: "Showcase" },
  research: { Icon: IconAward, track: trackOf("published"), label: "Research" },
};

const FALLBACK_META = { Icon: IconBell, track: "#64748B", label: "Other" };

/** The filter tabs each role gets — only the kinds that role can receive. */
const FILTERS = {
  teacher: ["all", "approved", "rejected", "revoked", "needs_changes", "progress", "reminder", "research"],
  dean: ["all", "submitted", "resubmitted", "research_submitted"],
  superadmin: ["all", "submitted", "approved", "rejected"],
};

const EMPTY_COPY = {
  teacher: "You will be told here when the Dean approves, rejects or moves one of your events.",
  dean: "New and resubmitted events for your review will appear here.",
  superadmin: "System and event activity notifications will appear here.",
};

const POLL_INTERVAL_MS = 30_000;
const TOAST_MS = 6_000;

/**
 * Every page mounts its own bell, so without this the reminder check would
 * re-run on each navigation. Once per user per interval is plenty; a check
 * that was cut short (unmount) does not count.
 */
const REMINDER_RECHECK_MS = 10 * 60 * 1000;
const lastReminderCheck = new Map(); // userId -> timestamp
const lastResearchCheck = new Map(); // userId -> timestamp, research outcomes due

/**
 * The last feed fetched, kept across bells for the same reason: a click in the
 * sidebar mounts a new bell, which would otherwise ask the server again at once.
 * A list younger than the poll interval is shown as-is and the next poll is due
 * when it would have been. `knownIds` travels with it, so a notification that
 * lands during a navigation still raises its toast.
 */
let lastFeed = null; // { userId, at, list, knownIds }

/**
 * The notification bell, for every role that has one.
 *
 * Polls the signed-in user's own feed. Anything that arrives after the first
 * load also raises a toast, and `onNew` lets the page behind it refresh — the
 * Dean dashboard uses it to update its counts when a submission comes in.
 *
 * For teachers it also runs the event-day reminder check once per visit, so
 * "your event is tomorrow" notices are created without any server scheduler.
 */
export default function NotificationBell({ currentUser, onNew }) {
  const navigate = useNavigate();
  const originState = useOriginState();
  const wrapRef = useRef(null);
  const knownIds = useRef(null);
  // The latest callback, without restarting the poll every time the parent
  // re-renders and hands over a new function.
  const onNewRef = useRef(onNew);
  useEffect(() => {
    onNewRef.current = onNew;
  }, [onNew]);

  const [notifications, setNotifications] = useState(() =>
    lastFeed && lastFeed.userId === currentUser?.id ? lastFeed.list : []
  );
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState([]);

  const [historySearch, setHistorySearch] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");

  const userId = currentUser?.id;
  const role = currentUser?.role === "dean" ? "dean" : "teacher";

  // Every change to the list goes through here, so the shared copy the next
  // bell starts from never shows a notification this one already removed.
  const setFeed = useCallback(
    (update) =>
      setNotifications((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        if (lastFeed?.userId === userId) lastFeed.list = next;
        return next;
      }),
    [userId]
  );

  const eventPath = (id) => (role === "dean" ? `/dean/events/${id}` : `/teacher/events/${id}`);

  // A research notification names a record, opened in the reader's own panel.
  const RESEARCH_BASE = { dean: "/dean", event_manager: "/event_manager", teacher: "/teacher" };
  const researchPath = (id) => `${RESEARCH_BASE[currentUser?.role] || "/teacher"}/research/${id}`;
  const researchIdOf = (notif) => notif.data?.research_id;

  /* ---- Fetch, and spot what is new since the last look ---- */
  const loadNotifications = useCallback(async () => {
    if (!userId) return [];
    try {
      setLoading(true);
      const list = await fetchNotifications(userId);

      if (knownIds.current === null) {
        // First load: everything already there is history, not news.
        knownIds.current = new Set(list.map((n) => n.id));
      } else {
        const fresh = list.filter((n) => !n.is_read && !knownIds.current.has(n.id));
        list.forEach((n) => knownIds.current.add(n.id));

        if (fresh.length > 0) {
          setToasts((prev) => [...fresh.slice(0, 3), ...prev].slice(0, 3));
          onNewRef.current?.(fresh);
        }
      }

      lastFeed = { userId, at: Date.now(), list, knownIds: knownIds.current };
      setFeed(list);
      return list;
    } catch (err) {
      console.warn("NotificationBell: fetch error", err);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId, setFeed]);

  // Poll only while the tab is visible; a hidden tab (possibly one of many)
  // stops, and catches up immediately when it is shown again.
  useEffect(() => {
    let timer = null;
    let interval = null;

    // The first poll after `delay`, then one every interval.
    const start = (delay = POLL_INTERVAL_MS) => {
      if (timer !== null || interval !== null) return;
      timer = setTimeout(() => {
        timer = null;
        loadNotifications();
        interval = setInterval(loadNotifications, POLL_INTERVAL_MS);
      }, delay);
    };
    const stop = () => {
      clearTimeout(timer);
      clearInterval(interval);
      timer = null;
      interval = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        loadNotifications();
        start();
      }
    };

    const cached = userId && lastFeed?.userId === userId ? lastFeed : null;
    const age = cached ? Date.now() - cached.at : Infinity;
    knownIds.current = cached ? cached.knownIds : null;
    if (age < POLL_INTERVAL_MS) {
      // Fetched moments ago by the bell on the previous page.
      setFeed(cached.list);
      if (!document.hidden) start(POLL_INTERVAL_MS - age);
    } else {
      loadNotifications();
      if (!document.hidden) start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadNotifications, setFeed, userId]);

  /* ---- Research outcomes due (patents to update ...), once per visit ----
     The server decides what is due and never repeats itself, so this only
     has to ask now and then. */
  const researchRole = currentUser?.role;
  useEffect(() => {
    if (!userId || (researchRole !== "teacher" && researchRole !== "event_manager")) return undefined;
    if (Date.now() - (lastResearchCheck.get(userId) || 0) < REMINDER_RECHECK_MS) return undefined;
    let cancelled = false;
    lastResearchCheck.set(userId, Date.now());
    checkResearchReminders()
      .then(async (body) => {
        if (cancelled || !body?.created) return;
        const list = await fetchNotifications(userId);
        if (cancelled) return;
        list.forEach((n) => knownIds.current?.add(n.id));
        setFeed(list);
      })
      .catch((err) => console.warn("Research reminder check skipped:", err));
    return () => {
      cancelled = true;
    };
  }, [userId, researchRole]);

  /* ---- Teachers: event-day reminders, once per visit ---- */
  useEffect(() => {
    if (!userId || role !== "teacher") return undefined;
    const last = lastReminderCheck.get(userId) || 0;
    if (Date.now() - last < REMINDER_RECHECK_MS) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const [{ events = [] } = {}, existing] = await Promise.all([
          apiJson("/teacher/events"),
          fetchNotifications(userId),
        ]);
        if (cancelled) return;
        const created = await evaluateEventReminders(userId, events, existing, {
          isCancelled: () => cancelled,
        });
        if (!cancelled) lastReminderCheck.set(userId, Date.now());
        if (created && !cancelled) {
          // Reminders are generated on this device; they are not "news" to toast.
          const list = await fetchNotifications(userId);
          list.forEach((n) => knownIds.current?.add(n.id));
          setFeed(list);
        }
      } catch (err) {
        console.warn("Reminder check skipped:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, role]);

  /* ---- Toasts clear themselves ---- */
  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timer = setTimeout(() => setToasts((prev) => prev.slice(0, -1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  /* ---- Close on outside click or Escape ---- */
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  /* ---- Actions ---- */
  const markRead = async (notif) => {
    if (notif.is_read) return;
    setFeed((prev) =>
      prev.map((n) => (n.id === notif.id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n))
    );
    await markNotificationAsRead(userId, notif.id);
  };

  const markAllRead = async () => {
    setFeed((prev) =>
      prev.map((n) => ({ ...n, is_read: true, read_at: n.read_at || new Date().toISOString() }))
    );
    await markAllNotificationsAsRead(userId);
  };

  const deleteItem = async (notifId) => {
    if (!notifId) return;
    setFeed((prev) => prev.filter((n) => n.id !== notifId));
    setToasts((prev) => prev.filter((t) => t.id !== notifId));
    await deleteNotification(userId, notifId);
  };

  const handleClearAll = () => {
    if (notifications.length === 0) return;
    setConfirmClearOpen(true);
  };

  const handleConfirmClear = async () => {
    if (notifications.length === 0) {
      setConfirmClearOpen(false);
      return;
    }
    setClearing(true);
    try {
      setFeed([]);
      setToasts([]);
      await clearAllNotifications(userId);
    } catch (err) {
      console.error("Failed to clear notifications:", err);
    } finally {
      setClearing(false);
      setConfirmClearOpen(false);
    }
  };

  /** Open the event — the page that carries its status, history and remarks. */
  const openNotification = (notif) => {
    markRead(notif);
    setOpen(false);
    setHistoryOpen(false);
    setToasts((prev) => prev.filter((t) => t.id !== notif.id));

    const researchId = researchIdOf(notif);
    if (researchId) {
      navigate(researchPath(researchId));
      return;
    }
    const base = RESEARCH_BASE[currentUser?.role] || "/teacher";
    if (notif.data?.research_list) {
      navigate(`${base}/research`);
      return;
    }
    const eventId = notif.event_id || notif.data?.event_id;
    if (eventId) navigate(eventPath(eventId));
  };

  const editAndResubmit = (notif) => {
    markRead(notif);
    setOpen(false);
    setHistoryOpen(false);
    // Back from the wizard returns to the page the bell was opened on.
    navigate(`/teacher/create-event?editEventId=${notif.event_id}`, { state: originState });
  };

  const filteredHistory = notifications.filter((n) => {
    if (
      historyFilter !== "all" &&
      (historyFilter === "research"
        ? !n.notification_type?.startsWith("research_")
        : n.notification_type !== historyFilter)
    ) {
      return false;
    }
    const q = historySearch.trim().toLowerCase();
    if (!q) return true;
    return [n.title, n.message, n.data?.event_name].some((field) =>
      String(field || "").toLowerCase().includes(q)
    );
  });

  /* ---- One notification row ---- */
  const renderItem = (notif, compact) => {
    const meta = TYPE_META[notif.notification_type] || FALLBACK_META;
    const canEdit =
      role === "teacher" &&
      notif.event_id &&
      (notif.notification_type === "rejected" ||
        notif.notification_type === "revoked" ||
        notif.notification_type === "needs_changes");

    return (
      <li key={notif.id} className="border-b hairline last:border-b-0">
        <div
          role="button"
          tabIndex={0}
          onClick={() => openNotification(notif)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openNotification(notif))}
          className={`group flex cursor-pointer gap-3.5 transition hover:bg-raised/45 ${
            compact ? "px-4 py-3.5" : "px-6 py-4"
          } ${
            notif.is_read
              ? ""
              : compact
              ? "bg-accent/4"
              : "bg-accent/[0.04] border-l-2 border-l-accent"
          }`}
        >
          <span
            className={`icon-tile icon-tile-track shrink-0 rounded-lg ${
              compact ? "h-8 w-8" : "h-9 w-9 sm:h-10 sm:w-10 sm:rounded-xl"
            }`}
            style={{ "--track": meta.track }}
          >
            <meta.Icon className={compact ? "h-4 w-4" : "h-4.5 w-4.5 sm:h-5 sm:w-5"} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2.5">
              <p
                className={`leading-snug text-ink ${
                  compact ? "text-sm" : "text-sm sm:text-base"
                } ${notif.is_read ? "font-medium" : "font-semibold"}`}
              >
                {notif.title || "Notification"}
              </p>
              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                <span className="flex items-center gap-1.5 text-[11px] sm:text-xs text-muted font-medium">
                  {!notif.is_read && (
                    <span className="dot dot-sm" style={{ "--track": meta.track }} aria-label="Unread" />
                  )}
                  {timeAgo(notif.created_at)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteItem(notif.id);
                  }}
                  className="rounded-lg p-1.5 text-muted transition hover:bg-err/10 hover:text-err"
                  title="Delete notification"
                  aria-label="Delete notification"
                >
                  <IconTrash className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </button>
              </div>
            </div>

            <p
              className={`text-muted mt-1 ${
                compact ? "line-clamp-2 text-xs" : "text-xs sm:text-sm leading-relaxed"
              }`}
            >
              {notif.message}
            </p>

            {(researchIdOf(notif) || notif.data?.research_list) && (
              <div className={`flex flex-wrap gap-1.5 ${compact ? "mt-2" : "mt-3"}`}>
                <span className="btn btn-ghost btn-xs text-ink inline-flex items-center gap-1">
                  {notif.data?.research_list ? "View research" : "View record"}
                  <IconArrowRight className="h-3 w-3" />
                </span>
              </div>
            )}

            {notif.event_id && (
              <div className={`flex flex-wrap gap-1.5 ${compact ? "mt-2" : "mt-3"}`}>
                <span className="btn btn-ghost btn-xs text-ink inline-flex items-center gap-1">
                  View event
                  <IconArrowRight className="h-3 w-3" />
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      editAndResubmit(notif);
                    }}
                    className="btn btn-ghost btn-xs text-ink inline-flex items-center gap-1"
                  >
                    <IconEdit className="h-3 w-3" />
                    Edit &amp; resubmit
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </li>
    );
  };

  const emptyState = (title, body) => (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="icon-tile mb-3 h-12 w-12 rounded-2xl">
        <IconInbox className="h-5 w-5" />
      </span>
      <p className="font-display text-sm font-semibold text-ink">{title}</p>
      <p className="prose-muted mt-1 max-w-xs text-xs">{body}</p>
    </div>
  );

  return (
    <div ref={wrapRef} className="relative">
      {/* -------------------------------------------------------- the bell */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="icon-btn icon-btn-sm relative sm:h-11 sm:w-11 sm:rounded-xl"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        title="Notifications"
      >
        <IconBell />
        {unreadCount > 0 && (
          <span className="num absolute -right-1 -top-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-ember px-1 text-[10px] font-bold text-[#12100a]">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* ------------------------------------------------------- the panel
          On a phone the bell is not at the screen edge (the menu button sits
          beside it), so a panel hung from the bell would run off the left.
          There it spans the width under the header instead — `fixed` resolves
          against the header, whose backdrop-filter makes it the containing
          block — and from sm up it drops from the bell as usual. */}
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="hv-popover glass glass-blur fixed inset-x-3 top-full z-50 mt-2 flex max-h-[min(32rem,80vh)] flex-col overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:w-[min(23rem,calc(100vw-1.5rem))]"
        >
          <div className="flex items-center justify-between gap-3 border-b hairline px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="font-display text-sm font-semibold text-ink">Notifications</p>
              {unreadCount > 0 && <span className="chip chip-sm chip-ember">{unreadCount} new</span>}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="icon-btn icon-btn-sm"
              aria-label="Close notifications"
            >
              <IconX />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-muted">
                <span className="spin h-4 w-4 text-accent" />
                Loading…
              </div>
            ) : notifications.length === 0 ? (
              emptyState("No notifications yet", EMPTY_COPY[role])
            ) : (
              <ul>{notifications.slice(0, 8).map((n) => renderItem(n, true))}</ul>
            )}
          </div>

          {notifications.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t hairline px-4 py-2.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={unreadCount === 0}
                  className="btn btn-ghost btn-xs"
                >
                  <IconCheck />
                  Mark read
                </button>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="btn btn-ghost btn-xs text-err hover:border-err/50"
                  title="Clear all notifications"
                >
                  <IconTrash />
                  Clear all
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setHistoryOpen(true);
                }}
                className="link text-xs font-semibold"
              >
                View all
              </button>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------ the full history */}
      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        eyebrow="Inbox"
        title="All notifications"
        subtitle={`${notifications.length} total · ${unreadCount} unread`}
        wide
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
                : "All notifications read"}
            </span>
            <button type="button" onClick={() => setHistoryOpen(false)} className="btn btn-brand btn-sm">
              Close
            </button>
          </div>
        }
      >
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
            <IconSearch className="h-4 w-4" />
          </span>
          <input
            type="text"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            placeholder="Search by title, message or event…"
            aria-label="Search notifications"
            className="input pl-10 pr-9 text-sm"
          />
          {historySearch && (
            <button
              type="button"
              onClick={() => setHistorySearch("")}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted transition hover:text-ink"
              aria-label="Clear search"
            >
              <IconX className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter notifications">
          {(FILTERS[role] || ["all"]).map((key) => {
            const count =
              key === "all"
                ? notifications.length
                : notifications.filter((n) =>
                    key === "research"
                      ? n.notification_type?.startsWith("research_")
                      : n.notification_type === key
                  ).length;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={historyFilter === key}
                onClick={() => setHistoryFilter(key)}
                className="tab text-xs sm:text-sm"
              >
                {key === "all" ? "All" : (TYPE_META[key] || FALLBACK_META).label}
                <span className="tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Action bar at top of list */}
        <div className="-mx-6 mt-4 flex items-center justify-between border-y hairline bg-raised/35 px-6 py-2.5">
          <span className="text-xs font-medium text-muted">
            {filteredHistory.length} {filteredHistory.length === 1 ? "notification" : "notifications"}
            {unreadCount > 0 && ` · ${unreadCount} unread`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="btn btn-ghost btn-xs text-ink disabled:opacity-40"
              title="Mark all notifications as read"
            >
              <IconCheck className="h-3.5 w-3.5" />
              Mark read
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              disabled={notifications.length === 0}
              className="btn btn-ghost btn-xs text-err hover:border-err/50 hover:bg-err/10 disabled:opacity-40"
              title="Clear all notifications"
            >
              <IconTrash className="h-3.5 w-3.5" />
              Clear all
            </button>
          </div>
        </div>

        <div className="-mx-6">
          {notifications.length === 0 ? (
            emptyState("No notifications yet", EMPTY_COPY[role] || EMPTY_COPY.dean)
          ) : filteredHistory.length === 0 ? (
            emptyState("Nothing matches", "Try a different search or filter.")
          ) : (
            <ul>{filteredHistory.map((n) => renderItem(n, false))}</ul>
          )}
        </div>
      </Modal>

      {/* ----------------------------- Clear all confirmation dialog */}
      <Modal
        open={confirmClearOpen}
        onClose={() => !clearing && setConfirmClearOpen(false)}
        eyebrow="Confirm"
        title="Clear all notifications"
        subtitle="This action cannot be undone"
        zIndex={70}
        footer={
          <div className="flex w-full items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setConfirmClearOpen(false)}
              disabled={clearing}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmClear}
              disabled={clearing}
              className="btn btn-danger btn-sm"
            >
              <IconTrash className="h-4 w-4" />
              {clearing ? "Clearing…" : "Clear all"}
            </button>
          </div>
        }
      >
        <div className="flex items-start gap-3.5">
          <span
            className="icon-tile icon-tile-track shrink-0 h-10 w-10 rounded-xl"
            style={{ "--track": "#EF4444" }}
          >
            <IconTrash className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              Are you sure you want to clear all notifications?
            </p>
            <p className="mt-1 text-xs text-muted leading-relaxed">
              This will permanently remove all {notifications.length} notification{notifications.length === 1 ? "" : "s"} from your inbox.
            </p>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- toasts */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
          {toasts.map((notif) => {
            const meta = TYPE_META[notif.notification_type] || FALLBACK_META;
            return (
              <div key={notif.id} className="toast pointer-events-auto" role="status">
                <span
                  className="icon-tile icon-tile-track h-9 w-9 shrink-0 rounded-xl"
                  style={{ "--track": meta.track }}
                >
                  <meta.Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-display text-sm font-semibold text-ink">{notif.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted">{notif.message}</p>
                  {(notif.event_id || researchIdOf(notif) || notif.data?.research_list) && (
                    <button
                      type="button"
                      onClick={() => openNotification(notif)}
                      className="link mt-1.5 font-display text-xs font-semibold"
                    >
                      {notif.event_id ? "View event →" : "View →"}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setToasts((prev) => prev.filter((t) => t.id !== notif.id))}
                  aria-label="Dismiss notification"
                  className="shrink-0 text-muted transition hover:text-ink"
                >
                  <IconX className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
