import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconEye,
  IconFilm,
  IconRotateCcw,
  IconTrash,
  IconUploadCloud,
  IconX,
} from "./icons";
import { formatFileSize } from "../../utils/files";

const getFileExtension = (fileName) => {
  const parts = String(fileName || "").split(".");
  if (parts.length <= 1) return "FILE";
  return parts.pop().toUpperCase().slice(0, 4);
};

/**
 * One upload step of the create-event wizard: a drop zone, the files already
 * stored on the server, and any upload still in flight.
 *
 * Purely presentational. The parent owns the files and does the uploading, so
 * photos, videos and documents all share this one component and can never
 * drift apart in look or behaviour.
 */
export default function UploadPanel({
  kind, // "image" | "video" | "document"
  items = [], // already uploaded, from the server
  uploads = [], // in flight: { key, name, size, progress, error }
  accept,
  max = null, // maximum number of files, or null for no limit
  // Combined byte budget for this kind, and how much of it is already spent.
  // Videos and documents are limited this way rather than by count (PRD 9/11).
  totalLimitBytes = null,
  usedBytes = 0,
  // What another panel already spends of the same limits: Notice and Report
  // documents are two panels over one count cap and one byte budget, so each
  // must know about the other's files or both could fill the whole budget.
  sharedCount = 0,
  sharedBytes = 0,
  maxSizeLabel,
  hint,
  emptyLabel,
  disabled = false,
  required = false,
  onPick,
  onRemove,
  onRetry,
  onDismiss,
  // Called when a saved file's (signed, expiring) link fails to load.
  onLoadError,
  // Photos only, for a panel that generates its own reports: a tick on each
  // saved photo choosing whether it appears in the report.
  // { ids: chosen photo ids in report order, max (optional cap), busy, onToggle(id) }
  reportSelection = null,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const [selectedForPreview, setSelectedForPreview] = useState([]);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewActiveIndex, setPreviewActiveIndex] = useState(0);
  const [previewItems, setPreviewItems] = useState([]);

  useEffect(() => {
    if (kind === "image") {
      setSelectedForPreview((prev) => prev.filter((id) => items.some((item) => item.id === id)));
    }
  }, [items, kind]);

  useEffect(() => {
    if (!previewModalOpen || previewItems.length <= 1) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "ArrowLeft") {
        setPreviewActiveIndex((prev) => (prev - 1 + previewItems.length) % previewItems.length);
      } else if (e.key === "ArrowRight") {
        setPreviewActiveIndex((prev) => (prev + 1) % previewItems.length);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewModalOpen, previewItems.length]);

  const handleSinglePreview = (item) => {
    setPreviewItems([item]);
    setPreviewActiveIndex(0);
    setPreviewModalOpen(true);
  };

  const handlePreviewSelected = () => {
    const selected = items.filter((item) => selectedForPreview.includes(item.id));
    if (selected.length === 0) return;
    setPreviewItems(selected);
    setPreviewActiveIndex(0);
    setPreviewModalOpen(true);
  };

  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedForPreview(items.map((item) => item.id));
    } else {
      setSelectedForPreview([]);
    }
  };

  const handleToggleItemSelect = (id) => {
    setSelectedForPreview((prev) =>
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    );
  };

  const active = items.length + uploads.filter((u) => !u.error).length;
  const shared = sharedCount > 0 || sharedBytes > 0;
  const totalActive = active + sharedCount;
  const totalUsedBytes = usedBytes + sharedBytes;
  const countFull = max != null && totalActive >= max;
  const budgetFull = totalLimitBytes != null && totalUsedBytes >= totalLimitBytes;
  const full = countFull || budgetFull;
  const locked = disabled || full;

  const budgetPct =
    totalLimitBytes == null
      ? 0
      : Math.min(100, Math.round((totalUsedBytes / totalLimitBytes) * 100));
  // Amber as the budget runs low, red once it is gone -- the same warning
  // language the rest of the app uses for "you are about to be blocked".
  const budgetTone =
    budgetPct >= 100 ? "var(--c-err)" : budgetPct >= 80 ? "var(--c-ember)" : null;

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length > 0) onPick?.(files);
  };

  return (
    <div>
      {/* ------------------------------------------------------- drop zone */}
      <div
        onDragOver={(e) => {
          if (locked) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (locked) return;
          handleFiles(e.dataTransfer?.files);
        }}
        className={`dropzone ${dragging ? "is-dragging" : ""} ${locked ? "is-locked" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
          className="hidden"
          disabled={locked}
        />

        <span className="icon-tile">
          {kind === "video" ? <IconFilm /> : <IconUploadCloud />}
        </span>

        <p className="mt-3 font-display text-sm font-semibold text-ink">
          {countFull
            ? `You have added the maximum of ${max}`
            : budgetFull
              ? `You have used the full ${formatFileSize(totalLimitBytes)} allowed`
              : emptyLabel}
        </p>
        <p className="prose-muted mt-1 text-xs">{hint}</p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={locked}
          className="btn btn-ghost btn-sm mt-4"
        >
          Browse files
        </button>

        <p className="prose-muted mt-2.5 text-[11px]">
          {maxSizeLabel}
          {max != null && ` · ${totalActive} of ${max} added${shared ? " in total" : ""}`}
        </p>
      </div>

      {/* --------------------------------------------------- budget meter */}
      {totalLimitBytes != null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="prose-muted text-[11px]">
              {shared
                ? `${formatFileSize(usedBytes)} here · ${formatFileSize(totalUsedBytes)} of ${formatFileSize(totalLimitBytes)} used in total`
                : `${formatFileSize(usedBytes)} of ${formatFileSize(totalLimitBytes)} used`}
            </span>
            {budgetFull && (
              <span className="text-[11px] font-semibold text-err">Limit reached</span>
            )}
          </div>
          {/* Reuses the upload bar's own track so the two read as one system. */}
          <div className="progress-track mt-1">
            <div
              className="progress-bar"
              style={{
                width: `${Math.max(2, budgetPct)}%`,
                ...(budgetTone ? { background: budgetTone } : null),
              }}
            />
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- in flight */}
      {uploads.length > 0 && (
        <ul className="mt-4 space-y-2.5">
          {uploads.map((upload) => (
            <li
              key={upload.key}
              className={`rounded-xl border px-4 py-3 ${
                upload.error ? "border-err/35 bg-err/5" : "hairline bg-raised/40"
              }`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{upload.name}</p>
                  <p className="prose-muted mt-0.5 text-xs">
                    {upload.error ? (
                      <span className="text-err">{upload.error}</span>
                    ) : upload.progress == null ? (
                      "Uploading…"
                    ) : (
                      `Uploading… ${Math.round(upload.progress * 100)}%`
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {upload.error ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onRetry?.(upload)}
                        className="btn btn-ghost btn-xs"
                      >
                        <IconRotateCcw />
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => onDismiss?.(upload)}
                        className="icon-btn icon-btn-sm"
                        aria-label={`Dismiss ${upload.name}`}
                      >
                        <IconX />
                      </button>
                    </>
                  ) : (
                    <span className="spin h-4 w-4 text-accent" />
                  )}
                </div>
              </div>

              {!upload.error && (
                <div className="progress-track mt-2.5">
                  <span
                    className={`progress-bar ${upload.progress == null ? "is-indeterminate" : ""}`}
                    style={
                      upload.progress == null
                        ? undefined
                        : { width: `${Math.max(3, upload.progress * 100)}%` }
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ------------------------------------------------------- uploaded */}
      {items.length > 0 &&
        (kind === "document" ? (
          <ul className="mt-4 space-y-2.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-4 rounded-xl border hairline bg-raised/40 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="icon-tile h-10 w-10 rounded-xl font-display text-[11px] font-bold">
                    {getFileExtension(item.file_name)}
                  </span>
                  <div className="min-w-0">
                    <a
                      href={item.file_url}
                      target="_blank"
                      rel="noreferrer"
                      className="link block truncate text-sm font-medium"
                    >
                      {item.file_name}
                    </a>
                    <p className="prose-muted mt-0.5 text-xs">
                      {formatFileSize(item.file_size)} · Saved
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onRemove?.(item)}
                  disabled={disabled || item.removing}
                  className="btn btn-ghost btn-xs shrink-0 text-err"
                >
                  {item.removing ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : kind === "image" ? (
          // Photos as one compact list: the preview selection and the report
          // choice read down a single column instead of across scattered cards.
          <div className="mt-4 overflow-hidden rounded-xl border hairline">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline bg-raised/40 px-3 py-2">
              <label className="flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-ink">
                <input
                  type="checkbox"
                  checked={selectedForPreview.length === items.length}
                  onChange={handleSelectAll}
                  aria-label="Select all photos for preview"
                  className="h-3.5 w-3.5 rounded border-line text-accent focus:ring-accent"
                />
                <span>
                  Select all ({items.length})
                  {selectedForPreview.length > 0 && (
                    <span className="ml-1.5 font-normal text-muted">· {selectedForPreview.length} selected</span>
                  )}
                </span>
              </label>

              <div className="flex items-center gap-3">
                {reportSelection && (
                  <>
                    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={
                          items.length > 0 && items.every((item) => reportSelection.ids.includes(item.id))
                        }
                        disabled={disabled || reportSelection.busy}
                        onChange={(event) =>
                          event.target.checked
                            ? reportSelection.onSelectAll?.()
                            : reportSelection.onClearAll?.()
                        }
                        aria-label="Select all photos for the report"
                        className="h-3.5 w-3.5 rounded border-line text-accent focus:ring-accent"
                      />
                      Select all for report
                    </label>
                    <span className="text-xs text-muted">
                      <span className="font-semibold text-accent">{reportSelection.ids.length}</span> in report
                    </span>
                  </>
                )}
                <button
                  type="button"
                  onClick={handlePreviewSelected}
                  disabled={selectedForPreview.length === 0}
                  className="btn btn-ghost btn-xs"
                >
                  <IconEye className="h-3.5 w-3.5" />
                  Preview{selectedForPreview.length > 0 ? ` (${selectedForPreview.length})` : ""}
                </button>
              </div>
            </div>

            <ul className="divide-y divide-line/50">
              {items.map((item) => {
                const reportPosition = reportSelection ? reportSelection.ids.indexOf(item.id) + 1 : 0;
                const inReport = reportPosition > 0;
                const isSelected = selectedForPreview.includes(item.id);
                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-2.5 px-3 py-2 sm:gap-3 ${isSelected ? "bg-accent/[0.05]" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggleItemSelect(item.id)}
                      aria-label={`Select ${item.file_name} for preview`}
                      title="Select for preview"
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-line text-accent focus:ring-accent"
                    />
                    <span className="icon-tile h-8 w-8 shrink-0 rounded-lg font-display text-[9px] font-bold uppercase">
                      {getFileExtension(item.file_name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink" title={item.file_name}>
                        {item.file_name}
                      </p>
                      <p className="prose-muted text-[11px]">{formatFileSize(item.file_size)}</p>
                    </div>

                    {reportSelection && (
                      <label
                        className={`flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
                          inReport ? "border-accent/40 bg-accent/[0.06] font-semibold text-accent" : "border-line/70 text-muted"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={inReport}
                          disabled={
                            disabled ||
                            item.removing ||
                            reportSelection.busy ||
                            (!inReport &&
                              reportSelection.max != null &&
                              reportSelection.ids.length >= reportSelection.max)
                          }
                          onChange={() => reportSelection.onToggle(item.id)}
                          aria-label={`Include ${item.file_name} in the report`}
                          className="h-3.5 w-3.5 rounded border-line text-accent focus:ring-accent"
                        />
                        {inReport ? (
                          <span>
                            <span className="hidden sm:inline">In report · </span>#{reportPosition}
                          </span>
                        ) : (
                          <span>
                            <span className="hidden sm:inline">Add to </span>report
                          </span>
                        )}
                      </label>
                    )}

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleSinglePreview(item)}
                        disabled={item.removing}
                        className="icon-btn icon-btn-sm h-8 w-8 text-accent"
                        aria-label={`Preview ${item.file_name}`}
                        title="Preview"
                      >
                        <IconEye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove?.(item)}
                        disabled={disabled || item.removing}
                        className="icon-btn icon-btn-sm h-8 w-8 text-err"
                        aria-label={`Remove ${item.file_name}`}
                        title="Remove"
                      >
                        {item.removing ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((item) => (
              <li key={item.id} className="media-tile group">
                <video
                  src={item.media_url}
                  className="media-thumb"
                  preload="metadata"
                  muted
                  playsInline
                  controls
                  onError={() => onLoadError?.()}
                />
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink" title={item.file_name}>
                      {item.file_name}
                    </p>
                    <p className="prose-muted mt-0.5 text-[11px]">
                      {formatFileSize(item.file_size)} · Saved
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove?.(item)}
                    disabled={disabled || item.removing}
                    className="icon-btn icon-btn-sm shrink-0 text-err"
                    aria-label={`Remove ${item.file_name}`}
                    title="Remove"
                  >
                    {item.removing ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {items.length === 0 && uploads.length === 0 && (
        <p className="prose-muted mt-4 flex items-center gap-2 text-xs">
          <IconAlertTriangle className={`h-4 w-4 shrink-0 ${required ? "text-amber-500" : "text-muted"}`} />
          {required
            ? "Nothing added yet. At least one file is required before this event can be submitted for approval."
            : "Nothing added yet. This step is optional — you can continue without it."}
        </p>
      )}

      {/* Lightbox Modal for Image Preview */}
      {kind === "image" && (
        <Modal
          open={previewModalOpen && previewItems.length > 0}
          onClose={() => setPreviewModalOpen(false)}
          eyebrow="Image Preview"
          title={
            previewItems.length > 1
              ? `Image Preview (${previewActiveIndex + 1} of ${previewItems.length})`
              : "Image Preview"
          }
          subtitle={previewItems[previewActiveIndex]?.file_name}
          wide
          footer={
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted font-medium">
                {formatFileSize(previewItems[previewActiveIndex]?.file_size)}
              </span>
              <div className="flex items-center gap-2">
                {previewItems.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewActiveIndex(
                          (prev) => (prev - 1 + previewItems.length) % previewItems.length
                        )
                      }
                      className="btn btn-ghost btn-xs"
                    >
                      <IconArrowLeft /> Previous
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewActiveIndex(
                          (prev) => (prev + 1) % previewItems.length
                        )
                      }
                      className="btn btn-ghost btn-xs"
                    >
                      Next <IconArrowRight />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setPreviewModalOpen(false)}
                  className="btn btn-primary btn-xs"
                >
                  Close
                </button>
              </div>
            </div>
          }
        >
          {previewItems[previewActiveIndex] && (
            <div className="flex flex-col items-center justify-center">
              <div className="relative flex max-h-[60vh] sm:max-h-[65vh] w-full items-center justify-center overflow-hidden rounded-xl bg-black/5 p-2 border hairline">
                <img
                  src={previewItems[previewActiveIndex].media_url}
                  alt={previewItems[previewActiveIndex].file_name}
                  className="max-h-[58vh] sm:max-h-[62vh] w-auto max-w-full rounded-lg object-contain shadow-sm"
                />
              </div>

              {previewItems.length > 1 && (
                <div className="mt-3.5 flex max-w-full items-center gap-2 overflow-x-auto p-1">
                  {previewItems.map((pItem, idx) => (
                    <button
                      key={pItem.id}
                      type="button"
                      onClick={() => setPreviewActiveIndex(idx)}
                      className={`h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 transition-all ${
                        idx === previewActiveIndex
                          ? "border-accent ring-2 ring-accent/30 scale-105"
                          : "border-transparent opacity-60 hover:opacity-100"
                      }`}
                      title={pItem.file_name}
                    >
                      <img
                        src={pItem.media_url}
                        alt={pItem.file_name}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
