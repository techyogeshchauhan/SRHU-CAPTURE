import { useCallback, useState } from "react";
import { apiJson } from "../services/api";
import {
  downloadDeanEventReport,
  downloadDeanEventsReport,
  reportNotice,
} from "../services/eventManager";
import { availabilityFromFiles, reportModalProps } from "../utils/reportAvailability";
import { readEventFields } from "../utils/eventFields";

// The consolidated report's ceiling (POST /dean/reports).
export const MAX_REPORT_EVENTS = 50;

/**
 * Checks if an event can have its report downloaded: a report exists once
 * the event is marked 'completed' or 'recorded' -- the server's own rule for
 * generating one. What goes into it is chosen in the section picker.
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

  return { canDownload: true, reason: "" };
}

/**
 * What the picker can offer before the server answers, from the row alone:
 * the text sections are known, the files are not.
 */
function rowOnlySummary(events) {
  const flags = events.map((event) => {
    const fields = readEventFields(event);
    return availabilityFromFiles({
      description: fields.description,
      participants: fields.expectedParticipants,
      socialUrl: event.social_network_url,
    });
  });
  return {
    has_description: flags.some((item) => item.has_description),
    has_other_info: flags.some((item) => item.has_other_info),
  };
}

/**
 * Shared hook for downloading single or consolidated Dean event reports.
 *
 * Neither downloads straight away: each first opens the section picker,
 * with the sections the event(s) have nothing for disabled, and the report
 * is built from the sections the Dean leaves ticked. Callers render the
 * picker with `<ReportCustomizationModal {...reportPicker} />`.
 */
export default function useEventReportDownload() {
  const [downloadingRowId, setDownloadingRowId] = useState(null);
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [downloadError, setDownloadError] = useState("");

  // The picker: which events, and what they have to put in a report.
  const [picker, setPicker] = useState(null);
  const [generating, setGenerating] = useState(false);

  /** Ask the server what these events can fill, then open the picker. */
  const openPicker = useCallback(async (events) => {
    let summary = null;
    try {
      const data = await apiJson("/dean/reports/availability", {
        method: "POST",
        body: { event_ids: events.map((event) => event.id) },
      });
      summary = data?.combined || null;
    } catch (err) {
      // Still let the Dean choose: the text sections are known from the
      // row, and the file sections stay offered rather than guessed away.
      console.error("Report availability error:", err);
      summary = null;
    }
    const fallback = rowOnlySummary(events);
    setPicker({
      events,
      props: summary
        ? reportModalProps(summary)
        : {
            ...reportModalProps(null),
            hasDescription: fallback.has_description,
            hasOtherInfo: fallback.has_other_info,
          },
    });
  }, []);

  const downloadSingle = useCallback(
    async (event) => {
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
        await openPicker([event]);
      } finally {
        setDownloadingRowId(null);
      }
    },
    [openPicker],
  );

  const downloadBulk = useCallback(
    async (events) => {
      if (!events || events.length === 0) return;

      const eligibleEvents = events.filter((e) => canDownloadEventReport(e).canDownload);
      if (eligibleEvents.length === 0) {
        setDownloadError(
          "None of the selected events have downloadable reports yet. Only completed or recorded events have reports.",
        );
        return;
      }
      if (eligibleEvents.length > MAX_REPORT_EVENTS) {
        setDownloadError(
          `A consolidated report can cover at most ${MAX_REPORT_EVENTS} events. Select fewer events and try again.`,
        );
        return;
      }

      try {
        setIsBulkDownloading(true);
        setDownloadNotice("");
        setDownloadError("");
        setDownloadProgress("Checking what the reports can include...");
        await openPicker(eligibleEvents);
      } finally {
        setIsBulkDownloading(false);
        setDownloadProgress("");
      }
    },
    [openPicker],
  );

  /** Build and download the report with the sections the Dean chose. */
  const generate = useCallback(
    async (customization) => {
      if (!picker) return;
      const { events } = picker;
      try {
        setGenerating(true);
        setDownloadError("");
        if (events.length === 1) {
          const [item] = events;
          // Generated first, as on the event page: the download refuses an
          // event whose report was never generated.
          await apiJson(`/dean/events/${item.id}/generate-report`, {
            method: "POST",
            body: customization,
          });
          const outcome = await downloadDeanEventReport(item.id, item.event_name, customization);
          setDownloadNotice(reportNotice(outcome, `Report for "${item.event_name}"`));
        } else {
          const outcome = await downloadDeanEventsReport(
            events.map((item) => item.id),
            customization,
          );
          setDownloadNotice(reportNotice(outcome, `Consolidated report (${events.length} events)`));
        }
        setPicker(null);
      } catch (err) {
        console.error("Download event report error:", err);
        setDownloadError(err?.message || "Failed to download report.");
        setPicker(null);
      } finally {
        setGenerating(false);
      }
    },
    [picker],
  );

  const reportPicker = {
    open: Boolean(picker),
    onClose: () => {
      if (!generating) setPicker(null);
    },
    onGenerate: generate,
    generating,
    eventName: picker?.events.length === 1 ? picker.events[0].event_name : "",
    isConsolidated: (picker?.events.length || 0) > 1,
    eventCount: picker?.events.length || 1,
    ...(picker?.props || reportModalProps(null)),
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
    reportPicker,
  };
}
