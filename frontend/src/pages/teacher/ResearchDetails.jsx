import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import Modal from "../../components/teacher/Modal";
import PageHero from "../../components/teacher/PageHero";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheckCircle,
  IconEdit,
  IconInfo,
  IconSave,
  IconTrash,
  IconUploadCloud,
} from "../../components/teacher/icons";
import EvidencePanel from "../../components/research/EvidencePanel";
import { DuplicateNotice, RemindersNotice } from "../../components/research/ResearchNotices";
import ResearchFacts from "../../components/research/ResearchFacts";
import ResearchTimeline from "../../components/research/ResearchTimeline";
import { OutcomeChip, VerificationChip } from "../../components/research/ResearchChips";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import {
  deleteResearch,
  flagResearch,
  getResearch,
  removeEvidence,
  submitResearch,
  uploadEvidence,
} from "../../services/research";

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/**
 * One research record, for whoever may author it: the Event Manager (any
 * teacher's) or the teacher it belongs to. Evidence is attached here, and the
 * record is sent to the Dean from here.
 */
export default function ResearchDetails() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const panel = usePanel();
  const manager = panel.role === "event_manager";
  // The Event Manager's pages use the Dean's spacing (16px between blocks).
  const sectionGap = manager ? "mt-4" : "mt-6";
  const { profile, logout } = useShellProfile();
  const { byKey, limits } = useResearchCategories();

  const [record, setRecord] = useState(null);
  const [loadError, setLoadError] = useState("");
  // What the form just did (saved, recorded, submitted), and anything that
  // did not go through: a file that failed to upload, a refused submission.
  const [notice, setNotice] = useState(location.state?.notice || (location.state?.created ? "created" : ""));
  const [actionError, setActionError] = useState(() => {
    const failed = location.state?.failed || [];
    if (failed.length) return `Saved, but ${failed.length === 1 ? "a file" : "some files"} did not upload — ${failed.join("; ")}. Attach ${failed.length === 1 ? "it" : "them"} again below.`;
    return location.state?.submitError || "";
  });
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [flagging, setFlagging] = useState(false);
  const [flagError, setFlagError] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await getResearch(recordId);
      setRecord(body.record);
      setLoadError("");
    } catch (err) {
      setLoadError(err?.message || "This record could not be loaded.");
    }
  }, [recordId]);

  useEffect(() => {
    load();
  }, [load]);

  const category = record ? byKey[record.category] || record.category_definition : null;
  const categoryActive = Boolean(record && byKey[record.category]);
  const perms = record?.permissions || {};
  const missing = record?.missing || [];
  // Research evidence is optional for Event Manager submissions. Teachers
  // keep the configurable evidence requirement.
  const evidenceRequired = !manager && Boolean(limits?.evidence_required);
  const noEvidence = evidenceRequired && (record?.evidence || []).length === 0;
  const state = record?.verification_status;

  // The button is never greyed out: a disabled button reads as broken.
  // Clicking it with something missing says exactly what, and where.
  const submit = async () => {
    setActionError("");
    if (missing.length > 0) {
      setActionError(`Fill in ${missing.join(", ")} first — “Fill in” opens the form with them marked.`);
      return;
    }
    if (noEvidence) {
      setActionError("Attach at least one piece of evidence first, in the Evidence section below.");
      document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setSubmitting(true);
    try {
      const body = await submitResearch(recordId);
      setRecord(body.record);
      setNotice(body.record?.recorded_by_manager ? "recorded" : "submitted");
    } catch (err) {
      setActionError(err?.message || "The record could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteResearch(recordId);
      navigate(`${panel.base}/research`, { replace: true });
    } catch (err) {
      setActionError(err?.message || "The record could not be deleted.");
      setConfirmDelete(false);
      setDeleting(false);
    }
  };

  const sendFlag = async () => {
    setFlagError("");
    setFlagging(true);
    try {
      const body = await flagResearch(recordId, flagNote);
      setRecord(body.record);
      setFlagOpen(false);
      setFlagNote("");
      setNotice("flagged");
    } catch (err) {
      setFlagError(err?.message || "The correction could not be sent.");
    } finally {
      setFlagging(false);
    }
  };

  const upload = async (file, tag, onProgress) => {
    const body = await uploadEvidence(recordId, file, tag, { onProgress });
    setRecord(body.record);
    if (state === "verified") setNotice("reverification");
  };

  const dropEvidence = async (entry) => {
    const body = await removeEvidence(recordId, entry.id);
    setRecord(body.record);
    if (state === "verified") setNotice("reverification");
  };

  const NOTICES = {
    created: manager
      ? "Saved as a draft. Attach the evidence below, then record it."
      : "Saved as a draft. Attach the evidence below, then send it to the Dean for verification.",
    submitted: "Sent to the Dean for verification. You will be notified of the decision.",
    recorded: "Recorded in the research portfolio. Event Manager submissions do not need Dean verification.",
    flagged: "Correction sent to the Event Manager who entered this record.",
    reverification: "The record changed after verification, so it has gone back to the Dean.",
    saved: "Changes saved.",
  };

  return (
    <TeacherShell active="research" profile={profile} onLogout={logout}>
      <div className={`mx-auto w-full max-w-wrap px-5 sm:px-8 ${manager ? "py-6" : "py-8"}`}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to={`${panel.base}/research`} className={`btn btn-ghost ${manager ? "btn-xs" : "btn-sm"}`}>
            <IconArrowLeft />
            Back to research
          </Link>

          {record && (
            <div className="flex flex-wrap items-center gap-2">
              {perms.can_flag && (
                <button type="button" onClick={() => setFlagOpen(true)} className="btn btn-ghost btn-xs">
                  <IconAlertTriangle />
                  Flag a correction
                </button>
              )}
              {perms.can_delete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="btn btn-ghost btn-xs text-err hover:border-err/50"
                >
                  <IconTrash />
                  Delete
                </button>
              )}
              {perms.can_edit && categoryActive && (
                <Link to={`${panel.base}/research/${record.id}/edit`} className="btn btn-ghost btn-xs">
                  <IconEdit />
                  {state === "verified" ? "Update" : "Edit"}
                </Link>
              )}
            </div>
          )}
        </div>

        {loadError && (
          <div className="flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm text-ink">{loadError}</p>
            <button type="button" onClick={load} className="btn btn-ghost btn-xs">
              Retry
            </button>
          </div>
        )}

        {!record && !loadError && (
          <div className="flex h-60 items-center justify-center">
            <span className="spin h-9 w-9 text-accent" />
          </div>
        )}

        {record && (
          <>
            {notice && (
              <div className="toast toast-ok mb-5" role="status">
                <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
                <p className="min-w-0 flex-1 text-sm font-medium text-ink">{NOTICES[notice]}</p>
              </div>
            )}

            <PageHero
              compact
              eyebrow={category?.label || record.category_label}
              title={record.title}
              subtitle={
                manager
                  ? record.faculty?.name || "Unknown teacher"
                  : record.created_by !== record.faculty_id && record.created_by_name
                    ? `Entered by ${record.created_by_name} (Event Manager)`
                    : undefined
              }
              actions={
                <div className="flex flex-wrap gap-2">
                  {(!manager || record.recorded_by_manager) && (
                    <VerificationChip status={state} recorded={record.recorded_by_manager} size="md" />
                  )}
                  <OutcomeChip category={category} outcome={record.outcome_status} size="md" />
                </div>
              }
            />

            <div className={`${sectionGap} space-y-4 empty:hidden`}>
              <RemindersNotice reminders={record.reminders} editTo={`${panel.base}/research/${record.id}/edit`} />
              <DuplicateNotice duplicates={record.duplicates} linkTo={(id) => `${panel.base}/research/${id}`} />
            </div>

            {/* ------------------------------------------- the Dean's word */}
            {(state === "changes_requested" || state === "rejected") && record.dean_remarks && (
              <section
                className={`${sectionGap} flex items-start gap-3 rounded-2xl border px-5 py-4`}
                data-tint=""
                style={{ "--track": trackOf(state === "rejected" ? "rejected" : "under_review") }}
                role="status"
              >
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf(state === "rejected" ? "rejected" : "under_review") }} />
                <div className="min-w-0">
                  <h2 className="h3 text-base text-ink">
                    {state === "rejected" ? "Rejected by the Dean" : "The Dean asked for changes"}
                  </h2>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink">{record.dean_remarks}</p>
                  <p className="prose-muted mt-1 text-xs">Fix the record, then resubmit it below.</p>
                </div>
              </section>
            )}

            {state === "verified" && (
              <section
                className={`${sectionGap} flex items-start gap-3 rounded-2xl border px-5 py-4`}
                data-tint=""
                style={{ "--track": trackOf("approved") }}
                role="status"
              >
                <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("approved") }} />
                <div className="min-w-0">
                  {record.recorded_by_manager ? (
                    <>
                      <h2 className="h3 text-base text-ink">Recorded by the Event Manager</h2>
                      <p className="prose-muted mt-0.5 text-sm">
                        {record.verified_by?.name ? `${record.verified_by.name} recorded` : "Recorded"} this record
                        {record.verified_at ? ` on ${when(record.verified_at)}` : ""}. Event Manager submissions do not
                        need the Dean's verification.
                      </p>
                    </>
                  ) : (
                    <>
                      <h2 className="h3 text-base text-ink">Verified by the Dean</h2>
                      <p className="prose-muted mt-0.5 text-sm">
                        {record.verified_by?.name ? `${record.verified_by.name} verified` : "Verified"} this record
                        {record.verified_at ? ` on ${when(record.verified_at)}` : ""}.
                        {record.dean_remarks && ` “${record.dean_remarks}”`}
                      </p>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ------------------------------------------- send it to the Dean */}
            {perms.can_submit && (
              <section className={`glass ${sectionGap} p-5 sm:p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 basis-72">
                    <h2 className="h3 text-base text-ink">
                      {manager
                        ? "Ready to record it?"
                        : state === "draft"
                          ? "Ready to send to the Dean?"
                          : "Resubmit for verification"}
                    </h2>
                    {missing.length === 0 && !noEvidence ? (
                      <p className="prose-muted mt-1 text-sm">
                        {manager
                          ? "Everything is here. Recording adds it to the portfolio straight away — no Dean verification."
                          : "Everything the Dean needs is here."}
                      </p>
                    ) : (
                      <ul className="mt-2 list-none space-y-1 p-0 text-sm text-ink">
                        {missing.length > 0 && (
                          <li className="flex items-start gap-2">
                            <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                            <span>
                              Still to fill in: <span className="font-medium">{missing.join(", ")}</span>
                            </span>
                          </li>
                        )}
                        {noEvidence && (
                          <li className="flex items-start gap-2">
                            <IconUploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                            <span>Attach at least one piece of evidence.</span>
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {missing.length > 0 && categoryActive && (
                      <Link to={`${panel.base}/research/${record.id}/edit?fill=1`} className="btn btn-ghost btn-sm">
                        <IconEdit />
                        Fill in
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={submit}
                      disabled={submitting}
                      className="btn btn-primary btn-sm"
                    >
                      {submitting ? <span className="spin h-4 w-4" /> : <IconSave />}
                      {manager ? "Record" : state === "draft" ? "Submit for verification" : "Resubmit"}
                    </button>
                  </div>
                </div>
                {actionError && (
                  <p className="field-error mt-3" role="alert">
                    {actionError}
                  </p>
                )}
              </section>
            )}
            {!perms.can_submit && actionError && (
              <p className="field-error mt-4" role="alert">
                {actionError}
              </p>
            )}

            <div className={`${sectionGap} ${manager ? "space-y-4" : "space-y-6"}`}>
              <div className="min-w-0 space-y-6">
                {/* The record's activity sits under its details, one merged
                    line per sitting, rather than in a card of its own. */}
                <section className="glass p-5 sm:p-6">
                  <h2 className="h3 text-base text-ink">Details</h2>
                  <div className="mt-4">
                    <ResearchFacts record={record} category={category} />
                  </div>
                  <div className={`${sectionGap} border-t hairline pt-5`}>
                    <h3 className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Activity</h3>
                    <div className="mt-3">
                      <ResearchTimeline history={record.history} />
                    </div>
                  </div>
                </section>

                <section id="evidence" className="glass scroll-mt-24 p-5 sm:p-6">
                  <h2 className="h3 text-base text-ink">Evidence</h2>
                  <p className="prose-muted mt-0.5 text-xs">
                    The paper, certificates or letters behind this record.
                    {evidenceRequired ? " At least one is needed before it is submitted." : " Optional."}
                    {state === "verified" && !manager && " Changing it sends the record back for verification."}
                  </p>
                  <div className="mt-4">
                    <EvidencePanel
                      required={evidenceRequired}
                      evidence={record.evidence}
                      tags={category?.evidence_tags || []}
                      limits={limits}
                      onUpload={upload}
                      onRemove={dropEvidence}
                    />
                  </div>
                </section>
              </div>
            </div>
          </>
        )}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        eyebrow="Delete research record"
        title="Delete this record?"
        subtitle={
          manager && record?.verification_status !== "draft"
            ? "It is removed from your list. It has been submitted, so it stays on the Dean's side, with its evidence."
            : "The record and its evidence files are removed for good."
        }
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={remove} disabled={deleting} className="btn btn-danger">
              {deleting ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">“{record?.title}”</p>
      </Modal>

      <Modal
        open={flagOpen}
        onClose={() => !flagging && setFlagOpen(false)}
        eyebrow="Flag a correction"
        title="What is wrong with this record?"
        subtitle="The Event Manager who entered it is notified and can fix it."
        footer={
          <>
            <button type="button" onClick={() => setFlagOpen(false)} disabled={flagging} className="btn btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={sendFlag}
              disabled={flagging || flagNote.trim().length < 3}
              className="btn btn-primary"
            >
              {flagging ? <span className="spin h-4 w-4" /> : <IconAlertTriangle />}
              Send
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="flag-note">Correction</label>
          <textarea
            id="flag-note"
            rows={4}
            value={flagNote}
            onChange={(e) => setFlagNote(e.target.value)}
            maxLength={1000}
            placeholder="e.g. The application number should be 202611012346."
            className="input"
          />
          {flagError && <p className="field-error">{flagError}</p>}
        </div>
      </Modal>
    </TeacherShell>
  );
}
