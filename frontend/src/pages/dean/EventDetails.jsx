import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { apiFetch, apiJson, errorFromResponse } from "../../services/api";
import { fileNameFromResponse, reportFileName } from "../../utils/fileNames";
import useMediaRefresh from "../../components/common/useMediaRefresh";
import ReportCustomizationModal from "../../components/common/ReportCustomizationModal";
import { submitterOf } from "../../components/common/submitter";
import DeanShell from "../../components/dean/DeanShell";
import Modal from "../../components/teacher/Modal";
import PageHero from "../../components/teacher/PageHero";
import ProgressTimeline from "../../components/teacher/ProgressTimeline";
import EventMediaSections from "../../components/common/EventMediaSections";
import StatusChip from "../../components/teacher/StatusChip";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconBuilding,
  IconCalendar,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconFileText,
  IconMapPin,
  IconPhone,
  IconRefresh,
  IconShield,
  IconTag,
  IconTrash,
  IconUser,
  IconUsers,
  IconX,
  RidgeDivider,
} from "../../components/teacher/icons";
import {
  canApprove,
  canReject,
  canRevoke,
  canRequestChanges,
  getApproveLabel,
  getNextStage,
  getPreviousStage,
  getRefusalReason,
  getStatusBucket,
  isRefused,
} from "../../utils/constants";
import { formatDateRange, formatTime12h } from "../../utils/dates";
import { readEventFields } from "../../utils/eventFields";

