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
    (event.status === "approved" && (event.owner_id || event.submitted_by_role === "event_manager")) ||
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
  const [customizing, setCustomizing] = useState(null);
  const [generationError, setGenerationError] = useState("");

  const downloadSingle = useCallback(async (event) => {
    if (!event) return;
    const check = canDownloadEventReport(event);
    if (!check.canDownload) {
      setDownloadError(check.reason);
      return;
    }

    setDownloadNotice("");
    setDownloadError("");
    setCustomizing({ events: [event], bulk: false });
    setGenerationError("");
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

    setDownloadNotice("");
    setDownloadError("");
    setCustomizing({ events: eligibleEvents, bulk: true });
    setGenerationError("");
  }, []);

  const generateReport = async (options) => {
    if (!customizing) return;
    const { events, bulk } = customizing;
    const ids = events.map((item) => item.id);
    try {
      setDownloadError("");
      setGenerationError("");
      setIsBulkDownloading(bulk);
      setDownloadingRowId(bulk ? null : ids[0]);
      setDownloadProgress(`Preparing ${ids.length} report${ids.length === 1 ? "" : "s"}...`);
      const outcome = ids.length === 1
        ? await downloadDeanEventReport(ids[0], events[0].event_name, options)
        : await downloadDeanEventsReport(ids, options);
      setDownloadNotice(reportNotice(outcome, ids.length === 1 ? `Report for "${events[0].event_name}"` : `Consolidated report (${ids.length} events)`));
      setCustomizing(null);
    } catch (err) {
      console.error("Bulk download reports error:", err);
      setDownloadError(err?.message || "Failed to generate report.");
      setGenerationError(err?.message || "Failed to generate report.");
    } finally {
      setIsBulkDownloading(false);
      setDownloadingRowId(null);
      setDownloadProgress("");
    }
  };

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
    reportModalProps: {
      open: Boolean(customizing),
      onClose: () => { if (!downloadingRowId && !isBulkDownloading) setCustomizing(null); },
      onGenerate: generateReport,
      generating: Boolean(downloadingRowId || isBulkDownloading),
      eventIds: customizing?.events.map((item) => item.id) || [],
      eventName: customizing?.events.length === 1 ? customizing.events[0].event_name : "",
      isConsolidated: Boolean(customizing?.bulk),
      eventCount: customizing?.events.length || 1,
      apiBase: "/dean",
      error: generationError,
    },
  };
}
