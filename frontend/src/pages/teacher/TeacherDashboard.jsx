import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiJson } from "../../services/api";
import { useOriginState } from "../../hooks/useOriginState";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { canTeacherEditEvent, getRefusalReason } from "../../utils/constants";
import {
  getTeacherDrafts,
  deleteTeacherDraft,
  duplicateEventAsDraft,
  decodeEventMetadata,
} from "../../utils/draftStorage";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { downloadEventReport } from "../../services/eventManager";
import PageHero from "../../components/teacher/PageHero";
import Modal from "../../components/teacher/Modal";
import Lifecycle from "../../components/teacher/Lifecycle";
import StatusChip from "../../components/teacher/StatusChip";
import StatCard from "../../components/common/StatCard";
import {
  isApprovedStatus,
  isPendingStatus,
  isRefusedStatus,
  trackOf,
} from "../../components/teacher/status";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEye,
  IconInbox,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconXCircle,
} from "../../components/teacher/icons";

const TABLE_COLUMNS = ["Event", "Date", "Venue", "Status", "Action"];

function TeacherDashboard() {
  const navigate = useNavigate();
  const originState = useOriginState();
  const panel = usePanel();

  const [profile, setProfile] = useState(null);
  const [events, setEvents] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Modals state
  const [trackingEvent, setTrackingEvent] = useState(null);
  const [deletingEvent, setDeletingEvent] = useState(null);
  const [deletingLoading, setDeletingLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState("");

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      setLoadError("");

      const userProfile = await fetchCurrentUser();

      if (!userProfile) {
        navigate("/login", { replace: true });
        return;
      }

      if (userProfile.role !== panel.role) {
        navigate("/", { replace: true });
        return;
      }

      setProfile(userProfile);

      // Fetch teacher's events from the API (MongoDB)
      const { events: teacherEvents } = await apiJson(`${panel.api}/events`);

      // Fetch teacher's local drafts
      const teacherDrafts = getTeacherDrafts(userProfile.id);

      setEvents(teacherEvents || []);
      setDrafts(teacherDrafts || []);
    } catch (error) {
      console.error("Dashboard error:", error);
      if (error?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      // Without this the dashboard would show zeros as if there were no events.
      setLoadError(error?.message || "Unable to load your events right now.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  // Actions
  const handleDuplicate = (targetEvent) => {
    if (!profile) return;
    try {
      const newDraft = duplicateEventAsDraft(profile.id, targetEvent);
      setActionNotice(`Event "${targetEvent.event_name || targetEvent.eventName}" duplicated as draft.`);
      setTimeout(() => {
        navigate(`${panel.base}/create-event?draftId=${newDraft.id}`, { state: originState });
      }, 700);
    } catch (err) {
      console.error("Duplicate error:", err);
      alert("Failed to duplicate event.");
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingEvent || !profile) return;
    try {
      setDeletingLoading(true);
      if (deletingEvent.isDraft) {
        deleteTeacherDraft(profile.id, deletingEvent.id);
      } else {
        await apiJson(`${panel.api}/events/${deletingEvent.id}`, { method: "DELETE" });
      }

      setActionNotice("Event deleted successfully.");
      setDeletingEvent(null);
      await fetchDashboardData();
      setTimeout(() => setActionNotice(""), 3500);
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete event: " + (err.message || "Unknown error"));
    } finally {
      setDeletingLoading(false);
    }
  };

  // Summary counts
  const totalEvents = events.length + drafts.length;
  const pendingEvents = events.filter((event) => isPendingStatus(event.status)).length;
  const approvedEvents = events.filter((event) => isApprovedStatus(event.status)).length;
  // Revoked belongs here: it is the Dean refusing the event, and leaving it
  // out meant a revoked event was in total_events and in no tile at all.
  const rejectedEvents = events.filter((event) => isRefusedStatus(event.status)).length;

  // Combine and sort recent events
  const recentCombinedList = [
    ...drafts.map((d) => ({ ...d, isDraft: true, status: "draft" })),
    ...events.map((e) => ({ ...e, isDraft: false })),
  ].sort((a, b) => {
    const timeA = new Date(a.updated_at || a.created_at || 0).getTime();
    const timeB = new Date(b.updated_at || b.created_at || 0).getTime();
    return timeB - timeA;
  });

  const recordedEvents = events.filter((event) => event.status === "recorded").length;

  // Without a Dean there is nothing pending, approved or rejected: an Event
  // Manager's events are either saved (recorded) or still drafts.
  const summaryCards = !panel.approval ? [
    {
      key: "all",
      label: "Total Events",
      value: totalEvents,
      hint: "View all",
      track: "#0EA5E9",
      Icon: IconLayers,
    },
    {
      key: "recorded",
      label: "Recorded",
      value: recordedEvents,
      hint: "View recorded",
      track: trackOf("recorded"),
      Icon: IconCheckCircle,
    },
    {
      key: "draft",
      label: "Drafts",
      value: drafts.length + events.filter((event) => event.status === "draft").length,
      hint: "View drafts",
      track: trackOf("draft"),
      Icon: IconClock,
    },
  ] : [
    {
      key: "all",
      label: "Total Events",
      value: totalEvents,
      hint: "View all",
      track: "#0EA5E9",
      Icon: IconLayers,
    },
    {
      key: "pending",
      label: "Pending",
      value: pendingEvents,
      hint: "View pending",
      track: trackOf("pending"),
      Icon: IconClock,
    },
    {
      key: "approved",
      label: "Approved",
      value: approvedEvents,
      hint: "View approved",
      track: trackOf("approved"),
      Icon: IconCheckCircle,
    },
    {
      key: "rejected",
      label: "Rejected",
      value: rejectedEvents,
      hint: "View rejected",
      track: trackOf("rejected"),
      Icon: IconXCircle,
    },
  ];

  if (loading) {
    return (
      <div className="hv-root flex min-h-screen items-center justify-center">
        <div className="text-center">
          <span className="spin mx-auto mb-4 block h-10 w-10 text-accent" />
          <p className="prose-muted text-sm">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <TeacherShell
      active="dashboard"
      profile={profile}
      onLogout={handleLogout}
      railBadge={totalEvents}
      railNote={
        panel.approval
          ? "Review event status, duplicate previous proposals, or submit new ones."
          : "Record events, duplicate previous ones, and download their reports."
      }
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">

        {loadError && (
          <div className="toast toast-err mb-6" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">
              {loadError} The counts below may be incomplete.
            </p>
            <button
              type="button"
              onClick={fetchDashboardData}
              className="btn btn-ghost btn-xs shrink-0"
            >
              <IconRefresh />
              Retry
            </button>
          </div>
        )}

        {actionNotice && (
          <div className="toast toast-ok mb-6" role="status">
            <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
            <p className="text-sm font-medium text-ink">{actionNotice}</p>
          </div>
        )}

        <PageHero
          eyebrow="Overview"
          title={panel.approval ? "Teacher" : "Event Manager"}
          accent="Portal"
          subtitle={`Welcome back, ${profile?.name || panel.roleLabel}. Manage your campus events and proposals from one place.`}
          actions={
            <Link
              to={`${panel.base}/create-event`}
              state={originState}
              className="btn btn-primary"
            >
              <IconPlus />
              Create New Event
            </Link>
          }
        />

        {/* ------------------------------------------------ summary cards
            The shared KPI card, identical on the Dean and Super Admin
            dashboards. */}
        <div className={`mt-6 grid gap-3 sm:gap-4 ${summaryCards.length === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2 lg:grid-cols-4"}`}>
          {summaryCards.map((card, i) => (
            <StatCard
              key={card.key}
              index={i}
              to={`${panel.base}/my-events?filter=${card.key}`}
              label={card.label}
              value={card.value}
              Icon={card.Icon}
              track={card.track}
              hint={card.hint}
            />
          ))}
        </div>

        {/* ------------------------------------------------- recent events
            Same 1.5rem gap as hero -> cards, so the three blocks sit on one
            even rhythm. */}
        <section className="glass mt-6 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline px-5 py-5 sm:px-6">
            <div>
              <p className="eyebrow">Activity</p>
              <h2 className="h3 mt-1 text-ink">Recent Events</h2>
              <p className="prose-muted mt-0.5 text-sm">
                Your recently created, modified, or submitted events
              </p>
            </div>

            <Link to={`${panel.base}/my-events`} className="btn btn-ghost btn-sm">
              View All Events
              <IconArrowRight />
            </Link>
          </div>

          {recentCombinedList.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
                <IconInbox className="h-6 w-6" />
              </span>
              <p className="h3 text-ink">Nothing here yet</p>
              <p className="prose-muted mt-1 text-sm">
                No events submitted or saved yet.
              </p>
              <Link
                to={`${panel.base}/create-event`}
                state={originState}
                className="btn btn-primary mt-6"
              >
                <IconPlus />
                Create Your First Event
              </Link>
            </div>
          ) : (
            <>
              {/* Phone: a table cannot carry this much context at 390px, so
                  each event becomes a card. */}
              <ul className="divide-y divide-line/8 md:hidden">
                {recentCombinedList.slice(0, 6).map((item) => (
                  <li key={item.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 truncate font-display text-sm font-semibold text-ink">
                        {item.event_name || item.eventName || "Untitled Draft"}
                      </p>
                      <StatusChip status={item.status} />
                    </div>
                    <p className="prose-muted mt-1 text-xs">
                      {[item.event_date || item.eventDate, item.location]
                        .filter(Boolean)
                        .join(" · ") || "Nothing set yet"}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <RowActions
                        item={item}
                        onDuplicate={handleDuplicate}
                        onDelete={setDeletingEvent}
                        onTrack={setTrackingEvent}
                        originState={originState}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b hairline bg-raised/45">
                      {TABLE_COLUMNS.map((column) => (
                        <th
                          key={column}
                          className={`whitespace-nowrap px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[.12em] text-muted ${
                            column === "Action" ? "text-right" : ""
                          }`}
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-line/8">
                    {recentCombinedList.slice(0, 6).map((item) => {
                      const { description: cleanDesc } = decodeEventMetadata(item.description || "");

                      return (
                        <tr key={item.id} className="transition hover:bg-raised/35">
                          <td className="max-w-72 px-5 py-3.5">
                            <p className="truncate font-display text-sm font-semibold text-ink">
                              {item.event_name || item.eventName || "Untitled Draft"}
                            </p>
                            <p className="truncate text-xs text-muted">
                              {cleanDesc || item.event_type || "No description"}
                            </p>
                          </td>

                          <td className="whitespace-nowrap px-5 py-3.5 text-sm text-muted">
                            {item.event_date || item.eventDate || <NotSet />}
                          </td>

                          <td className="max-w-48 px-5 py-3.5 text-sm text-muted">
                            <span className="block truncate">
                              {item.location || <NotSet />}
                            </span>
                          </td>

                          <td className="whitespace-nowrap px-5 py-3.5">
                            <StatusChip status={item.status} />
                          </td>

                          <td className="whitespace-nowrap px-5 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <RowActions
                                item={item}
                                onDuplicate={handleDuplicate}
                                onDelete={setDeletingEvent}
                                onTrack={setTrackingEvent}
                                originState={originState}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------ delete modal */}
      <Modal
        open={Boolean(deletingEvent)}
        onClose={() => !deletingLoading && setDeletingEvent(null)}
        eyebrow="Confirm"
        title="Delete Event"
        subtitle={
          deletingEvent?.isDraft
            ? "Draft event deletion"
            : panel.approval ? "Submitted event deletion" : "Recorded event deletion"
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeletingEvent(null)}
              disabled={deletingLoading}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deletingLoading}
              className="btn btn-danger btn-sm"
            >
              {deletingLoading && <span className="spin h-3.5 w-3.5" />}
              {deletingLoading ? "Deleting…" : "Delete Event"}
            </button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span
            className="icon-tile icon-tile-track"
            style={{ "--track": trackOf("rejected") }}
          >
            <IconAlertTriangle />
          </span>
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              {deletingEvent?.event_name || deletingEvent?.eventName || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              Venue: {deletingEvent?.location || "Not set"} · Date:{" "}
              {deletingEvent?.event_date || deletingEvent?.eventDate || "Not set"}
            </p>
          </div>
        </div>

        <p className="prose-muted mt-4 text-sm">
          Are you sure you want to delete this event? This will permanently remove it
          from your records.
        </p>
      </Modal>

      {/* ------------------------------------------------------- track modal */}
      <Modal
        open={panel.approval && Boolean(trackingEvent)}
        onClose={() => setTrackingEvent(null)}
        wide
        eyebrow="Status Tracking"
        title={trackingEvent?.event_name || trackingEvent?.eventName || "Untitled Event"}
        subtitle={`Date: ${trackingEvent?.event_date || trackingEvent?.eventDate || "Not set"} · Location: ${trackingEvent?.location || "Not set"}`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setTrackingEvent(null)}
              className="btn btn-ghost btn-sm mr-auto"
            >
              Close
            </button>

            {isRefusedStatus(trackingEvent?.status) && (
              <Link
                to={`${panel.base}/create-event?editEventId=${trackingEvent.id}`}
                state={originState}
                className="btn btn-danger btn-sm"
              >
                <IconEdit />
                Edit &amp; Resubmit
              </Link>
            )}

            {trackingEvent && !trackingEvent.isDraft && (
              <Link to={`${panel.base}/events/${trackingEvent.id}`} className="btn btn-brand btn-sm">
                View Full Details
                <IconArrowRight />
              </Link>
            )}
          </>
        }
      >
        {isRefusedStatus(trackingEvent?.status) && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl border p-3.5"
            style={{
              "--track": trackOf(trackingEvent.status),
              borderColor: "color-mix(in srgb, var(--track) 30%, transparent)",
              background: "color-mix(in srgb, var(--track) 9%, transparent)",
            }}
          >
            <IconAlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: trackOf(trackingEvent.status) }}
            />
            <div>
              <p className="text-xs font-semibold text-ink">
                {trackingEvent.status === "revoked" ? "Revocation reason" : "Rejection reason"}
              </p>
              <p className="prose-muted mt-0.5 text-xs">
                {getRefusalReason(trackingEvent) || "No explicit reason provided."}
              </p>
            </div>
          </div>
        )}

        <Lifecycle status={trackingEvent?.status || "pending"} />
      </Modal>
    </TeacherShell>
  );
}

const NotSet = () => <span className="italic text-muted/70">Not set</span>;

/**
 * The five things a teacher can do to a row. Shared by the phone card list and
 * the desktop table so the two can never offer different actions.
 */
function RowActions({ item, onDuplicate, onDelete, onTrack, originState }) {
  const panel = usePanel();
  const [reporting, setReporting] = useState(false);
  // Editable until the Dean approves it; mirrors TEACHER_EDITABLE_STATUSES in
  // backend/app/models/documents.py (the server enforces it).
  const canEdit = item.isDraft || canTeacherEditEvent(item);
  const canDelete = item.isDraft || canTeacherEditEvent(item);

  const viewTo = item.isDraft
    ? `${panel.base}/create-event?draftId=${item.id}`
    : `${panel.base}/events/${item.id}`;

  const editTo = item.isDraft
    ? `${panel.base}/create-event?draftId=${item.id}`
    : `${panel.base}/create-event?editEventId=${item.id}`;

  return (
    <>
      <Link
        to={viewTo}
        state={originState}
        title={item.isDraft ? "View & edit draft" : "View event details"}
        aria-label={item.isDraft ? "View and edit draft" : "View event details"}
        className="icon-btn icon-btn-sm"
      >
        <IconEye />
      </Link>

      {canEdit ? (
        <Link
          to={editTo}
          state={originState}
          title="Edit event"
          aria-label="Edit event"
          className="icon-btn icon-btn-sm hover:border-emberink/50 hover:text-emberink"
        >
          <IconEdit />
        </Link>
      ) : (
        <span
          title="Editing is not permitted in this approval status"
          className="icon-btn icon-btn-sm cursor-not-allowed opacity-40"
          aria-hidden="true"
        >
          <IconEdit />
        </span>
      )}

      <button
        type="button"
        onClick={() => onDuplicate(item)}
        title="Duplicate as new draft"
        aria-label="Duplicate as new draft"
        className="icon-btn icon-btn-sm hover:border-ember/60 hover:text-emberink"
      >
        <IconCopy />
      </button>

      {canDelete ? (
        <button
          type="button"
          onClick={() => onDelete(item)}
          title="Delete event"
          aria-label="Delete event"
          className="icon-btn icon-btn-sm hover:border-err/50 hover:text-err"
        >
          <IconTrash />
        </button>
      ) : (
        <span
          title="Approved events cannot be deleted"
          className="icon-btn icon-btn-sm cursor-not-allowed opacity-40"
          aria-hidden="true"
        >
          <IconTrash />
        </span>
      )}

      {panel.approval ? (
        <button
          type="button"
          onClick={() => onTrack(item)}
          title="Track approval status"
          aria-label="Track approval status"
          className="icon-btn icon-btn-sm hover:border-accent/60 hover:text-accent"
        >
          <IconActivity />
        </button>
      ) : (
        !item.isDraft && item.status === "recorded" && (
          <button
            type="button"
            onClick={async () => {
              setReporting(true);
              try {
                await downloadEventReport(item.id, item.event_name);
              } catch (err) {
                alert(err?.message || "Could not generate the report.");
              } finally {
                setReporting(false);
              }
            }}
            disabled={reporting}
            title="Download report"
            aria-label="Download report"
            className="icon-btn icon-btn-sm hover:border-accent/60 hover:text-accent"
          >
            {reporting ? <span className="spin h-3.5 w-3.5" /> : <IconDownload />}
          </button>
        )
      )}
    </>
  );
}

export default TeacherDashboard;
