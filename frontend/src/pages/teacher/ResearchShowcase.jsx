import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import Modal from "../../components/teacher/Modal";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronDown,
  IconDownload,
  IconEye,
  IconPlus,
  IconSave,
  IconSearch,
  IconSparkle,
  IconTrash,
  IconX,
} from "../../components/teacher/icons";
import CategoryIcon from "../../components/research/CategoryIcon";
import ShowcaseView from "../../components/research/ShowcaseView";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { isAbortError } from "../../services/api";
import {
  deleteShowcase,
  downloadShowcasePdf,
  getShowcase,
  listResearch,
  sendShowcase,
  updateShowcase,
} from "../../services/research";
import { recordFacts } from "../../utils/research";

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Build a showcase: its title and narrative, which verified records it holds
 * and in what order, which are highlights -- then preview it as the Dean will
 * see it, download it as a PDF, and send it.
 */
export default function ResearchShowcase() {
  const { showcaseId } = useParams();
  const navigate = useNavigate();
  const panel = usePanel();
  const manager = panel.role === "event_manager";
  const { profile, logout } = useShellProfile();
  const { categories, byKey } = useResearchCategories();

  const [showcase, setShowcase] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState({ title: "", description: "" });
  const [mode, setMode] = useState("edit");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState("");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);

  const accept = useCallback((body) => {
    setShowcase(body.showcase);
    setDraft({ title: body.showcase.title || "", description: body.showcase.description || "" });
  }, []);

  useEffect(() => {
    getShowcase(showcaseId)
      .then(accept)
      .catch((err) => setLoadError(err?.message || "This showcase could not be loaded."));
  }, [showcaseId, accept]);

  // Verified records to choose from, as the author types.
  useEffect(() => {
    searchRef.current?.abort();
    const controller = new AbortController();
    searchRef.current = controller;
    const timer = setTimeout(() => {
      setSearching(true);
      listResearch({ status: "verified", q: search.trim(), category, limit: 50 }, { signal: controller.signal })
        .then((body) => !controller.signal.aborted && setCandidates(body.records || []))
        .catch((err) => {
          if (!isAbortError(err)) setError(err?.message || "Records could not be searched.");
        })
        .finally(() => !controller.signal.aborted && setSearching(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, category]);

  const recordIds = useMemo(() => (showcase?.records || []).map((r) => r.id), [showcase]);
  const highlights = useMemo(() => new Set(showcase?.highlight_ids || []), [showcase]);

  const save = async (patch, message = "") => {
    setError("");
    setBusy("save");
    try {
      accept(await updateShowcase(showcaseId, patch));
      if (message) setNotice(message);
    } catch (err) {
      setError(err?.message || "The showcase could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const move = (index, step) => {
    const next = [...recordIds];
    const [item] = next.splice(index, 1);
    next.splice(index + step, 0, item);
    save({ record_ids: next });
  };

  const toggleHighlight = (id) => {
    const next = highlights.has(id) ? [...highlights].filter((x) => x !== id) : [...highlights, id];
    save({ highlight_ids: next });
  };

  const send = async () => {
    setBusy("send");
    setError("");
    try {
      const body = await sendShowcase(showcaseId);
      accept(body);
      setNotice(body.message);
    } catch (err) {
      setError(err?.message || "The showcase could not be sent.");
    } finally {
      setBusy("");
      setConfirm("");
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await deleteShowcase(showcaseId);
      navigate(`${panel.base}/research/showcases`, { replace: true });
    } catch (err) {
      setError(err?.message || "The showcase could not be deleted.");
      setBusy("");
      setConfirm("");
    }
  };

  const pdf = async () => {
    setBusy("pdf");
    setError("");
    try {
      await downloadShowcasePdf(showcaseId);
    } catch (err) {
      setError(err?.message || "The PDF could not be generated.");
    } finally {
      setBusy("");
    }
  };

  const dirty = showcase && (draft.title !== (showcase.title || "") || draft.description !== (showcase.description || ""));
  const withdrawn = (showcase?.records || []).filter((r) => r.verification_status !== "verified").length;
  const verifiedCount = (showcase?.records || []).length - withdrawn;

  return (
    <TeacherShell active="research" profile={profile} onLogout={logout}>
      <div className={`mx-auto w-full max-w-wrap px-5 sm:px-8 ${manager ? "py-6" : "py-8"}`}>
        <div className={`flex flex-wrap items-center justify-between gap-3 ${manager ? "mb-4" : "mb-5"}`}>
          <Link to={`${panel.base}/research/showcases`} className={`btn btn-ghost ${manager ? "btn-xs" : "btn-sm"}`}>
            <IconArrowLeft />
            All showcases
          </Link>
          {showcase && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setConfirm("delete")} className="btn btn-ghost btn-xs text-err hover:border-err/50">
                <IconTrash />
                Delete
              </button>
              <button type="button" onClick={pdf} disabled={Boolean(busy) || verifiedCount === 0} className="btn btn-ghost btn-xs">
                {busy === "pdf" ? <span className="spin h-3 w-3" /> : <IconDownload />}
                PDF
              </button>
              <button
                type="button"
                onClick={() => setConfirm("send")}
                disabled={Boolean(busy) || verifiedCount === 0 || dirty}
                className="btn btn-primary btn-xs"
                title={dirty ? "Save your changes first" : undefined}
              >
                {showcase.status === "sent" ? "Send again" : "Send to the Dean"}
              </button>
            </div>
          )}
        </div>

        {loadError && (
          <div className="flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm text-ink">{loadError}</p>
          </div>
        )}
        {!showcase && !loadError && (
          <div className="flex h-48 items-center justify-center">
            <span className="spin h-8 w-8 text-accent" />
          </div>
        )}

        {showcase && (
          <>
            {notice && (
              <div className="toast toast-ok mb-5" role="status">
                <span className="dot mt-1" style={{ "--track": trackOf("approved") }} />
                <p className="min-w-0 flex-1 text-sm font-medium text-ink">{notice}</p>
                <button type="button" onClick={() => setNotice("")} className="icon-btn icon-btn-sm" aria-label="Dismiss">
                  <IconX />
                </button>
              </div>
            )}
            {error && (
              <div className="toast toast-err mb-5" role="alert">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
                <p className="min-w-0 flex-1 text-sm font-medium text-ink">{error}</p>
              </div>
            )}

            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {showcase.status === "sent"
                  ? `Sent to the Dean ${when(showcase.sent_at)}${
                      (showcase.viewed_by || []).length ? ` · seen by ${showcase.viewed_by.map((v) => v.name).join(", ")}` : " · not opened yet"
                    }`
                  : "Draft — the Dean sees it once you send it."}
                {manager && ` · by ${showcase.owner_name}`}
              </p>
              <div className="flex gap-1.5" role="tablist" aria-label="View">
                <button type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")} className="tab">
                  Build
                </button>
                <button type="button" role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")} className="tab">
                  <IconEye className="h-4 w-4" />
                  Preview as the Dean
                </button>
              </div>
            </div>

            {mode === "preview" ? (
              <ShowcaseView
                showcase={showcase}
                categories={categories}
                recordLink={(record) => `${panel.base}/research/${record.id}`}
                showStatus
              />
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
                <div className="min-w-0 space-y-6">
                  <section className="glass p-5 sm:p-6">
                    <div className="field">
                      <label htmlFor="sc-title">
                        Title<span className="req">*</span>
                      </label>
                      <input
                        id="sc-title"
                        type="text"
                        value={draft.title}
                        maxLength={200}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        className="input"
                      />
                    </div>
                    <div className="field mt-4">
                      <label htmlFor="sc-description">Narrative</label>
                      <textarea
                        id="sc-description"
                        rows={5}
                        value={draft.description}
                        maxLength={5000}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                        placeholder="What this collection shows. Blank lines start new paragraphs."
                        className="input"
                      />
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button
                        type="button"
                        onClick={() => save({ title: draft.title, description: draft.description }, "Saved.")}
                        disabled={!dirty || Boolean(busy)}
                        className="btn btn-primary btn-sm"
                      >
                        {busy === "save" ? <span className="spin h-4 w-4" /> : <IconSave />}
                        Save
                      </button>
                    </div>
                  </section>

                  <section className="glass overflow-hidden">
                    <div className="border-b hairline px-5 py-4 sm:px-6">
                      <h2 className="h3 text-base text-ink">In this showcase ({recordIds.length})</h2>
                      <p className="prose-muted mt-0.5 text-xs">
                        Shown in this order. Star the few that should lead as highlights.
                      </p>
                    </div>
                    {recordIds.length === 0 ? (
                      <p className="prose-muted px-6 py-10 text-center text-sm">Add verified records from the list on the right.</p>
                    ) : (
                      <ol className="list-none p-0">
                        {showcase.records.map((record, index) => {
                          const starred = highlights.has(record.id);
                          const lapsed = record.verification_status !== "verified";
                          return (
                            <li key={record.id} className="flex items-center gap-3 border-b hairline px-4 py-3 last:border-b-0 sm:px-5">
                              <span className="num w-6 shrink-0 text-center text-xs font-semibold text-muted">{index + 1}</span>
                              <span className="icon-tile hidden h-9 w-9 shrink-0 rounded-lg sm:flex">
                                <CategoryIcon category={record.category} className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold text-ink">{record.title}</span>
                                <span className="block truncate text-xs text-muted">
                                  {record.faculty?.name} · {recordFacts(record) || byKey[record.category]?.short}
                                </span>
                                {lapsed && (
                                  <span className="mt-0.5 block text-xs font-medium text-err">
                                    No longer verified — the Dean will not see it.
                                  </span>
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleHighlight(record.id)}
                                disabled={Boolean(busy)}
                                aria-pressed={starred}
                                className="icon-btn icon-btn-sm shrink-0"
                                style={starred ? { color: "var(--series-4)" } : undefined}
                                aria-label={starred ? "Remove from highlights" : "Make a highlight"}
                                title={starred ? "Highlight" : "Make a highlight"}
                              >
                                <IconSparkle />
                              </button>
                              <button
                                type="button"
                                onClick={() => move(index, -1)}
                                disabled={index === 0 || Boolean(busy)}
                                className="icon-btn icon-btn-sm shrink-0 disabled:opacity-30"
                                aria-label="Move up"
                              >
                                <IconChevronDown className="rotate-180" />
                              </button>
                              <button
                                type="button"
                                onClick={() => move(index, 1)}
                                disabled={index === recordIds.length - 1 || Boolean(busy)}
                                className="icon-btn icon-btn-sm shrink-0 disabled:opacity-30"
                                aria-label="Move down"
                              >
                                <IconChevronDown />
                              </button>
                              <button
                                type="button"
                                onClick={() => save({ record_ids: recordIds.filter((id) => id !== record.id) })}
                                disabled={Boolean(busy)}
                                className="icon-btn icon-btn-sm shrink-0 text-err"
                                aria-label="Remove from the showcase"
                              >
                                <IconX />
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </section>
                </div>

                <aside className="min-w-0">
                  <section className="glass overflow-hidden lg:sticky lg:top-24">
                    <div className="space-y-2.5 border-b hairline p-4">
                      <h2 className="h3 text-base text-ink">Add verified records</h2>
                      <div className="relative">
                        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
                          <IconSearch className="h-4 w-4" />
                        </span>
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder={manager ? "Titles or teachers…" : "Search your titles…"}
                          aria-label="Search verified records"
                          className="input pl-10"
                        />
                      </div>
                      <select value={category} onChange={(e) => setCategory(e.target.value)} className="input" aria-label="Category">
                        <option value="">All categories</option>
                        {categories.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <ul className={`max-h-[32rem] list-none overflow-y-auto p-0 transition-opacity ${searching ? "opacity-60" : ""}`}>
                      {candidates.length === 0 && !searching && (
                        <li className="prose-muted px-4 py-8 text-center text-sm">
                          No verified records match. Only verified records can be presented.
                        </li>
                      )}
                      {candidates.map((record) => {
                        const included = recordIds.includes(record.id);
                        return (
                          <li key={record.id} className="flex items-center gap-3 border-b hairline px-4 py-2.5 last:border-b-0">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-ink">{record.title}</span>
                              <span className="block truncate text-xs text-muted">
                                {byKey[record.category]?.short} · {record.faculty?.name}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => save({ record_ids: [...recordIds, record.id] })}
                              disabled={included || Boolean(busy)}
                              className="btn btn-ghost btn-xs shrink-0"
                            >
                              {included ? "Added" : (
                                <>
                                  <IconPlus />
                                  Add
                                </>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                </aside>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={confirm === "send"}
        onClose={() => busy !== "send" && setConfirm("")}
        eyebrow="Send to the Dean"
        title={showcase?.status === "sent" ? "Send the updated showcase?" : "Send this showcase to the Dean?"}
        subtitle="Every Dean is notified. They see it as in the preview, and can download it as a PDF."
        footer={
          <>
            <button type="button" onClick={() => setConfirm("")} disabled={busy === "send"} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={send} disabled={busy === "send"} className="btn btn-primary">
              {busy === "send" ? <span className="spin h-4 w-4" /> : null}
              Send
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">
          “{showcase?.title}” · {verifiedCount} verified {verifiedCount === 1 ? "record" : "records"}
          {withdrawn ? ` (${withdrawn} no longer verified will be left out)` : ""}.
        </p>
      </Modal>

      <Modal
        open={confirm === "delete"}
        onClose={() => busy !== "delete" && setConfirm("")}
        eyebrow="Delete showcase"
        title="Delete this showcase?"
        subtitle="The records themselves are not touched."
        footer={
          <>
            <button type="button" onClick={() => setConfirm("")} disabled={busy === "delete"} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={remove} disabled={busy === "delete"} className="btn btn-danger">
              {busy === "delete" ? <span className="spin h-4 w-4" /> : <IconTrash />}
              Delete
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">“{showcase?.title}”</p>
      </Modal>
    </TeacherShell>
  );
}
