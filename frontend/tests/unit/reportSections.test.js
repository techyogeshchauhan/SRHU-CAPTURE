import { describe, expect, it, vi } from "vitest";
import { availableReportOptions, reportSectionAvailability, reportSectionOptions } from "../../src/utils/reportSections";
import { loadReportSections } from "../../src/services/reportSections";
import { apiJson } from "../../src/services/api";

vi.mock("../../src/services/api", () => ({ apiJson: vi.fn() }));

const entry = (event = {}, media = [], documents = []) => ({ event, media, documents });

describe("report section availability", () => {
  it("does not mistake metadata-only descriptions or default departments for supplied data", () => {
    const { available } = reportSectionAvailability([entry({ description: '<!--CC_METADATA:{"department":"SST"}-->' })]);
    expect(Object.values(available).some(Boolean)).toBe(false);
  });

  it("reads optional participant data from legacy metadata, including zero", () => {
    for (const expectedParticipants of [0, "0", "150 students"]) {
      expect(reportSectionAvailability([entry({ description: `<!--CC_METADATA:${JSON.stringify({ expectedParticipants })}-->` })]).available.include_other_info).toBe(true);
    }
  });

  it("makes a section available if any event in a consolidated report supplies data", () => {
    const { available } = reportSectionAvailability([entry({ event_name: "First" }), entry({ description: "Actual content", social_network_url: "https://example.test/post" })]);
    expect(available.include_description).toBe(true);
    expect(available.include_other_info).toBe(true);
    expect(available.include_schedule_venue).toBe(false);
  });

  it("keeps notices separate from report documents and media attachments", () => {
    const { available, counts } = reportSectionAvailability([entry({}, [{ id: "v", media_type: "video" }], [{ category: "notice" }, {}, { category: "report" }])]);
    expect(available.include_photos).toBe(false);
    expect(counts).toEqual({ photos: 0, notices: 2, attachments: 2 });
  });

  it("respects saved photo choices, stale IDs and an explicitly cleared selection", () => {
    const media = Array.from({ length: 8 }, (_, id) => ({ id: String(id), media_type: "image" }));
    expect(reportSectionAvailability([entry({}, media)]).counts.photos).toBe(4);
    expect(reportSectionAvailability([entry({ report_photo_ids: ["1", "4", "missing"] }, media)]).counts.photos).toBe(2);
    const cleared = reportSectionAvailability([entry({ report_photo_ids: [] }, media)]);
    expect(cleared.available.include_photos).toBe(false);
    expect(cleared.available.include_reports).toBe(false);
  });

  it("does not offer photo-only attachments when photographs are excluded", () => {
    const { available } = reportSectionAvailability([entry({}, [{ id: "p", media_type: "image" }])], { ...reportSectionOptions(), include_photos: false });
    expect(available.include_photos).toBe(true);
    expect(available.include_reports).toBe(false);
  });

  it("forces unavailable selections off and reconciles the documents umbrella", () => {
    const available = { ...reportSectionOptions(false), include_basic_details: true, include_notices: true };
    const selected = availableReportOptions(reportSectionOptions(), available);
    expect(selected).toEqual({ ...reportSectionOptions(false), include_basic_details: true, include_notices: true, include_documents: true });
    expect(availableReportOptions(reportSectionOptions(false), available).include_documents).toBe(false);
  });
});

describe("loading authoritative report data", () => {
  it("uses the Manager's combined detail response", async () => {
    apiJson.mockReset().mockResolvedValue({ event: { id: "one", status: "approved" }, media: [], documents: [] });
    const result = await loadReportSections(["one"], "/event-manager");
    expect(apiJson).toHaveBeenCalledTimes(1);
    expect(result[0].event.id).toBe("one");
  });

  it("loads Dean uploads separately and preserves event order", async () => {
    apiJson.mockReset().mockImplementation(async (path) => path.endsWith("/media") ? { media: [] } : path.endsWith("/documents") ? { documents: [{ category: "notice" }] } : { event: { id: path.split("/").pop() } });
    const result = await loadReportSections(["two", "one"], "/dean");
    expect(apiJson).toHaveBeenCalledTimes(6);
    expect(result.map((item) => item.event.id)).toEqual(["two", "one"]);
    expect(result[0].documents).toHaveLength(1);
  });

  it("fails closed when event data or uploads cannot be loaded", async () => {
    apiJson.mockReset().mockResolvedValue({});
    await expect(loadReportSections(["one"], "/event-manager")).rejects.toThrow("could not be loaded");
    apiJson.mockReset().mockRejectedValue(new Error("Access denied"));
    await expect(loadReportSections(["one"], "/dean")).rejects.toThrow("Access denied");
  });

  it("rechecks approval when stale list data opens customization", async () => {
    apiJson.mockReset().mockResolvedValue({ event: { id: "one", status: "revoked", report_generated_at: "2026-10-01" }, media: [], documents: [] });
    await expect(loadReportSections(["one"], "/event-manager")).rejects.toThrow("Report unavailable.");
  });

  it("loads existing recorded sections but rejects newly marked recorded events", async () => {
    apiJson.mockReset().mockResolvedValue({ event: { id: "one", status: "recorded" }, media: [], documents: [] });
    expect((await loadReportSections(["one"], "/event-manager"))[0].event.status).toBe("recorded");
    apiJson.mockResolvedValue({ event: { id: "one", status: "recorded", report_approval_required: true } });
    await expect(loadReportSections(["one"], "/event-manager")).rejects.toThrow("Report unavailable.");
  });
});
