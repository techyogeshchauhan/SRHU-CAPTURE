import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import Modal from "../../components/teacher/Modal";
import PageHero from "../../components/teacher/PageHero";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { trackOf } from "../../components/teacher/status";
import { IconAlertTriangle, IconLayers, IconPlus } from "../../components/teacher/icons";
import ResearchNav from "../../components/research/ResearchNav";
import useShellProfile from "../../components/research/useShellProfile";
import { createShowcase, listShowcases } from "../../services/research";

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Showcases: curated collections of verified records presented to the Dean.
 * The Event Manager sees every showcase (they build them as a team); a
 * teacher sees their own.
 */
export default function ResearchShowcases() {
  const panel = usePanel();
  const navigate = useNavigate();
  const manager = panel.role === "event_manager";
  const { profile, logout } = useShellProfile();

  const [showcases, setShowcases] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    listShowcases()
      .then((body) => setShowcases(body.showcases || []))
      .catch((err) => setError(err?.message || "Showcases could not be loaded."));
  }, []);

  const create = async () => {
    setFormError("");
    if (!form.title.trim()) {
      setFormError("Give the showcase a title.");
      return;
    }
    setSaving(true);
    try {
      const body = await createShowcase({ title: form.title, description: form.description || null });
      navigate(`${panel.base}/research/showcases/${body.showcase.id}`);
    } catch (err) {
      setFormError(err?.message || "The showcase could not be created.");
      setSaving(false);
    }
  };

  return (
    <TeacherShell active="research" profile={profile} onLogout={logout}>
      <div className={`mx-auto w-full max-w-wrap px-5 sm:px-8 ${manager ? "py-6" : "py-8"}`}>
        <PageHero
          compact={manager}
          eyebrow={manager ? undefined : "Research portfolio"}
          title="Research"
          accent="Showcases"
          subtitle={
            manager
              ? undefined
              : "Present your verified research to the Dean as one curated collection, with a short note about it."
          }
          actions={
            <button type="button" onClick={() => setCreating(true)} className="btn btn-primary">
              <IconPlus />
              New showcase
            </button>
          }
        />
        <ResearchNav base={`${panel.base}/research`} active="showcases" role={panel.role} />

        {error && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm text-ink">{error}</p>
          </div>
        )}

        {!showcases && !error ? (
          <div className="flex h-48 items-center justify-center">
            <span className="spin h-8 w-8 text-accent" />
          </div>
        ) : showcases?.length === 0 ? (
          <div className="glass mt-5 flex flex-col items-center px-6 py-14 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconLayers className="h-6 w-6" />
            </span>
            <p className="h3 text-ink">No showcases yet</p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              Pick verified records, add a short narrative, choose the highlights and send it to the Dean. They can open
              it as a presentation and download it as a PDF.
            </p>
            <button type="button" onClick={() => setCreating(true)} className="btn btn-primary btn-sm mt-5">
              <IconPlus />
              New showcase
            </button>
          </div>
        ) : (
          <ul className="mt-5 grid list-none gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
            {(showcases || []).map((showcase) => (
              <li key={showcase.id}>
                <Link
                  to={`${panel.base}/research/showcases/${showcase.id}`}
                  className="glass group flex h-full flex-col p-5 transition hover:-translate-y-0.5"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="chip chip-sm chip-track"
                      style={{ "--track": trackOf(showcase.status === "sent" ? "approved" : "draft") }}
                    >
                      <span className="dot dot-sm" />
                      {showcase.status === "sent" ? "Sent to the Dean" : "Draft"}
                    </span>
                    {showcase.status === "sent" && (showcase.viewed_by || []).length > 0 && (
                      <span className="text-xs text-muted">Seen by {showcase.viewed_by.map((v) => v.name).join(", ")}</span>
                    )}
                  </span>
                  <span className="mt-3 font-display text-lg font-semibold leading-snug text-ink group-hover:text-accent">
                    {showcase.title}
                  </span>
                  {showcase.description && (
                    <span className="prose-muted mt-1 line-clamp-2 text-sm">{showcase.description}</span>
                  )}
                  <span className="mt-auto pt-4 text-xs text-muted">
                    {showcase.record_count} {showcase.record_count === 1 ? "record" : "records"}
                    {manager && ` · by ${showcase.owner_name}`} · updated {when(showcase.updated_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => !saving && setCreating(false)}
        eyebrow="New showcase"
        title="What are you presenting?"
        subtitle="You choose the records next."
        footer={
          <>
            <button type="button" onClick={() => setCreating(false)} disabled={saving} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={create} disabled={saving} className="btn btn-primary">
              {saving ? <span className="spin h-4 w-4" /> : <IconPlus />}
              Create
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="field">
            <label htmlFor="showcase-title">
              Title<span className="req">*</span>
            </label>
            <input
              id="showcase-title"
              type="text"
              value={form.title}
              maxLength={200}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Annual Research Highlights 2025–26"
              className="input"
            />
          </div>
          <div className="field">
            <label htmlFor="showcase-description">
              Narrative<span className="ml-2 font-normal text-muted">(Optional)</span>
            </label>
            <textarea
              id="showcase-description"
              rows={4}
              value={form.description}
              maxLength={5000}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="A few lines for the Dean: what this collection shows and why it matters."
              className="input"
            />
          </div>
          {formError && <p className="field-error">{formError}</p>}
        </div>
      </Modal>
    </TeacherShell>
  );
}
