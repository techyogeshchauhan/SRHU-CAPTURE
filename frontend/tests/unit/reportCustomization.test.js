import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadEventReport, downloadEventsReport } from "../../src/services/eventManager";
import * as apiModule from "../../src/services/api";

describe("Report customization options propagation in eventManager service", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    globalThis.window = {
      URL: {
        createObjectURL: vi.fn().mockReturnValue("blob:mock-url"),
        revokeObjectURL: vi.fn(),
      },
      isSecureContext: true,
      open: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    globalThis.document = {
      createElement: vi.fn().mockReturnValue({
        click: vi.fn(),
        remove: vi.fn(),
        set href(val) {},
        set download(val) {},
      }),
      body: {
        appendChild: vi.fn(),
      },
    };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    vi.restoreAllMocks();
  });

  it("passes customization in body of POST for single event report", async () => {
    const mockBlob = new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" });
    const mockResponse = {
      ok: true,
      blob: async () => mockBlob,
      headers: {
        get: (h) => (h === "content-disposition" ? 'attachment; filename="test_report.pdf"' : null),
      },
    };

    const apiFetchSpy = vi.spyOn(apiModule, "apiFetch").mockResolvedValue(mockResponse);

    const customization = {
      include_basic_details: true,
      include_schedule_venue: false,
      include_description: true,
      include_other_info: false,
      include_photos: true,
      include_documents: false,
    };

    await downloadEventReport("evt123", "Annual Fest", customization);

    expect(apiFetchSpy).toHaveBeenCalledWith(
      "/event-manager/events/evt123/report",
      {
        method: "POST",
        body: customization,
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("omits body when no customization is passed for single event report", async () => {
    const mockBlob = new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" });
    const mockResponse = {
      ok: true,
      blob: async () => mockBlob,
      headers: { get: () => null },
    };

    const apiFetchSpy = vi.spyOn(apiModule, "apiFetch").mockResolvedValue(mockResponse);

    await downloadEventReport("evt456", "Tech Talk");

    expect(apiFetchSpy).toHaveBeenCalledWith(
      "/event-manager/events/evt456/report",
      { signal: expect.any(AbortSignal) }
    );
  });

  it("passes customization within body for multiple events consolidated report", async () => {
    const mockBlob = new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" });
    const mockResponse = {
      ok: true,
      blob: async () => mockBlob,
      headers: { get: () => null },
    };

    const apiFetchSpy = vi.spyOn(apiModule, "apiFetch").mockResolvedValue(mockResponse);

    const customization = {
      include_basic_details: true,
      include_schedule_venue: true,
      include_description: false,
      include_other_info: false,
      include_photos: false,
      include_documents: true,
    };

    await downloadEventsReport(["e1", "e2"], customization);

    expect(apiFetchSpy).toHaveBeenCalledWith(
      "/event-manager/reports",
      {
        method: "POST",
        body: {
          event_ids: ["e1", "e2"],
          customization,
        },
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("passes separate notice and report preferences", async () => {
    const mockBlob = new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" });
    const mockResponse = {
      ok: true,
      blob: async () => mockBlob,
      headers: { get: () => null },
    };

    const apiFetchSpy = vi.spyOn(apiModule, "apiFetch").mockResolvedValue(mockResponse);

    const customization = {
      include_basic_details: true,
      include_schedule_venue: true,
      include_description: true,
      include_other_info: true,
      include_photos: true,
      include_notices: true,
      include_reports: false,
      include_documents: true,
    };

    await downloadEventReport("evt789", "Workshop", customization);

    expect(apiFetchSpy).toHaveBeenCalledWith(
      "/event-manager/events/evt789/report",
      {
        method: "POST",
        body: customization,
        signal: expect.any(AbortSignal),
      }
    );
  });
});
