import { useRef, useState } from "react";

import { formatBytes } from "../../utils/research";
import { IconCheck, IconFileText, IconImagePlus, IconTrash, IconUploadCloud, IconX } from "../teacher/icons";

const EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

let nextKey = 0;

/**
 * Evidence chosen inside the research form, uploaded when the form is saved.
 *
 * One compact box: drop files on it or pick several at once; each becomes a
 * one-line row with its kind (a select) and a remove button. Files already
 * on the record (when editing) are listed above the new ones and can be
 * removed straight away through `onRemoveExisting`.
 *
 * `queued` is [{ key, file, tag, status, error }], owned by the form so it
 * can upload them after saving; `setQueued` updates it.
 */
export default function EvidenceQueue({
  tags = [],
  limits,
  required = false,
  existing = [],
  onRemoveExisting,
  queued,
  setQueued,
  busy = false,
  compact = false,
}) {
  const [problem, setProblem] = useState("");
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState("");
  const inputRef = useRef(null);

  const maxFiles = limits?.max_evidence_files ?? 5;
  const maxBytes = limits?.max_evidence_total_bytes ?? 10 * 1024 * 1024;
  const used =
    existing.reduce((sum, e) => sum + (e.file_size || 0), 0) + queued.reduce((sum, q) => sum + q.file.size, 0);
  const count = existing.length + queued.length;
  const defaultTag = tags[0] || "Other";

  const add = (files) => {
    setProblem("");
    const problems = [];
    let room = maxFiles - count;
    let budget = maxBytes - used;
    const accepted = [];
    for (const file of files) {
      const ext = `.${(file.name.split(".").pop() || "").toLowerCase()}`;
      if (!EXTENSIONS.includes(ext)) {
        problems.push(`${file.name}: only PDF, JPG, PNG or WebP files can be attached.`);
      } else if (room <= 0) {
        problems.push(`${file.name}: a record can carry at most ${maxFiles} files.`);
      } else if (file.size > budget) {
        problems.push(`${file.name} (${formatBytes(file.size)}) would take the evidence past ${formatBytes(maxBytes)}.`);
      } else {
        accepted.push({ key: `q${nextKey++}`, file, tag: defaultTag, status: "waiting", error: "" });
        room -= 1;
        budget -= file.size;
      }
    }
    if (accepted.length) setQueued((prev) => [...prev, ...accepted]);
    if (problems.length) setProblem(problems.join(" "));
  };

  const removeExisting = async (entry) => {
    setRemoving(entry.id);
    setProblem("");
    try {
      await onRemoveExisting(entry);
    } catch (err) {
      setProblem(err?.message || "The file could not be removed.");
    } finally {
      setRemoving("");
    }
  };

  const fileIcon = (type) =>
    String(type || "").startsWith("image/") ? <IconImagePlus className="h-4 w-4" /> : <IconFileText className="h-4 w-4" />;

  return (
    <div>
      {(existing.length > 0 || queued.length > 0) && (
        <ul className="mb-2.5 list-none divide-y divide-line/10 overflow-hidden rounded-xl border hairline p-0">
          {existing.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2.5 px-3 py-2">
              <span className="text-muted">{fileIcon(entry.content_type)}</span>
              <a href={entry.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm text-ink hover:text-accent" title={entry.file_name}>
                {entry.file_name}
              </a>
              <span className="shrink-0 text-xs text-muted">{entry.tag} · {formatBytes(entry.file_size)}</span>
              {onRemoveExisting && (
                <button
                  type="button"
                  onClick={() => removeExisting(entry)}
                  disabled={busy || removing === entry.id}
                  className="icon-btn icon-btn-sm shrink-0 text-err"
                  aria-label={`Remove ${entry.file_name}`}
                >
                  {removing === entry.id ? <span className="spin h-4 w-4" /> : <IconTrash />}
                </button>
              )}
            </li>
          ))}
          {queued.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center gap-2.5 px-3 py-2 sm:flex-nowrap">
              <span className="text-muted">{fileIcon(item.file.type)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.file.name}>
                {item.file.name}
                <span className="ml-2 text-xs text-muted">{formatBytes(item.file.size)}</span>
              </span>
              <select
                value={item.tag}
                onChange={(e) => setQueued((prev) => prev.map((q) => (q.key === item.key ? { ...q, tag: e.target.value } : q)))}
                disabled={busy}
                aria-label={`Kind of evidence for ${item.file.name}`}
                className="input min-h-0 w-auto shrink-0 py-1.5 pr-8 text-xs"
              >
                {tags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
              {item.status === "uploading" ? (
                <span className="spin h-4 w-4 shrink-0 text-accent" aria-label="Uploading" />
              ) : item.status === "done" ? (
                <IconCheck className="h-4 w-4 shrink-0 text-ok" aria-label="Uploaded" />
              ) : (
                <button
                  type="button"
                  onClick={() => setQueued((prev) => prev.filter((q) => q.key !== item.key))}
                  disabled={busy}
                  className="icon-btn icon-btn-sm shrink-0"
                  aria-label={`Remove ${item.file.name}`}
                >
                  <IconX />
                </button>
              )}
              {item.error && <span className="basis-full text-xs text-err">{item.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        data-testid="evidence-input"
        onChange={(e) => {
          add(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={compact ? undefined : (e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={compact ? undefined : () => setDragging(false)}
        onDrop={compact ? undefined : (e) => {
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files || []));
        }}
        disabled={busy || count >= maxFiles}
        className={compact
          ? "btn btn-ghost btn-xs shrink-0"
          : `flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm transition ${
              dragging ? "border-accent bg-accent/10 text-accent" : "border-line/25 text-muted hover:border-accent/50 hover:text-accent"
            } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <IconUploadCloud className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {count >= maxFiles ? "File limit reached" : compact ? "Upload Research Evidence" : "Drop files here or choose files"}
      </button>
      <p className="field-hint mt-1.5">
        {required ? "Required: attach at least one file before recording. " : "Optional. "}
        PDF, JPG, PNG or WEBP · {count} of {maxFiles} files · {formatBytes(used)} of {formatBytes(maxBytes)}
      </p>
      {problem && (
        <p className="field-error mt-1" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
