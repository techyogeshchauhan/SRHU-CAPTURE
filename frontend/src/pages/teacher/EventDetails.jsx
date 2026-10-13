import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiJson } from "../../services/api";
import { useOriginState } from "../../hooks/useOriginState";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { canTeacherEditEvent, getRefusalReason } from "../../utils/constants";
import { formatDateRange, formatTime12h } from "../../utils/dates";
import { readEventFields } from "../../utils/eventFields";
import { buildTimeline } from "../../utils/eventHistory";
import {
  duplicateEventAsDraft,
} from "../../utils/draftStorage";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import ReportPhotoPicker from "../../components/teacher/ReportPhotoPicker";
import { downloadEventReport, reportNotice } from "../../services/eventManager";
import PageHero from "../../components/teacher/PageHero";
import Modal from "../../components/teacher/Modal";
import ReportCustomizationModal from "../../components/common/ReportCustomizationModal";
import Lifecycle from "../../components/teacher/Lifecycle";
import ProgressTimeline from "../../components/teacher/ProgressTimeline";
import EventMediaSections from "../../components/common/EventMediaSections";
import useMediaRefresh from "../../components/common/useMediaRefresh";
import StatusChip from "../../components/teacher/StatusChip";
import { isApprovedStatus, isRefusedStatus, trackOf } from "../../components/teacher/status";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowLeft,
  IconBuilding,
  IconCheckCircle,
  IconCalendar,
  IconClock,
  IconCopy,
  IconDownload,
  IconEdit,
  IconMapPin,
  IconPhone,
  IconRefresh,
  IconTag,
  IconTrash,
  IconUser,
  IconUsers,
  RidgeDivider,
} from "../../components/teacher/icons";

function formatTimestamp(isoStr) {
  if (!isoStr) return "N/A";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}

