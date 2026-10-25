import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import Modal from "../../components/teacher/Modal";
import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheckCircle,
  IconDownload,
  IconInfo,
  IconRotateCcw,
  IconTrash,
  IconXCircle,
} from "../../components/teacher/icons";
import EvidencePanel from "../../components/research/EvidencePanel";
import { DuplicateNotice } from "../../components/research/ResearchNotices";
import ResearchFacts from "../../components/research/ResearchFacts";
import ResearchTimeline from "../../components/research/ResearchTimeline";
import { OutcomeChip, VerificationChip } from "../../components/research/ResearchChips";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { deanDecideResearch, deanDeleteResearch, deanGetResearch, downloadResearchCv } from "../../services/research";
import { authorNames, changesSinceVerified } from "../../utils/research";

const ROLE_LABEL = { teacher: "the teacher", event_manager: "an Event Manager" };

const DONE = {
  verify: "Verified. The teacher and whoever entered the record have been told.",
  "request-changes": "Sent back for changes, with your remarks.",
  reject: "Rejected, with your reason.",
  unverify: "Verification withdrawn. The record is back with its authors for a correction.",
};

/**
 * One research record for the Dean: what it claims, the evidence behind it,
 * what changed since it was last verified, and the decision.
 */
export default function ResearchDetails() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { profile, logout } = useShellProfile();
  const { byKey } = useResearchCategories();

  const [record, setRecord] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [cvError, setCvError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await deanGetResearch(recordId);
      setRecord(body.record);
      setLoadError("");
    } catch (err) {
      setLoadError(err?.message || "This record could not be loaded.");
    }
  }, [recordId]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (verb) => {
    setError("");
    const needsReason = verb !== "verify";
    if (needsReason && remarks.trim().length < 3) {
      setError(
        verb === "reject"
          ? "Say why the record is rejected — the authors see your reason."
          : "Say what needs to change — the authors see your remarks.",
      );
      return;
    }
    setBusy(verb);
    try {
      const body = await deanDecideResearch(recordId, verb, remarks.trim() || undefined);
      setRecord(body.record);
      setRemarks("");
      setDone(DONE[verb]);
    } catch (err) {
      setError(err?.message || "The decision could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const removeRecord = async () => {
    setDeleteError("");
    setDeleting(true);
    try {
      await deanDeleteResearch(recordId);
      navigate("/dean/research", { replace: true });
    } catch (err) {
      setDeleteError(err?.message || "The research record could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  const category = record ? byKey[record.category] || record.category_definition : null;
  const perms = record?.permissions || {};
  const changes = record?.verification_status === "submitted" ? changesSinceVerified(record, category) : [];
  const enteredBy =
    record && record.created_by !== record.faculty_id
      ? `Entered by ${record.created_by_name} (${ROLE_LABEL[record.created_by_role] || record.created_by_role})`
      : "Entered by the faculty member";

  return (
    <DeanShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to="/dean/research" className="btn btn-ghost btn-sm">
            <IconArrowLeft />
            Back to research
          </Link>
          {record && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={async () => {
                  setCvError("");
                  try {
                    await downloadResearchCv(record.faculty_id, { dean: true });
                  } catch (err) {
                    setCvError(err?.message || "The CV could not be generated.");
                  }
                }}
                className="btn btn-ghost btn-xs"
                title={`${record.faculty?.name}'s research as a PDF`}
              >
                <IconDownload />
                Research CV
              </button>
              <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-danger btn-xs">
                <IconTrash />
                Delete record
              </button>
            </div>
          )}
        </div>
        {cvError && (
          <p className="field-error -mt-3 mb-4 text-right" role="alert">
            {cvError}
          </p>
        )}

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
            {done && (
              <div className="toast toast-ok mb-5" role="status">
                <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
                <p className="min-w-0 flex-1 text-sm font-medium text-ink">{done}</p>
                <Link to="/dean/research" className="btn btn-ghost btn-xs shrink-0">
                  Next in queue
                </Link>
              </div>
            )}

            <PageHero
              compact
              eyebrow={category?.label || record.category_label}
              title={record.title}
              subtitle={`${authorNames(record) || "Unknown teacher"} · ${enteredBy}`}
              actions={
                <div className="flex flex-wrap gap-2">
                  {!record.recorded_by_manager && (
                    <VerificationChip status={record.verification_status} size="md" />
                  )}
                  <OutcomeChip category={category} outcome={record.outcome_status} size="md" />
                </div>
              }
            />

            {record.duplicates?.length > 0 && (
              <div className="mt-6">
                <DuplicateNotice
                  duplicates={record.duplicates}
                  linkTo={(id) => `/dean/research/${id}`}
                  title="Also claimed by other faculty"
                />
              </div>
            )}

            {/* ------------------------------- what changed since verified */}
            {changes.length > 0 && (
              <section className="glass mt-6 overflow-hidden">
                <div className="border-b hairline px-5 py-4 sm:px-6">
                  <h2 className="h3 text-base text-ink">Changed since you verified it</h2>
                  <p className="prose-muted mt-0.5 text-xs">
                    {record.verified_by?.name ? `${record.verified_by.name} verified` : "Verified"} the earlier
                    version; only these differ.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-[.12em] text-muted">
                        <th className="px-5 py-2 font-semibold sm:px-6">Field</th>
                        <th className="px-3 py-2 font-semibold">Verified</th>
                        <th className="px-3 py-2 font-semibold">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((row, index) => (
                        <tr key={`${row.label}-${index}`} className="border-t hairline align-top">
                          <td className="px-5 py-2.5 font-medium text-ink sm:px-6">{row.label}</td>
                          <td className="px-3 py-2.5 text-muted line-through decoration-err/40">{row.before}</td>
                          <td className="px-3 py-2.5 font-medium text-ink">{row.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ------------------------------------------------ decision */}
            {(perms.can_verify || perms.can_unverify) && (
              <section className="glass mt-6 p-5 sm:p-6">
                <h2 className="h3 text-base text-ink">
                  {perms.can_verify ? "Your decision" : "Withdraw the verification"}
                </h2>
                <p className="prose-muted mt-0.5 text-xs">
                  {perms.can_verify
                    ? // Only a teacher's own submission reaches this point: what the
                      // Event Manager enters or works on is recorded without the Dean.
                      `${record.faculty?.name || "The faculty member"} submitted this record themselves. ` +
                      "Check the details against the evidence below. Remarks are optional to verify and required to send back or reject."
                    : "If a verified record turns out to be wrong, send it back to its authors with what needs correcting."}
                </p>
                <div className="field mt-4">
                  <label htmlFor="dean-remarks">
                    Remarks
                    {perms.can_verify && <span className="ml-2 font-normal text-muted">(Optional to verify)</span>}
                  </label>
                  <textarea
                    id="dean-remarks"
                    rows={3}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    maxLength={2000}
                    placeholder={
                      perms.can_verify
                        ? "e.g. Attach the grant certificate; the filing receipt alone does not show the grant."
                        : "What is wrong with the verified record?"
                    }
                    className="input"
                  />
                </div>
                {error && (
                  <p className="field-error mt-2" role="alert">
                    {error}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {perms.can_verify ? (
                    <>
                      <button type="button" onClick={() => decide("verify")} disabled={Boolean(busy)} className="btn btn-ok">
                        {busy === "verify" ? <span className="spin h-4 w-4" /> : <IconCheckCircle />}
                        Verify
                      </button>
                      <button
                        type="button"
                        onClick={() => decide("request-changes")}
                        disabled={Boolean(busy)}
                        className="btn btn-ghost"
                      >
                        {busy === "request-changes" ? <span className="spin h-4 w-4" /> : <IconRotateCcw />}
                        Request changes
                      </button>
                      <button type="button" onClick={() => decide("reject")} disabled={Boolean(busy)} className="btn btn-danger">
                        {busy === "reject" ? <span className="spin h-4 w-4" /> : <IconXCircle />}
                        Reject
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => decide("unverify")} disabled={Boolean(busy)} className="btn btn-danger">
                      {busy === "unverify" ? <span className="spin h-4 w-4" /> : <IconRotateCcw />}
                      Withdraw verification
                    </button>
                  )}
                </div>
              </section>
            )}

            {perms.own && (
              <div className="mt-6 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("under_review") }} role="note">
                <IconInfo className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("under_review") }} />
                <p className="text-sm text-ink">This is your own research record, so another Dean has to decide on it.</p>
              </div>
            )}

            {(record.verification_status === "changes_requested" || record.verification_status === "rejected") &&
              record.dean_remarks && (
                <div
                  className="mt-6 rounded-2xl border px-5 py-4"
                  data-tint=""
                  style={{ "--track": trackOf(record.verification_status === "rejected" ? "rejected" : "under_review") }}
                >
                  <p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Your remarks</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink">{record.dean_remarks}</p>
                </div>
              )}

            <div className="mt-6 space-y-6">
              {record.evidence?.length > 0 && (
                <section className="glass p-5 sm:p-6">
                  <h2 className="h3 text-base text-ink">Evidence</h2>
                  <div className="mt-4">
                    <EvidencePanel evidence={record.evidence} />
                  </div>
                </section>
              )}
              {/* The record's activity sits under its details, one merged line
                  per sitting, rather than in a card of its own. */}
              <section className="glass p-5 sm:p-6">
                <h2 className="h3 text-base text-ink">Details</h2>
                <div className="mt-4">
                  <ResearchFacts record={record} category={category} />
                </div>
                <div className="mt-6 border-t hairline pt-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Activity</h3>
                  <div className="mt-3">
                    <ResearchTimeline history={record.history} />
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        eyebrow="Delete research"
        title="Delete this research record?"
        subtitle="This permanently deletes the record and its evidence files from the research portfolio."
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn btn-ghost btn-sm">
              Cancel
            </button>
            <button type="button" onClick={removeRecord} disabled={deleting} className="btn btn-danger btn-sm">
              {deleting ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete record
            </button>
          </>
        }
      >
        {deleteError && <p className="field-error mb-3" role="alert">{deleteError}</p>}
        <p className="text-sm text-ink">{record?.title}</p>
      </Modal>
    </DeanShell>
  );
}
