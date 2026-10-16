import { useEffect, useState } from "react";
import { loadReportSections } from "../../services/reportSections";
import { availableReportOptions, reportSectionAvailability, reportSectionOptions } from "../../utils/reportSections";
import { APPROVAL_REPORT_MESSAGE, DRAFT_REPORT_MESSAGE } from "../../utils/eventReportEligibility";
import Modal from "../teacher/Modal";
import {
  IconCalendar,
  IconDownload,
  IconFile,
  IconFileText,
  IconImagePlus,
  IconTag,
  IconUsers,
} from "../teacher/icons";

/**
 * Report Customization Modal
 *
 * Allows Dean and Event Manager to customize what information is included in
 * the final PDF report before generating and downloading it.
 */
export default function ReportCustomizationModal({ open, ...props }) {
  return open ? <ReportCustomizationContents {...props} /> : null;
}

function ReportCustomizationContents({
  onClose,
  onGenerate,
  generating = false,
  eventName = "",
  eventIds = [],
  apiBase = "/event-manager",
  error = "",
  isConsolidated = false,
  eventCount = 1,
}) {
  const [options, setOptions] = useState(reportSectionOptions);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const idsKey = JSON.stringify(eventIds);
  useEffect(() => {
    const controller = new AbortController();
    const ids = JSON.parse(idsKey);
    loadReportSections(ids, apiBase, controller.signal).then((entries) => {
      if (!controller.signal.aborted) setData(entries);
    }).catch((err) => {
      if (!controller.signal.aborted) setLoadError(err?.message || "Could not load report sections.");
    });
    return () => controller.abort();
  }, [idsKey, apiBase, attempt]);

  const { available, counts } = reportSectionAvailability(data || [], options);
  const fullAvailability = reportSectionAvailability(data || []);
  const selected = availableReportOptions(options, available);
  const photoCount = counts.photos;
  const noticeCount = counts.notices;
  const attachmentCount = counts.attachments;
  const loading = !data && !loadError;
  const approvalBlocked = apiBase === "/event-manager" && [APPROVAL_REPORT_MESSAGE, DRAFT_REPORT_MESSAGE].includes(error);

  const toggleOption = (key) => {
    if (!available[key] || generating || loading || loadError || approvalBlocked) return;
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectAll = () => {
    setOptions(reportSectionOptions());
  };

  const handleDeselectAll = () => {
    setOptions(reportSectionOptions(false));
  };

  const selectedCount = Object.entries(selected).filter(([key, value]) => key !== "include_documents" && value).length;
  const allAvailableSelected = Object.entries(fullAvailability.available).every(([key, value]) => !value || selected[key]);
  const canGenerate = selectedCount > 0 && !generating && !loading && !loadError && !approvalBlocked;

  const handleConfirm = async () => {
    if (!canGenerate) return;
    await onGenerate(selected);
  };

  const sections = [
    {
      key: "include_basic_details",
      title: "Event Details & Organization",
      description: "Event title, category/type, host department, coordinator contact, and organizer.",
      Icon: IconTag,
    },
    {
      key: "include_schedule_venue",
      title: "Date, Time & Venue",
      description: "Event schedule dates, start and end timings, and campus venue or location.",
      Icon: IconCalendar,
    },
    {
      key: "include_description",
      title: "Event Description & Objectives",
      description: "Full event description, objectives, and summary documentation.",
      Icon: IconFileText,
    },
    {
      key: "include_other_info",
      title: "Participation & Social Links",
      description: "No. of Participants and published social media links.",
      Icon: IconUsers,
    },
    {
      key: "include_photos",
      title: "Photographs & Images",
      description: "The chosen event photographs, arranged in the official photo grid.",
      Icon: IconImagePlus,
      badge: photoCount != null ? (photoCount > 0 ? `${photoCount} ${photoCount === 1 ? "photo" : "photos"}` : "No photos") : null,
    },
    {
      key: "include_notices",
      title: "Uploaded Notices",
      description: "Only the files uploaded as notices: circulars, event notices, agendas and invitations, with download links.",
      Icon: IconFileText,
      badge: noticeCount != null ? (noticeCount > 0 ? `${noticeCount} ${noticeCount === 1 ? "notice" : "notices"}` : "No notices") : null,
    },
    {
      key: "include_reports",
      title: "Uploaded Attachments",
      description: "Every file that is not a notice: report documents, plus download links for each photo and video.",
      Icon: IconFile,
      badge: attachmentCount != null ? (attachmentCount > 0 ? `${attachmentCount} ${attachmentCount === 1 ? "file" : "files"}` : "No files") : null,
    },
  ];

  return (
    <Modal
      open
      onClose={generating ? undefined : onClose}
      eyebrow="Report Customization"
      title={isConsolidated ? `Customize Consolidated Report (${eventCount} Events)` : "Customize Event Report"}
      subtitle={
        isConsolidated
          ? "Choose which sections and details to include across all events in this consolidated report."
          : eventName
          ? `Choose which sections to include in the official report for "${eventName}".`
          : "Choose the sections and details to include before generating the final PDF report."
      }
      wide
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={generating}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-brand btn-sm"
            onClick={handleConfirm}
            disabled={!canGenerate}
          >
            {generating ? (
              <span className="spin h-3.5 w-3.5" />
            ) : (
              <IconDownload className="h-4 w-4" />
            )}
            {generating ? "Generating PDF…" : "Generate PDF Report"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {isConsolidated && <p className="prose-muted text-xs">A section is available when at least one selected event has data. The PDF includes it only for events that supplied that data.</p>}
        {loading && <p role="status" className="prose-muted text-sm">Checking available report sections…</p>}
        {loadError && (
          <div role="alert" className="rounded-lg border border-err/20 bg-err/10 p-3 text-sm text-err">
            <p>{loadError}</p>
            <button type="button" className="btn btn-ghost btn-xs mt-2" onClick={() => { setLoadError(""); setAttempt((value) => value + 1); }}>Retry</button>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-err">{error}</p>}
        {/* Presets and quick count */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-3">
          <p className="text-xs font-medium text-ink">
            <span className="text-accent font-semibold">{selectedCount}</span> of {sections.length} sections selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSelectAll}
              disabled={generating || loading || Boolean(loadError) || approvalBlocked || allAvailableSelected}
              className="text-xs text-accent hover:underline disabled:opacity-40 disabled:no-underline font-medium"
            >
              Select All
            </button>
            <span className="text-muted text-xs">·</span>
            <button
              type="button"
              onClick={handleDeselectAll}
              disabled={generating || loading || Boolean(loadError) || approvalBlocked || selectedCount === 0}
              className="text-xs text-muted hover:text-ink hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Deselect All
            </button>
          </div>
        </div>

        {/* Section Cards */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {sections.map(({ key, title, description, Icon, badge }) => {
            const checked = selected[key];
            const disabled = generating || loading || Boolean(loadError) || approvalBlocked || !available[key];
            return (
              <label
                key={key}
                className={`relative flex items-start gap-3 rounded-xl border p-3.5 transition-colors select-none ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${
                  !available[key] ? "border-line/60 bg-raised/20 opacity-60" : checked
                    ? "border-accent/40 bg-accent/[0.04] shadow-xs"
                    : "border-line/60 bg-surface/30 opacity-70 hover:opacity-100 hover:border-line"
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={title}
                  checked={checked}
                  onChange={() => toggleOption(key)}
                  disabled={disabled}
                  className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${
                        checked ? "bg-accent/15 text-accent" : "bg-surface text-muted"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      {title}
                    </span>
                  </div>

                  <p className="prose-muted mt-1 text-[11px] leading-relaxed">
                    {description}
                  </p>

                  {badge && (
                    <div className="mt-2">
                      <span className="inline-block rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted border hairline">
                        {badge}
                      </span>
                    </div>
                  )}
                  {!loading && !loadError && !available[key] && (
                    <p className="mt-2 text-xs text-muted">{key === "include_reports" && !options.include_photos && fullAvailability.counts.attachments > 0
                      ? "Select Photographs & Images to include photo links."
                      : key === "include_photos" ? "No photographs selected for this report." : "No data provided for this section."}</p>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        {!loading && !loadError && selectedCount === 0 && (
          <div className="rounded-lg bg-err/10 border border-err/20 px-3.5 py-2.5 text-xs text-err" role="alert">
            Please select at least one section to include in the report.
          </div>
        )}
      </div>
    </Modal>
  );
}
