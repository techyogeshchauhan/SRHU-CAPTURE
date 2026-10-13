import { useRef, useState } from "react";

import { formatBytes } from "../../utils/research";
import { IconExternalLink, IconFileText, IconImagePlus, IconTrash, IconUploadCloud } from "../teacher/icons";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

/**
 * The files that back a record: certificates, the paper, a grant letter.
 *
 * Read-only for the Dean. For authors, `onUpload(file, tag, onProgress)` and
 * `onRemove(entry)` add the upload row and the remove buttons.
 */
export default function EvidencePanel({
  evidence = [],
  tags = [],
  limits,
  onUpload,
  onRemove,
  busy = false,
  required = false,
}) {
  const [chosenTag, setTag] = useState("");
  // The tags arrive with the category definitions, after the first render.
  const tag = tags.includes(chosenTag) ? chosenTag : tags[0] || "Other";
  const [progress, setProgress] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState("");
  const inputRef = useRef(null);

  const maxFiles = limits?.max_evidence_files ?? 5;
  const maxBytes = limits?.max_evidence_total_bytes ?? 10 * 1024 * 1024;
  const used = evidence.reduce((sum, entry) => sum + (entry.file_size || 0), 0);
  const full = evidence.length >= maxFiles || used >= maxBytes;

  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onUpload) return;
    setError("");
    if (file.size > maxBytes - used) {
      setError(`That file is ${formatBytes(file.size)}; only ${formatBytes(Math.max(0, maxBytes - used))} of this record's evidence budget is left.`);
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      await onUpload(file, tag, setProgress);
    } catch (err) {
      setError(err?.message || "The file could not be attached.");
    } finally {
      setUploading(false);
      setProgress(null);
    }
  };

  const remove = async (entry) => {
    if (!onRemove) return;
    setError("");
    setRemoving(entry.id);
    try {
      await onRemove(entry);
    } catch (err) {
      setError(err?.message || "The file could not be removed.");
    } finally {
      setRemoving("");
    }
  };

  return (
    <div>
      {evidence.length === 0 ? (
        <p className="prose-muted rounded-xl border border-dashed border-line/20 p-5 text-center text-sm">
          No evidence attached yet.
          {onUpload &&
            (required
              ? " Add the paper, certificate or letter that proves this record — it is needed before submitting."
              : " Adding the paper, certificate or letter is optional.")}
        </p>
      ) : (
        <ul className="grid list-none gap-2.5 p-0 sm:grid-cols-2">
          {evidence.map((entry) => {
            const image = String(entry.content_type || "").startsWith("image/");
            return (
              <li key={entry.id} className="flex items-center gap-3 rounded-xl border hairline bg-raised/40 p-3">
                <span className="icon-tile h-10 w-10 shrink-0 rounded-lg">
                  {image ? <IconImagePlus className="h-4 w-4" /> : <IconFileText className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-accent">{entry.tag}</p>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-sm font-medium text-ink hover:text-accent"
                    title={entry.file_name}
                  >
                    {entry.file_name}
                  </a>
                  <p className="prose-muted text-xs">{formatBytes(entry.file_size)}</p>
                </div>
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="icon-btn icon-btn-sm shrink-0"
                  aria-label={`Open ${entry.file_name}`}
                >
                  <IconExternalLink />
                </a>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => remove(entry)}
                    disabled={busy || removing === entry.id}
                    className="icon-btn icon-btn-sm shrink-0 text-err"
                    aria-label={`Remove ${entry.file_name}`}
                  >
                    {removing === entry.id ? <span className="spin h-4 w-4" /> : <IconTrash />}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {onUpload && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t hairline pt-4">
          <div className="field min-w-0 flex-1 basis-48">
            <label htmlFor="evidence-tag">Kind of evidence</label>
            <select
              id="evidence-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              disabled={uploading || busy || full}
              className="input"
            >
              {tags.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <input ref={inputRef} type="file" accept={ACCEPT} onChange={pick} className="sr-only" tabIndex={-1} />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || busy || full}
            className="btn btn-primary btn-sm"
          >
            {uploading ? <span className="spin h-4 w-4" /> : <IconUploadCloud />}
            {uploading ? "Uploading…" : "Attach file"}
          </button>
          <p className="prose-muted basis-full text-xs">
            PDF, JPG, PNG or WEBP · {evidence.length} of {maxFiles} files · {formatBytes(used)} of{" "}
            {formatBytes(maxBytes)} used
            {full && " · remove a file to add another"}
          </p>
          {uploading && progress != null && (
            <div className="progress-track basis-full" aria-hidden="true">
              <span className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="field-error mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
