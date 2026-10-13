import { useCallback, useState } from "react";
import {
  downloadDeanEventReport,
  downloadDeanEventsReport,
  reportNotice,
} from "../services/eventManager";

/**
 * Checks if an event can have its report downloaded:
 * A report exists once the event is marked 'completed' or 'recorded', or has a report generated.
 */
export function canDownloadEventReport(event) {
  if (!event) return { canDownload: false, reason: "No event selected" };

  const isCompletedOrRecorded =
    event.status === "completed" ||
    event.status === "recorded" ||
    Boolean(event.report_generated_at);

  if (!isCompletedOrRecorded) {
    return {
      canDownload: false,
      reason: "Report is available once the event is completed or recorded.",
    };
  }

  const hasDocuments = Array.isArray(event.documents) && event.documents.length > 0;
  const hasMedia = Array.isArray(event.media) && event.media.length > 0;
  const hasReport = Boolean(event.report_generated_at);

  if (!hasReport && !hasDocuments && !hasMedia && !event.description) {
    return {
      canDownload: false,
      reason: "No report or documents available for this event.",
    };
  }

  return { canDownload: true, reason: "" };
}

/**
 * Shared hook for downloading single or consolidated Dean event reports.
 */
export default function useEventReportDownload() {
  const [downloadingRowId, setDownloadingRowId] = useState(null);
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [downloadError, setDownloadError] = useState("");

  const downloadSingle = useCallback(async (event) => {
    if (!event) return;
    const check = canDownloadEventReport(event);
    if (!check.canDownload) {
      setDownloadError(check.reason);
      return;
    }

    try {
      setDownloadingRowId(event.id);
      setDownloadNotice("");
      setDownloadError("");
      const outcome = await downloadDeanEventReport(event.id, event.event_name);
      setDownloadNotice(reportNotice(outcome, `Report for "${event.event_name}"`));
    } catch (err) {
      console.error("Download event report error:", err);
      setDownloadError(err?.message || "Failed to download report.");
    } finally {
      setDownloadingRowId(null);
    }
  }, []);

  const downloadBulk = useCallback(async (events) => {
    if (!events || events.length === 0) return;

    const eligibleEvents = events.filter((e) => canDownloadEventReport(e).canDownload);
    if (eligibleEvents.length === 0) {
      setDownloadError(
        "None of the selected events have downloadable reports yet. Only completed or recorded events have reports.",
      );
      return;
    }

    const ids = eligibleEvents.map((e) => e.id);

    try {
      setIsBulkDownloading(true);
      setDownloadNotice("");
      setDownloadError("");

      if (ids.length === 1) {
        setDownloadProgress("Preparing 1 report...");
        const item = eligibleEvents[0];
        const outcome = await downloadDeanEventReport(item.id, item.event_name);
        setDownloadNotice(reportNotice(outcome, `Report for "${item.event_name}"`));
      } else {
        setDownloadProgress(`Preparing ${ids.length} reports...`);
        const outcome = await downloadDeanEventsReport(ids);
        setDownloadNotice(reportNotice(outcome, `Consolidated report (${ids.length} events)`));
      }
    } catch (err) {
      console.error("Bulk download reports error:", err);
      setDownloadError(err?.message || "Failed to generate report.");
    } finally {
      setIsBulkDownloading(false);
      setDownloadProgress("");
    }
  }, []);

  return {
    downloadingRowId,
    isBulkDownloading,
    downloadProgress,
    downloadNotice,
    downloadError,
    setDownloadNotice,
    setDownloadError,
    downloadSingle,
    downloadBulk,
    canDownload: canDownloadEventReport,
  };
}