function EventDetails() {
  const { eventId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [event, setEvent] = useState(null);
  const [media, setMedia] = useState([]);
  const [documents, setDocuments] = useState([]);

  // Signed-in Dean, used for the shell's account blocks.
  const [deanProfile, setDeanProfile] = useState(null);

  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [reportLoading, setReportLoading] = useState(false);
  const [reportGenerated, setReportGenerated] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [showReportModal, setShowReportModal] = useState(false);

  const [socialNetworkUrl, setSocialNetworkUrl] = useState("");
  const [savingSocialLink, setSavingSocialLink] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Advancing through the post-approval delivery stages.
  const [stageSaving, setStageSaving] = useState(false);

  // The decision being confirmed: "approve" | "reject". A themed dialog rather
  // than window.confirm / window.prompt, matching the All Events screen.
  const [decisionKind, setDecisionKind] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  // Deleting the event permanently
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // ============================================================
  // ERRORS
  // A 401 means the session is gone: apiJson has already cleared it, and the
  // login page is where the Dean can recover. Anything else is shown.
  // ============================================================

  const handleApiError = (err, fallback, context) => {
    console.error(`${context}:`, err);
    if (err?.status === 401) {
      navigate("/login", { replace: true });
      return true;
    }
    setError(err?.message || fallback);
    return false;
  };

  // ============================================================
  // LOAD MEDIA / DOCUMENTS / REPORT STATUS
  // ============================================================

  // Media links are signed and time-limited, so this also serves as the
  // refresh when a thumbnail or player reports a load error.
  const loadMedia = async (id) => {
    try {
      const data = await apiJson(`/dean/events/${id}/media`);
      setMedia(data?.media || []);
    } catch (err) {
      console.error("Load media error:", err);
      setMedia([]);
    }
  };

  const loadDocuments = async (id) => {
    try {
      const data = await apiJson(`/dean/events/${id}/documents`);
      setDocuments(data?.documents || []);
    } catch (err) {
      console.error("Load documents error:", err);
      setDocuments([]);
    }
  };

  const loadReportStatus = async (id) => {
    try {
      const data = await apiJson(`/dean/events/${id}/report-status`);

      setReportGenerated(Boolean(data?.report_generated));
      setGeneratedAt(data?.generated_at || null);

      if (data?.social_network_url) {
        setSocialNetworkUrl(data.social_network_url);
      }
    } catch (err) {
      console.error("Load report status error:", err);
    }
  };

  const refreshMediaLinks = useMediaRefresh(() =>
    Promise.all([loadMedia(eventId), loadDocuments(eventId)])
  );

  // ============================================================
  // LOAD EVENT
  // ============================================================

  const loadEvent = async () => {
    try {
      setLoading(true);
      setError("");

      // One event, not the whole list; the files and report state are
      // independent of each other, so fetch them side by side.
      const [data] = await Promise.all([
        apiJson(`/dean/events/${eventId}`),
        loadMedia(eventId),
        loadDocuments(eventId),
      ]);

      const foundEvent = data?.event;

      if (!foundEvent) {
        throw new Error("Event not found");
      }

      setEvent(foundEvent);
      setSocialNetworkUrl(foundEvent.social_network_url || "");

      await loadReportStatus(eventId);
    } catch (err) {
      handleApiError(err, "Failed to load event details", "Load event error");
    } finally {
      setLoading(false);
    }
  };

  // ============================================================
  // INITIAL LOAD
  // ============================================================

  useEffect(() => {
    loadEvent();
  }, [eventId]);

  useEffect(() => {
    let mounted = true;

    fetchCurrentUser()
      .then((data) => {
        // Non-blocking: the shell falls back to a neutral initial.
        if (mounted && data) setDeanProfile(data);
      })
      .catch((err) => console.error("Load dean profile error:", err));

    return () => {
      mounted = false;
    };
  }, []);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  // ============================================================
  // OPEN / CLOSE A DECISION
  // ============================================================

  // Moving an event backwards is the one stage change that takes something
  // away from the teacher, so unlike advancing it asks for confirmation.
  const [stageBack, setStageBack] = useState(null);

  const handleRestore = async () => {
    if (!event) return;
    try {
      setProcessing(true);
      setError("");
      const data = await apiJson(`/dean/events/${event.id}/restore`, {
        method: "PATCH",
      });
      setEvent(data.event);
      setSuccess(data.message || "Event restored.");
    } catch (err) {
      handleApiError(err, "Failed to restore event", "Restore event error");
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteEvent = async () => {
    if (!event) return;
    try {
      setDeleting(true);
      setError("");
      setSuccess("");
      await apiJson(`/dean/events/${event.id}`, { method: "DELETE" });
      setDeleteConfirmOpen(false);
      navigate(archived ? "/dean/archive" : "/dean/events", {
        replace: true,
        state: { success: "Event deleted permanently." },
      });
    } catch (err) {
      handleApiError(err, "Failed to delete event", "Delete event error");
    } finally {
      setDeleting(false);
    }
  };

  const openDecision = (kind) => {
    setDecisionKind(kind);
    setRejectReason("");
    setReasonError("");
  };

  /**
   * "Open event and approve" on the All Events dialog lands here with
   * ?action=approve (PRD 16), so the Dean sees the full proposal and the
   * confirmation together rather than approving from a table row.
   *
   * The parameter is cleared with replace, or a refresh would reopen a dialog
   * the Dean had already dismissed.
   */
  useEffect(() => {
    if (!event || searchParams.get("action") !== "approve") return;

    if (canApprove(event)) setDecisionKind("approve");
    setSearchParams({}, { replace: true });
  }, [event, searchParams, setSearchParams]);

  const closeDecision = () => {
    if (processing) return; // never abandon a request mid-flight
    setDecisionKind(null);
    setRejectReason("");
    setReasonError("");
  };

  // ============================================================
  // APPROVE EVENT
  // ============================================================

  const confirmApprove = async () => {
    if (!event) return;

    try {
      setProcessing(true);
      setError("");
      setSuccess("");

      const data = await apiJson(`/dean/events/${event.id}/approve`, { method: "PATCH" });

      setEvent(data.event);

      setSuccess(data.message || "Event approved successfully.");
      setDecisionKind(null);

      // Refresh report status after approval
      await loadReportStatus(event.id);
    } catch (err) {
      // A 409 (the event moved on meanwhile) carries a readable detail.
      handleApiError(err, "Failed to approve event", "Approve event error");
      setDecisionKind(null);
    } finally {
      setProcessing(false);
    }
  };

  // ============================================================
  // REJECT EVENT
  // ============================================================

  const confirmReject = async () => {
    if (!event) return;

    const reason = rejectReason.trim();

    if (!reason) {
      setReasonError("A reason is required — the teacher sees it verbatim.");
      return;
    }

    if (decisionKind === "changes") {
      await confirmRequestChanges(reason);
      return;
    }

    try {
      setProcessing(true);
      setError("");
      setSuccess("");
      setReasonError("");

      // In the body, not the query string: long reasons would hit URL
      // limits and end up in access logs.
      const data = await apiJson(
        `/dean/events/${event.id}/${isRevoking ? "revoke" : "reject"}`,
        {
          method: "PATCH",
          body: isRevoking
            ? { revocation_reason: reason }
            : { rejection_reason: reason },
        },
      );

      setEvent(data.event);

      setSuccess(
        data.message ||
          (isRevoking ? "Event approval revoked." : "Event rejected successfully."),
      );
      setDecisionKind(null);

      // Mirrors confirmApprove: keep report state in sync when the decision
      // is revised without a page reload. report-status has no status gate.
      await loadReportStatus(event.id);
    } catch (err) {
      handleApiError(err, "Failed to reject event", "Reject event error");
      setDecisionKind(null);
    } finally {
      setProcessing(false);
    }
  };

  // ============================================================
  // REQUEST CHANGES
  // The backend sends the event back to the teacher (status "rejected", logged
  // as "changes_requested" in the history) so they can edit and resubmit.
  // ============================================================

  const confirmRequestChanges = async (remarks) => {
    try {
      setProcessing(true);
      setError("");
      setSuccess("");
      setReasonError("");

      const data = await apiJson(`/dean/events/${event.id}/request-changes`, {
        method: "PATCH",
        body: { remarks },
      });

      setEvent(data.event);

      setSuccess("Changes requested. The teacher has been notified.");
      setDecisionKind(null);
    } catch (err) {
      handleApiError(err, "Failed to request changes", "Request changes error");
      setDecisionKind(null);
    } finally {
      setProcessing(false);
    }
  };

  // ============================================================
  // CHANGE STAGE
  // ============================================================

  const handleChangeStage = async (stageKey) => {
    if (!event) return;

    try {
      setStageSaving(true);
      setError("");
      setSuccess("");

      const data = await apiJson(
        `/dean/events/${event.id}/stage?stage=${encodeURIComponent(stageKey)}`,
        { method: "PATCH" }
      );

      setEvent(data.event);

      setSuccess(data.message || "Event stage updated successfully.");
    } catch (err) {
      handleApiError(err, "Failed to update the event stage", "Change stage error");
    } finally {
      setStageSaving(false);
    }
  };

  // ============================================================
  // SAVE SOCIAL NETWORK LINK
  // ============================================================

  const handleSaveSocialLink = async () => {
    if (!event) return;

    try {
      setSavingSocialLink(true);
      setError("");
      setSuccess("");

      const data = await apiJson(`/dean/events/${event.id}/social-link`, {
        method: "PATCH",
        body: { social_network_url: socialNetworkUrl.trim() },
      });

      setSocialNetworkUrl(data.social_network_url);

      setEvent((previous) => ({
        ...previous,
        social_network_url: data.social_network_url,
      }));

      // Existing report becomes invalid
      // because social link changed.
      setReportGenerated(false);
      setGeneratedAt(null);

      setSuccess("Social Network Link saved successfully.");
    } catch (err) {
      handleApiError(err, "Failed to save Social Network Link", "Save social link error");
    } finally {
      setSavingSocialLink(false);
    }
  };

  // ============================================================
  // GENERATE REPORT
  // ============================================================

  const handleOpenReportModal = () => {
    if (!event) return;
    if (getStatusBucket(event.status) !== "approved") {
      setError("Report can only be generated for an approved event.");
      return;
    }
    setShowReportModal(true);
  };

  // The PDF for the chosen sections; with none given, the server uses the
  // sections the report was last generated with.
  const savePdf = async (customization = null) => {
    const response = await apiFetch(`/dean/events/${event.id}/report/download`, {
      method: customization ? "POST" : "GET",
      body: customization || undefined,
    });

    if (!response.ok) {
      throw await errorFromResponse(response, "Failed to download report");
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    // Named after the event ("IEEE Conference.pdf"): the server's name,
    // or the same rule applied here if the header cannot be read.
    link.download = fileNameFromResponse(response) || reportFileName(event.event_name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(downloadUrl);
  };

  // Download: the report as last generated, without asking again.
  const handleDownloadReport = async () => {
    if (!event) return;
    try {
      setReportLoading(true);
      setError("");
      setSuccess("");
      await savePdf();
      setSuccess("Report downloaded successfully.");
    } catch (err) {
      handleApiError(err, "Failed to download report", "Download report error");
    } finally {
      setReportLoading(false);
    }
  };

  const handleGenerateReport = async (customization = null) => {
    if (!event) return;

    // The whole approved group -- approved, in progress, completed -- matches
    // the backend's is_approved() and the report panel's own visibility.
    if (getStatusBucket(event.status) !== "approved") {
      setError("Report can only be generated for an approved event.");
      return;
    }

    try {
      setReportLoading(true);
      setError("");
      setSuccess("");

      const data = await apiJson(`/dean/events/${event.id}/generate-report`, {
        method: "POST",
        body: customization || undefined,
      });

      setReportGenerated(true);
      setGeneratedAt(data?.generated_at || null);

      await savePdf(customization);

      setShowReportModal(false);
      setSuccess("Report generated and downloaded successfully.");
    } catch (err) {
      handleApiError(err, "Failed to generate report", "Generate report error");
    } finally {
      setReportLoading(false);
    }
  };

  // ============================================================
  // LOADING
  // ============================================================

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

  // ============================================================
  // ERROR / NOT FOUND
  // ============================================================

  if (error && !event) {
    return (
      <DeanShell active="events" profile={deanProfile} onLogout={handleLogout}>
        <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">
          <div
            className="flex flex-col items-center rounded-2xl border px-6 py-14 text-center"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <span
              className="icon-tile icon-tile-track mb-4 h-14 w-14 rounded-2xl"
              style={{ "--track": trackOf("rejected") }}
            >
              <IconAlertTriangle className="h-6 w-6" />
            </span>

            <h1 className="h3 text-ink">Unable to load this event</h1>
            <p className="prose-muted mt-1.5 max-w-md text-sm">{error}</p>

            <div className="mt-6 flex flex-wrap justify-center gap-2.5">
              <button type="button" onClick={loadEvent} className="btn btn-ghost btn-sm">
                <IconRefresh />
                Try again
              </button>
              <Link to="/dean/events" className="btn btn-brand btn-sm">
                <IconArrowLeft />
                Back to all events
              </Link>
            </div>
          </div>
        </div>
      </DeanShell>
    );
  }

  // ============================================================
  // MAIN UI
  // ============================================================

  // ----------------------------------------------------------
  // Derived view data
  // ----------------------------------------------------------

  // Times, organiser and contact are real fields now; department and
  // expected participants are still carried in the description blob.
  // readEventFields prefers the columns and falls back to the blob, so an
  // event created before the promotion still renders in full.
  const meta = readEventFields(event);
  const cleanDescription = meta.description;

  // Bucket-wide, like getApproveLabel: a revoked event is a refused event,
  // and keying this off `=== "rejected"` is why its reason panel never
  // rendered and its confirmation dialog said "approve" under a button
  // labelled "Re-approve".
  const rejected = isRefused(event.status);
  const refusalReason = getRefusalReason(event);
  // An archived event stays readable so it can be reviewed before restoring
  // or deleting, but every decision on it is refused by the server — so the
  // controls that would 404 are replaced by the one action that applies.
  const archived = Boolean(event.archived_at);
  const nextStage = getNextStage(event.status);
  const previousStage = getPreviousStage(event.status);
  const isApproved = getStatusBucket(event.status) === "approved";
  // The report exists once the event is Completed or Recorded (the server enforces
  // the same rule on generate and download).
  const canReport = event.status === "completed" || event.status === "recorded";

  // Its own action now, not a rejection wearing a different label (PRD 18).
  const isRevoking = decisionKind === "revoke";
  const isReapproving = decisionKind === "approve" && rejected;
  const isRestoringRevoked = isReapproving && event.status === "revoked";

  const formatStamp = (value) => {
    if (!value) return "date not recorded";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "date not recorded";
    return parsed.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDay = (value) => {
    if (!value) return "Not set";
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  const timeRange =
    meta.startTime || meta.endTime
      ? `${formatTime12h(meta.startTime) || "?"}${
          meta.endTime ? ` – ${formatTime12h(meta.endTime)}` : ""
        }`
      : "Not set";

  // The hero's four facts: what the Dean checks first, in the order they ask.
  const facts = [
    {
      label: event.end_date ? "Dates" : "Date",
      value: formatDateRange(event.event_date, event.end_date),
      Icon: IconCalendar,
    },
    { label: "Venue", value: event.location || "Not set", Icon: IconMapPin },
    { label: "Time", value: timeRange, Icon: IconClock },
    {
      label: "Organizer",
      value: meta.organizer || "Not provided",
      Icon: IconUser,
    },
  ];

  // A teacher submits an event for approval; an Event Manager records one.
  const submitter = submitterOf(event);
  const submittedStamp = submitter.isManager
    ? event.recorded_at || event.created_at
    : event.submitted_at || event.created_at;

  const details = [
    {
      label: submitter.verb,
      value: `${submitter.name} (${submitter.role})${event.teacher_email && event.teacher_email !== submitter.name ? ` · ${event.teacher_email}` : ""}`,
      Icon: IconUser,
    },
    {
      label: "Department",
      value: meta.department || "Not provided",
      Icon: IconBuilding,
    },
    {
      label: "Expected participants",
      value: meta.expectedParticipants || "Not provided",
      Icon: IconUsers,
    },
    { label: "Contact", value: meta.contactInfo || "Not provided", Icon: IconPhone },
  ];

  return (
    <DeanShell active="events" profile={deanProfile} onLogout={handleLogout}>
      {/* Toasts sit bottom-right so feedback never shifts the layout. */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
        {error && (
          <div className="toast toast-err pointer-events-auto" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{error}</p>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}

        {success && (
          <div className="toast toast-ok pointer-events-auto" role="status">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
              <IconCheck className="h-3 w-3" />
            </span>
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{success}</p>
            <button
              type="button"
              onClick={() => setSuccess("")}
              aria-label="Dismiss message"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-wrap px-5 py-8 sm:px-8">

        <Link to="/dean/events" className="btn btn-ghost btn-xs mb-5">
          <IconArrowLeft />
          Back to all events
        </Link>

        {/* -------------------------------------------------------- the hero */}
        <PageHero
          eyebrow={event.event_type || "Program"}
          title={event.event_name}
          subtitle={`${submitter.verb} ${submitter.name} (${submitter.role}) · ${formatStamp(submittedStamp)}`}
          actions={
            <div className="flex items-center gap-2">
              <StatusChip status={event.status} size="md" />
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmText("");
                  setDeleteConfirmOpen(true);
                }}
                disabled={processing || deleting}
                className="btn btn-ghost btn-xs text-err hover:bg-err/10"
                title="Delete this event permanently"
              >
                <IconTrash />
                Delete
              </button>
            </div>
          }
        >
          <dl className="grid gap-4 border-t hairline pt-5 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map((fact) => (
              <div key={fact.label} className="flex items-center gap-3">
                <span className="icon-tile h-9 w-9 rounded-xl">
                  <fact.Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">
                    {fact.label}
                  </dt>
                  <dd className="truncate text-sm font-medium text-ink" title={fact.value}>
                    {fact.value}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </PageHero>

        {/* ====================================================
            TWO-COLUMN BODY
            Left: the evidence.  Right: the decision, always in view.
        ==================================================== */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">

          {/* ================= LEFT ================= */}
          <div className="space-y-6 lg:col-span-8">

            {/* ---------------------------------------- coordination info */}
            <section className="glass p-6">
              <p className="eyebrow">Coordination</p>
              <h2 className="h3 mt-1 border-b hairline pb-4 text-ink">
                Event information
              </h2>

              <dl className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {details.map((item) => (
                  <div key={item.label} className="flex items-start gap-3">
                    <span className="icon-tile h-9 w-9 rounded-xl">
                      <item.Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <dt className="text-xs font-medium text-muted">{item.label}</dt>
                      <dd className="mt-0.5 wrap-break-word text-sm font-semibold text-ink">
                        {item.value}
                      </dd>
                    </div>
                  </div>
                ))}

                <div className="flex items-start gap-3 sm:col-span-2 lg:col-span-3">
                  <span className="icon-tile h-9 w-9 rounded-xl">
                    <IconTag className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-xs font-medium text-muted">
                      Social network link
                    </dt>
                    <dd className="mt-0.5">
                      {event.social_network_url ? (
                        <a
                          href={event.social_network_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link block truncate text-sm font-semibold"
                        >
                          {event.social_network_url}
                        </a>
                      ) : (
                        <span className="text-sm text-muted italic">Not provided</span>
                      )}
                    </dd>
                  </div>
                </div>
              </dl>
            </section>

            {/* ------------------------------------------------ description */}
            <section className="glass overflow-hidden">
              <div className="border-b hairline px-6 py-5">
                <p className="eyebrow">Proposal</p>
                <h2 className="h3 mt-1 text-ink">Event description</h2>
              </div>
              <p className="prose-muted whitespace-pre-line px-6 py-5 text-sm">
                {cleanDescription || "No description provided."}
              </p>
            </section>

            {/* ------------------------------------------ photos and videos */}
            {/* Two dedicated cards showing every item. They used to share one
                height-capped tab, where videos hid below a few photos. */}
            <EventMediaSections
              items={media}
              eventName={event.event_name || "Event"}
              onLoadError={refreshMediaLinks}
            />

            {/* ---------------------------------------------------- documents */}
            <section className="glass overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b hairline px-6 py-4">
                <div className="flex items-center gap-2.5">
                  <span className="icon-tile h-9 w-9 rounded-lg">
                    <IconFileText className="h-4 w-4" />
                  </span>
                  <h2 className="h3 text-base text-ink">Documents</h2>
                </div>
                <span className="chip chip-sm chip-solid num">{documents.length}</span>
              </div>

              <div className="p-5">
                {documents.length === 0 ? (
                  <p className="prose-muted rounded-xl border border-dashed border-line/20 p-6 text-center text-sm">
                    No supporting documents uploaded.
                  </p>
                ) : (
                  <ul className="max-h-85 space-y-2.5 overflow-y-auto">
                    {documents.map((document) => (
                      <li
                        key={document.id}
                        className="flex items-center justify-between gap-3 rounded-xl border hairline bg-raised/40 p-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="icon-tile h-9 w-9 rounded-lg">
                            <IconFileText className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-ink">
                              {document.file_name}
                            </p>
                            <p className="text-[10px] text-muted">
                              {document.file_type || "File"}
                              {document.file_size
                                ? ` · ${(document.file_size / 1024).toFixed(0)} KB`
                                : ""}
                            </p>
                          </div>
                        </div>

                        <a
                          href={document.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-ghost btn-xs shrink-0"
                        >
                          <IconExternalLink />
                          Open
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* ---- Report (post-approval only) ---- */}
            {/* Reports assert a live approval, and the server refuses to
                generate one for an archived event, so the panel goes too. */}
            {isApproved && !archived && (
              <>
                <RidgeDivider className="divider" />

                <section className="glass overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline px-6 py-5">
                    <div className="flex items-center gap-3">
                      <span className="icon-tile">
                        <IconFileText />
                      </span>
                      <div>
                        <p className="eyebrow">Output</p>
                        <h2 className="h3 text-ink">Event report</h2>
                      </div>
                    </div>

                    {canReport && reportGenerated && (
                      <span
                        className="chip chip-track"
                        style={{ "--track": trackOf("approved") }}
                      >
                        <span className="dot dot-sm" />
                        Generated
                      </span>
                    )}
                  </div>

                  <div className="space-y-5 px-6 py-5">
                    <div className="field">
                      <label htmlFor="reportSocialLink">
                        Social network link
                        <span className="ml-2 font-normal text-muted">(Optional)</span>
                      </label>

                      <div className="flex flex-wrap gap-2.5">
                        <input
                          id="reportSocialLink"
                          type="url"
                          value={socialNetworkUrl}
                          onChange={(e) => setSocialNetworkUrl(e.target.value)}
                          placeholder="https://instagram.com/your-event"
                          disabled={savingSocialLink}
                          className="input min-w-0 flex-1"
                        />
                        <button
                          type="button"
                          onClick={handleSaveSocialLink}
                          disabled={savingSocialLink}
                          className="btn btn-ghost btn-sm shrink-0"
                        >
                          {savingSocialLink && <span className="spin h-3.5 w-3.5" />}
                          {savingSocialLink ? "Saving…" : "Save"}
                        </button>
                      </div>

                      {!socialNetworkUrl.trim() && (
                        <p className="prose-muted text-xs">
                          Added to the generated report when present. The report
                          can be generated without it.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2.5 border-t hairline pt-5">
                      <button
                        type="button"
                        onClick={handleOpenReportModal}
                        disabled={reportLoading || !canReport}
                        className="btn btn-brand btn-sm flex-1"
                      >
                        {reportLoading ? (
                          <span className="spin h-3.5 w-3.5" />
                        ) : (
                          <IconRefresh />
                        )}
                        {reportLoading
                          ? "Processing…"
                          : reportGenerated
                          ? "Customize & Regenerate"
                          : "Generate Report"}
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadReport}
                        disabled={reportLoading || !reportGenerated || !canReport}
                        className="btn btn-ghost btn-sm flex-1"
                      >
                        <IconDownload />
                        Download
                      </button>
                    </div>

                    {!canReport && (
                      <p className="prose-muted text-xs" role="note">
                        The report can be generated once the event is marked
                        Completed.
                      </p>
                    )}

                    {canReport && generatedAt && (
                      <p className="num text-[11px] text-muted">
                        Last generated {formatStamp(generatedAt)}
                      </p>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          {/* ================= RIGHT: sticky decision rail ================= */}
          <aside className="space-y-6 lg:col-span-4 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">

            {/* ---- Progress / workflow ---- */}
            <section className="glass overflow-hidden">
              <div className="border-b hairline px-6 py-5">
                <p className="eyebrow">Tracking</p>
                <h2 className="h3 mt-1 text-ink">Event progress</h2>
                <p className="prose-muted mt-0.5 text-xs">
                  Every submission, decision and remark, oldest first.
                </p>
              </div>

              <div className="px-6 py-5">
                <ProgressTimeline
                  event={event}
                  viewerId={deanProfile?.id}
                  perspective="dean"
                />

                {/* PRD 18: the two directions were an unlabelled row of
                    buttons, so it was not obvious which one moved the event
                    forward or what the teacher would see. They are now two
                    labelled groups, each saying what it does. */}
                {(nextStage || previousStage) && (
                  <div className="mt-5 space-y-4 border-t hairline pt-5">
                    <p className="rail-label">Move this event</p>

                    {nextStage && (
                      <div>
                        <button
                          type="button"
                          onClick={() => handleChangeStage(nextStage.key)}
                          disabled={stageSaving}
                          className="btn btn-brand btn-xs"
                        >
                          {stageSaving ? (
                            <span className="spin h-3.5 w-3.5" />
                          ) : (
                            <IconArrowRight />
                          )}
                          {stageSaving ? "Saving…" : nextStage.label}
                        </button>
                        <p className="prose-muted mt-1.5 text-xs">
                          Advances the event. The teacher is notified and sees
                          it as “{nextStage.label}”.
                        </p>
                      </div>
                    )}

                    {previousStage && (
                      <div>
                        <button
                          type="button"
                          onClick={() => setStageBack(previousStage)}
                          disabled={stageSaving}
                          className="btn btn-ghost btn-xs"
                        >
                          <IconArrowLeft />
                          {previousStage.label}
                        </button>
                        <p className="prose-muted mt-1.5 text-xs">
                          Steps the event back. Use this only to undo a stage
                          set by mistake — the teacher is notified of that too.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* ---- Rejection reason ---- */}
            {rejected && refusalReason && (
              <section
                className="overflow-hidden rounded-2xl border"
                data-tint=""
                style={{ "--track": trackOf(event.status) }}
              >
                <div
                  className="flex items-center gap-2.5 border-b px-6 py-4"
                  style={{
                    borderColor: "color-mix(in srgb, var(--track) 22%, transparent)",
                  }}
                >
                  <IconAlertTriangle
                    className="h-5 w-5 shrink-0"
                    style={{ color: trackOf(event.status) }}
                  />
                  <h2 className="h3 text-base text-ink">
                    {event.status === "revoked" ? "Revocation reason" : "Rejection reason"}
                  </h2>
                </div>

                <p className="whitespace-pre-wrap px-6 py-5 text-sm leading-6 text-ink">
                  {refusalReason}
                </p>
              </section>
            )}

            {/* ---- Decision (or, while archived, the way back) ---- */}
            <section className="glass p-6">
              <div className="flex items-center gap-3">
                <span className="icon-tile">
                  {archived ? <IconArchive /> : <IconShield />}
                </span>
                <div>
                  <p className="eyebrow">{archived ? "Archived" : "Decision"}</p>
                  <h2 className="h3 text-ink">
                    {archived ? "This event is archived" : "Dean decision"}
                  </h2>
                </div>
              </div>

              {archived && (
                <>
                  <p className="prose-muted mt-3 text-xs">
                    It is hidden from All Events and from the teacher&rsquo;s
                    list, and no decision can be taken on it until it is
                    restored. Its media, documents and history are untouched.
                  </p>
                  <button
                    type="button"
                    onClick={handleRestore}
                    disabled={processing}
                    className="btn btn-ok btn-sm mt-5 w-full"
                  >
                    {processing ? <span className="spin h-3.5 w-3.5" /> : <IconArchive />}
                    {processing ? "Restoring…" : "Restore this event"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteConfirmText("");
                      setDeleteConfirmOpen(true);
                    }}
                    disabled={processing || deleting}
                    className="btn btn-danger btn-sm mt-3 w-full"
                  >
                    <IconTrash />
                    Delete permanently
                  </button>
                </>
              )}

              {!archived && (
              <p className="prose-muted mt-3 flex items-center gap-1.5 text-xs">
                Currently
                <StatusChip status={event.status} />
              </p>
              )}
              {!archived && event.status !== "recorded" && (
              <p className="prose-muted mt-1.5 text-xs">
                You can revise a decision at any time; the teacher sees each one in their history.
              </p>
              )}
              {!archived && event.status === "recorded" && (
              <p className="prose-muted mt-1.5 text-xs">
                This event was directly recorded by the Event Manager.
              </p>
              )}

              <div className={`mt-5 flex-wrap gap-2.5 ${archived ? "hidden" : "flex"}`}>
                {canApprove(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision("approve")}
                    disabled={processing}
                    className="btn btn-ok btn-sm flex-1"
                  >
                    <IconCheck />
                    {getApproveLabel(event)}
                  </button>
                )}

                {/* Reject and Revoke are distinct actions over distinct
                    statuses, so exactly one of them applies at a time. */}
                {canReject(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision("reject")}
                    disabled={processing}
                    className="btn btn-danger btn-sm flex-1"
                  >
                    <IconX />
                    Reject
                  </button>
                )}

                {canRevoke(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision("revoke")}
                    disabled={processing}
                    className="btn btn-ghost btn-sm flex-1 text-err"
                  >
                    <IconX />
                    Revoke approval
                  </button>
                )}

                {canRequestChanges(event) && (
                  <button
                    type="button"
                    onClick={() => openDecision("changes")}
                    disabled={processing}
                    className="btn btn-ghost btn-sm w-full"
                  >
                    <IconEdit />
                    Request changes
                  </button>
                )}

                <div className="mt-2 w-full border-t hairline pt-3">
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteConfirmText("");
                      setDeleteConfirmOpen(true);
                    }}
                    disabled={processing || deleting}
                    className="btn btn-ghost btn-sm w-full text-err hover:bg-err/10"
                  >
                    <IconTrash />
                    Delete this event
                  </button>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>

      {/* Stepping an event backwards removes a stage the teacher has already
          been told about, so it confirms first. Advancing does not — that is
          the expected direction and is trivially undone by this same control. */}
      <Modal
        open={Boolean(stageBack)}
        onClose={() => !stageSaving && setStageBack(null)}
        eyebrow="Event progress"
        title={`Move this event back to ${stageBack?.label?.replace(/^Move back to /i, "") || "the previous stage"}?`}
        subtitle="The teacher is notified, and the event loses the later stage."
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setStageBack(null)}
              disabled={stageSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={stageSaving}
              onClick={async () => {
                const target = stageBack;
                setStageBack(null);
                if (target) await handleChangeStage(target.key);
              }}
            >
              {stageSaving ? <span className="spin h-3.5 w-3.5" /> : <IconArrowLeft />}
              {stageSaving ? "Saving…" : "Move back"}
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">
          Use this to undo a stage that was set by mistake. If the event really
          did move backwards, say so in the event history instead so the record
          stays accurate.
        </p>
      </Modal>

      {/* ==================================================================
          THE DECISION
          One dialog for both halves of the decision, the same one the All
          Events table opens, so the two screens cannot drift apart.
      ================================================================== */}
      <Modal
        open={Boolean(decisionKind)}
        onClose={closeDecision}
        eyebrow="Confirm"
        title={
          decisionKind === "approve"
            ? isReapproving
              ? "Re-approve event"
              : "Do you want to approve?"
            : decisionKind === "changes"
            ? "Request changes"
            : isRevoking
            ? "Revoke this approval?"
            : "Reject event"
        }
        subtitle={
          decisionKind === "approve"
            ? "The teacher is notified of the decision."
            : decisionKind === "changes"
            ? "The event goes back to the teacher to edit and resubmit."
            : "The teacher sees the reason you give."
        }
        footer={
          <>
            <button
              type="button"
              onClick={closeDecision}
              disabled={processing}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>

            {decisionKind === "approve" ? (
              <button
                type="button"
                onClick={confirmApprove}
                disabled={processing}
                className="btn btn-ok btn-sm"
              >
                {processing ? <span className="spin h-3.5 w-3.5" /> : <IconCheck />}
                {processing ? "Approving…" : isReapproving ? "Re-approve" : "Approve"}
              </button>
            ) : decisionKind === "changes" ? (
              <button
                type="button"
                onClick={confirmReject}
                disabled={processing}
                className="btn btn-primary btn-sm"
              >
                {processing ? <span className="spin h-3.5 w-3.5" /> : <IconEdit />}
                {processing ? "Sending…" : "Send to teacher"}
              </button>
            ) : (
              <button
                type="button"
                onClick={confirmReject}
                disabled={processing}
                className="btn btn-danger btn-sm"
              >
                {processing ? <span className="spin h-3.5 w-3.5" /> : <IconX />}
                {processing
                  ? isRevoking
                    ? "Revoking…"
                    : "Rejecting…"
                  : isRevoking
                  ? "Revoke approval"
                  : "Reject"}
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
                decisionKind === "approve" ? trackOf("approved") : trackOf("rejected"),
            }}
          >
            {decisionKind === "approve" ? <IconCheckCircle /> : <IconAlertTriangle />}
          </span>

          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              {event.event_name || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              {[event.event_type, formatDay(event.event_date), event.location]
                .filter(Boolean)
                .join(" · ") || "No details recorded"}
            </p>
          </div>
        </div>

        {/* What the decision actually changes, when it is not the plain case */}
        {(isRevoking || isReapproving) && (
          <div
            className="mt-4 rounded-xl border px-4 py-3"
            data-tint=""
            style={{ "--track": trackOf(isRevoking ? "rejected" : "approved") }}
          >
            <p className="text-sm text-ink">
              {isRevoking
                ? "This event is approved. Revoking withdraws that approval, invalidates any generated report, and notifies the teacher — who can then fix and resubmit it."
                : isRestoringRevoked
                ? "This event's approval was revoked. Re-approving restores it, clears the revocation reason, and puts the delivery stages back within reach."
                : "This event is rejected. Re-approving it clears the existing rejection reason and notifies the teacher."}
            </p>
          </div>
        )}

        {/* Every refusal carries a reason. Revoke must be listed here too:
            confirmReject refuses to send without one, so leaving it out made
            the Revoke button do nothing at all, silently. */}
        {decisionKind !== "approve" && decisionKind !== null && (
          <div className="field mt-5">
            <label htmlFor="deanRejectReason">
              {decisionKind === "changes"
                ? "What should the teacher change?"
                : decisionKind === "revoke"
                ? "Reason for revoking approval"
                : "Reason for rejection"}
              <span className="req">*</span>
            </label>

            <textarea
              id="deanRejectReason"
              value={rejectReason}
              onChange={(e) => {
                setRejectReason(e.target.value);
                if (reasonError) setReasonError("");
              }}
              rows={4}
              autoFocus
              placeholder={
                decisionKind === "revoke"
                  ? "Why is this approval being withdrawn?"
                  : "What needs to change before this can be approved?"
              }
              aria-invalid={reasonError ? "true" : undefined}
              aria-describedby={reasonError ? "deanRejectReasonError" : undefined}
              className="input"
            />

            {reasonError && (
              <p id="deanRejectReasonError" className="field-error">
                {reasonError}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Permanent Deletion Dialog */}
      <Modal
        open={deleteConfirmOpen}
        onClose={() => {
          if (!deleting) {
            setDeleteConfirmOpen(false);
            setDeleteConfirmText("");
          }
        }}
        eyebrow="Permanent Deletion"
        title="Delete this event permanently?"
        subtitle={event?.event_name || ""}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setDeleteConfirmOpen(false);
                setDeleteConfirmText("");
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleDeleteEvent}
              disabled={deleting || deleteConfirmText !== "DELETE"}
            >
              {deleting ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
              Delete permanently
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
              {event?.event_name || "Untitled Event"}
            </p>
            <p className="prose-muted mt-1 text-xs">
              This will permanently delete the event, its media files, documents, and generated reports from the system. This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="field mt-4">
          <label htmlFor="deanEventDeleteConfirm">
            Type <span className="font-semibold">DELETE</span> to confirm
          </label>
          <input
            id="deanEventDeleteConfirm"
            type="text"
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            autoComplete="off"
            placeholder="DELETE"
            className="input"
          />
        </div>
      </Modal>

      <ReportCustomizationModal
        open={showReportModal}
        onClose={() => setShowReportModal(false)}
        onGenerate={handleGenerateReport}
        generating={reportLoading}
        eventName={event?.event_name}
        photoCount={media?.filter((m) => m.media_type === "image").length}
        documentCount={documents?.length}
        noticeCount={documents?.filter((d) => d.category !== "report").length}
        attachmentCount={(documents?.filter((d) => d.category === "report").length || 0) + (media?.length || 0)}
      />
    </DeanShell>
  );
}

export default EventDetails;