function formatFileSize(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getFileExt(fileName) {
  const parts = (fileName || "").split(".");
  return parts.length > 1 ? parts.pop().toUpperCase() : "DOC";
}

function EventDetails() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const panel = usePanel();
  const [reporting, setReporting] = useState(false);
  // Report problems are shown in place; `error` is the page's load failure.
  const [reportError, setReportError] = useState("");
  const [showReportModal, setShowReportModal] = useState(false);

  const [event, setEvent] = useState(null);
  const [media, setMedia] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState("");

  // Deletion modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingLoading, setDeletingLoading] = useState(false);

  const fetchEventDetails = async () => {
    try {
      setLoading(true);
      setError("");

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

      // Event, media and supporting documents in one API call
      const { event: eventData, media: mediaData, documents: docData } =
        await apiJson(`${panel.api}/events/${eventId}`);

      setEvent(eventData);
      setMedia(mediaData || []);
      setDocuments(docData || []);
    } catch (err) {
      console.error("Event details error:", err);
      setError(err.message || "Unable to load event details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEventDetails();
  }, [eventId]);

  // Media and document links are signed and expire; when one fails to load,
  // fetch fresh ones (quietly, without the full-page loading state).
  const refreshMediaLinks = useMediaRefresh(async () => {
    const { media: mediaData, documents: docData } = await apiJson(`${panel.api}/events/${eventId}`);
    setMedia(mediaData || []);
    setDocuments(docData || []);
  });

  const originState = useOriginState();

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const handleDuplicate = () => {
    if (!event || !profile) return;
    try {
      const newDraft = duplicateEventAsDraft(profile.id, event);
      setActionNotice("Event duplicated as new draft.");
      setTimeout(() => {
        navigate(`${panel.base}/create-event?draftId=${newDraft.id}`, { state: originState });
      }, 700);
    } catch (err) {
      console.error("Duplicate error:", err);
      alert("Failed to duplicate event.");
    }
  };

  const handleDeleteConfirm = async () => {
    if (!event || !profile) return;
    try {
      setDeletingLoading(true);
      await apiJson(`${panel.api}/events/${event.id}`, { method: "DELETE" });

      navigate(`${panel.base}/my-events`, { replace: true });
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete event: " + (err.message || "Unknown error"));
    } finally {
      setDeletingLoading(false);
      setShowDeleteModal(false);
    }
  };

  const handleDownloadReport = () => {
    setShowReportModal(true);
  };

  const handleExecuteReport = async (customization) => {
    try {
      setReporting(true);
      setReportError("");
      const notice = reportNotice(await downloadEventReport(event.id, event.event_name, customization));
      if (notice) setActionNotice(notice);
      setShowReportModal(false);
    } catch (err) {
      setReportError(err?.message || "Could not generate the report.");
    } finally {
      setReporting(false);
    }
  };

  const scrollToLifecycle = () => {
    const el = document.getElementById("approval-lifecycle-section");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  if (loading) {
    return (
      <div className="hv-root flex min-h-screen items-center justify-center">
        <div className="text-center">
          <span className="spin mx-auto mb-4 block h-10 w-10 text-accent" />
          <p className="prose-muted text-sm">Loading event details…</p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="hv-root flex min-h-screen items-center justify-center px-4">
        <div className="glass w-full max-w-md p-9 text-center">
          <span
            className="icon-tile icon-tile-track mx-auto mb-4 h-14 w-14 rounded-2xl"
            style={{ "--track": trackOf("rejected") }}
          >
            <IconAlertTriangle className="h-6 w-6" />
          </span>
          <h1 className="h3 text-ink">Event Not Found</h1>
          <p className="prose-muted mt-2 text-sm">
            {error || "This event could not be found."}
          </p>
          <Link to={`${panel.base}/my-events`} className="btn btn-brand mt-6">
            <IconArrowLeft />
            Back to My Events
          </Link>
        </div>
      </div>
    );
  }

  // See the note in the Dean's copy: real columns first, blob as a fallback.
  const meta = readEventFields(event);
  const cleanDescription = meta.description;
  // The approval banner reads from the recorded trail, so it can name the
  // Dean who approved and say whether a rejection came first.
  const timeline = buildTimeline(event);
  const isApprovedNow = isApprovedStatus(String(event.status || "").toLowerCase());
  const approval = isApprovedNow
    ? [...timeline].reverse().find((entry) => entry.action === "approved") || null
    : null;
  const hadRejection = timeline.some(
    (entry) =>
      entry.action === "rejected" ||
      entry.action === "revoked" ||
      entry.action === "changes_requested"
  );

  // The same window the API enforces (TEACHER_EDITABLE_STATUSES) and My Events
  // already used. The hand-written list this replaces left out under_review
  // and revoked, hiding Delete on events the server would have deleted.
  const canDelete = canTeacherEditEvent(event);
  const refusalReason = getRefusalReason(event);

  const facts = [
    {
      Icon: IconCalendar,
      label: event.end_date ? "Dates" : "Date",
      value: formatDateRange(event.event_date, event.end_date) || "Not set",
    },
    {
      Icon: IconClock,
      label: "Timings",
      value:
        meta.startTime && meta.endTime
          ? `${formatTime12h(meta.startTime)} – ${formatTime12h(meta.endTime)}`
          : "All day",
    },
    { Icon: IconMapPin, label: "Venue", value: event.location || "Not set" },
  ];

  const details = [
    { Icon: IconBuilding, label: "Department / School", value: meta.department || "University-wide" },
    {
      Icon: IconUser,
      label: "Organizer / Coordinator",
      value: meta.organizer || profile?.name || "Not specified",
    },
    {
      Icon: IconPhone,
      label: "Contact Information",
      value: meta.contactInfo || profile?.email || "Not specified",
    },
    ...(meta.expectedParticipants
      ? [{ Icon: IconUsers, label: "Expected Participants", value: meta.expectedParticipants }]
      : []),
  ];

  return (
    <TeacherShell
      active="events"
      profile={profile}
      onLogout={handleLogout}
      railNote={
        panel.approval
          ? "Complete review records, history, and uploaded assets for this event."
          : "Event details, uploaded files, and the photos that go into its report."
      }
    >
      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">

        {actionNotice && (
          <div className="toast toast-ok mb-5" role="status">
            <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
            <p className="text-sm font-medium text-ink">{actionNotice}</p>
          </div>
        )}

        {reportError && (
          <div className="toast toast-err mb-5" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm font-medium text-ink">{reportError}</p>
          </div>
        )}

        {/* ------------------------------------------------- back + actions */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to={`${panel.base}/my-events`} className="btn btn-ghost btn-sm">
            <IconArrowLeft />
            Back to My Events
          </Link>

          <div className="flex flex-wrap items-center gap-2">
            {panel.approval ? (
              <button type="button" onClick={scrollToLifecycle} className="btn btn-ghost btn-xs">
                <IconActivity />
                Track Status
              </button>
            ) : (
              panel.reports && event.status === "recorded" && (
                <button
                  type="button"
                  onClick={handleDownloadReport}
                  disabled={reporting}
                  className="btn btn-primary btn-xs"
                >
                  {reporting ? <span className="spin h-3 w-3" /> : <IconDownload />}
                  Download Report
                </button>
              )
            )}

            <button
              type="button"
              onClick={handleDuplicate}
              className="btn btn-ghost btn-xs hover:border-ember/60"
            >
              <IconCopy />
              Duplicate
            </button>

            {canDelete && (
              <button
                type="button"
                onClick={() => setShowDeleteModal(true)}
                className="btn btn-ghost btn-xs text-err hover:border-err/50"
              >
                <IconTrash />
                Delete
              </button>
            )}

            {isRefusedStatus(event.status) && (
              <Link
                to={`${panel.base}/create-event?editEventId=${event.id}`}
                state={originState}
                className="btn btn-danger btn-xs"
              >
                <IconRefresh />
                Edit &amp; Resubmit
              </Link>
            )}

            {/* Editable until the Dean approves it. A refused event has its
                own Edit & Resubmit above. */}
            {!isRefusedStatus(event.status) && canTeacherEditEvent(event) && (
              <Link
                to={`${panel.base}/create-event?editEventId=${event.id}`}
                state={originState}
                className="btn btn-ghost btn-xs"
              >
                <IconEdit />
                Edit
              </Link>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------- the hero */}
        <PageHero
          eyebrow={event.event_type}
          title={event.event_name}
          subtitle={`Organized by ${meta.organizer || profile?.name || panel.roleLabel}`}
          actions={<StatusChip status={event.status} size="md" />}
        >
          <dl className="grid gap-4 border-t hairline pt-5 sm:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="flex items-center gap-3">
                <span className="icon-tile h-9 w-9 rounded-xl">
                  <fact.Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">
                    {fact.label}
                  </dt>
                  <dd className="truncate text-sm font-medium text-ink">{fact.value}</dd>
                </div>
              </div>
            ))}
          </dl>
        </PageHero>

        {/* ---------------------------------------------- approved, plainly */}
        {approval && (
          <section
            style={{ "--track": trackOf("approved") }}
            data-tint="approved"
            className="reveal mt-6 flex items-start gap-3 rounded-2xl border px-6 py-4"
            role="status"
          >
            <IconCheckCircle
              className="mt-0.5 h-5 w-5 shrink-0"
              style={{ color: trackOf("approved") }}
            />
            <div className="min-w-0">
              <h2 className="h3 text-base text-ink">Approved by the Dean</h2>
              <p className="prose-muted mt-0.5 text-sm">
                {approval.actor_name ? `${approval.actor_name} approved` : "Approved"} this
                event on {formatTimestamp(approval.created_at)}.
                {hadRejection && " It had been sent back earlier — the full exchange is below."}
              </p>
            </div>
          </section>
        )}

        {/* ------------------------------------------- progress and updates
            The approval tracker: only where the Dean reviews events. */}
        {panel.approval && (
        <section id="approval-lifecycle-section" className="glass reveal mt-6 p-6">
          <p className="eyebrow">Tracking</p>
          <h2 className="h3 mt-1 text-ink">Event progress &amp; updates</h2>
          <p className="prose-muted mt-0.5 text-xs">
            Where this event stands, every step it has been through, and everything
            the Dean has said about it.
          </p>

          <div className="mt-7">
            <Lifecycle status={event.status || "pending"} />
          </div>

          <div className="mt-8 border-t hairline pt-6">
            <h3 className="mb-4 font-display text-sm font-semibold text-ink">
              History
            </h3>
            <ProgressTimeline event={event} viewerId={profile?.id} perspective="teacher" />
          </div>
        </section>
        )}

        {/* --------------------------------------------------- Dean remarks */}
        {/* The Dean must give a reason for either kind of refusal, and the
            teacher has to be able to read it -- a revocation reason used to be
            written, stored, and then shown nowhere at all. */}
        {panel.approval && refusalReason && (
          <section
            style={{ "--track": trackOf(event.status) }}
            data-tint="rejected"
            className="reveal mt-6 overflow-hidden rounded-2xl border"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4"
                 style={{ borderColor: "color-mix(in srgb, var(--track) 22%, transparent)" }}>
              <div className="flex items-center gap-2.5">
                <IconAlertTriangle className="h-5 w-5" style={{ color: trackOf(event.status) }} />
                <h2 className="h3 text-base text-ink">
                  {event.status === "revoked"
                    ? "Why the approval was withdrawn"
                    : "Reviewer / Dean Remarks"}
                </h2>
              </div>

              {canTeacherEditEvent(event) && (
                <Link
                  to={`${panel.base}/create-event?editEventId=${event.id}`}
                  state={originState}
                  className="btn btn-danger btn-xs"
                >
                  <IconRefresh />
                  Edit &amp; Resubmit
                </Link>
              )}
            </div>

            <p className="whitespace-pre-line px-6 py-5 text-sm leading-6 text-ink">
              {refusalReason}
            </p>
          </section>
        )}

        <RidgeDivider className="divider mt-6" />

        {/* ---------------------------------------------- coordination info */}
        <section className="glass p-6">
          <p className="eyebrow">Coordination</p>
          <h2 className="h3 mt-1 border-b hairline pb-4 text-ink">Event Information</h2>

          <dl className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {details.map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <span className="icon-tile h-9 w-9 rounded-xl">
                  <item.Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted">{item.label}</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-ink">{item.value}</dd>
                </div>
              </div>
            ))}

            {event.social_network_url && (
              <div className="flex items-start gap-3 sm:col-span-2">
                <span className="icon-tile h-9 w-9 rounded-xl">
                  <IconTag className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted">Social Network Link</dt>
                  <dd className="mt-0.5">
                    <a
                      href={event.social_network_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link text-sm font-semibold"
                    >
                      {event.social_network_url}
                    </a>
                  </dd>
                </div>
              </div>
            )}
          </dl>
        </section>

        {/* ------------------------------------------------------ description */}
        <section className="glass mt-6 overflow-hidden">
          <div className="border-b hairline px-6 py-5">
            <p className="eyebrow">Proposal</p>
            <h2 className="h3 mt-1 text-ink">Event Description</h2>
          </div>
          <p className="prose-muted whitespace-pre-line px-6 py-5 text-sm">
            {cleanDescription || "No description provided."}
          </p>
        </section>

        {/* ------------------------------------------------------- the files */}
        <div className="mt-6 grid gap-6 md:grid-cols-2">

          <section className="glass overflow-hidden">
            <div className="flex items-center justify-between border-b hairline px-6 py-4">
              <h2 className="h3 text-base text-ink">Supporting Documents</h2>
              <span className="chip chip-sm chip-solid num">{documents.length}</span>
            </div>

            <div className="p-5">
              {documents.length === 0 ? (
                <p className="prose-muted py-6 text-center text-xs">
                  No supporting documents uploaded.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {documents.map((doc) => (
                    <li
                      key={doc.id}
                      className="flex items-center justify-between gap-3 rounded-xl border hairline bg-raised/40 p-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="icon-tile h-9 w-9 rounded-lg font-display text-[10px] font-bold">
                          {getFileExt(doc.file_name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-ink">
                            {doc.file_name}
                          </p>
                          <p className="text-[10px] text-muted">{formatFileSize(doc.file_size)}</p>
                        </div>
                      </div>

                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                        className="btn btn-ghost btn-xs shrink-0"
                      >
                        <IconDownload />
                        View
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Photos and videos in their own cards, every item shown; each
              opens the viewer, where images show full size and videos play. */}
          <EventMediaSections
            items={media}
            eventName={event.event_name || "Event"}
            columns="grid-cols-2"
            onLoadError={refreshMediaLinks}
          />
        </div>

        {/* A teacher can change the Dean report's photos while the event is
            still editable; the Event Manager's events always are. */}
        {(panel.reports || canTeacherEditEvent(event)) && (
          <ReportPhotoPicker
            key={(event.report_photo_ids || []).join(",")}
            eventId={event.id}
            api={panel.api}
            photos={media.filter((item) => item.media_type === "image")}
            initial={event.report_photo_ids || []}
            onSaved={(ids) => {
              setEvent((current) => ({ ...current, report_photo_ids: ids }));
              setActionNotice("Report photos saved.");
            }}
            onError={setReportError}
          />
        )}
      </div>

      {/* ----------------------------------------------------- delete modal */}
      <Modal
        open={showDeleteModal}
        onClose={() => !deletingLoading && setShowDeleteModal(false)}
        eyebrow="Confirm"
        title="Delete Event"
        subtitle="Permanent action"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowDeleteModal(false)}
              disabled={deletingLoading}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeleteConfirm}
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
          <span className="icon-tile icon-tile-track" style={{ "--track": trackOf("rejected") }}>
            <IconAlertTriangle />
          </span>
          <p className="prose-muted text-sm">
            Are you sure you want to delete{" "}
            <strong>&ldquo;{event.event_name}&rdquo;</strong>? This removes all event records,
            uploads, and history.
          </p>
        </div>
      </Modal>

      <ReportCustomizationModal
        open={showReportModal}
        onClose={() => setShowReportModal(false)}
        onGenerate={handleExecuteReport}
        generating={reporting}
        eventName={event?.event_name}
        photoCount={media?.filter((m) => m.media_type === "image").length}
        documentCount={documents?.length}
        noticeCount={documents?.filter((d) => d.category !== "report").length}
        attachmentCount={(documents?.filter((d) => d.category === "report").length || 0) + (media?.length || 0)}
      />
    </TeacherShell>
  );
}

export default EventDetails;
