import { useState } from "react";

import { IconDownload } from "../teacher/icons";

/**
 * "Download Excel": runs `onDownload` (which starts the download) with a
 * spinner, and reports a failure through `onError` rather than throwing.
 */
export default function DownloadExcelButton({
  onDownload,
  onError,
  label = "Download Excel",
  className = "btn btn-ghost",
  disabled = false,
  title = "Download what is listed here as an Excel file",
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onDownload();
    } catch (err) {
      onError?.(err?.message || "The Excel file could not be generated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" onClick={run} disabled={busy || disabled} className={className} title={title}>
      {busy ? <span className="spin h-4 w-4" /> : <IconDownload />}
      {label}
    </button>
  );
}
