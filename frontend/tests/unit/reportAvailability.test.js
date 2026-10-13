import { describe, expect, it } from "vitest";
import { availabilityFromFiles, reportModalProps } from "../../src/utils/reportAvailability";

describe("availabilityFromFiles", () => {
  it("counts photos, videos, notices and attachments like the report does", () => {
    const summary = availabilityFromFiles({
      description: "A write-up.",
      participants: "120",
      media: [{ media_type: "image" }, { media_type: "IMAGE" }, { media_type: "video" }],
      documents: [{ category: "notice" }, { category: "report" }, {}],
    });
    expect(summary).toEqual({
      photos: 2,
      videos: 1,
      notices: 2, // uncategorised counts as a notice
      report_documents: 1,
      attachments: 4, // 1 report document + 3 media links
      has_description: true,
      has_other_info: true,
    });
  });

  it("treats blank text and a 0 participant count as absent", () => {
    const summary = availabilityFromFiles({ description: "   ", participants: "0", socialUrl: "" });
    expect(summary.has_description).toBe(false);
    expect(summary.has_other_info).toBe(false);
    expect(summary.attachments).toBe(0);
  });

  it("counts a social link alone as other info", () => {
    expect(availabilityFromFiles({ socialUrl: "https://instagram.com/p/1" }).has_other_info).toBe(true);
  });
});

describe("reportModalProps", () => {
  it("maps a summary onto the modal's props", () => {
    expect(
      reportModalProps({
        photos: 0,
        videos: 2,
        notices: 1,
        report_documents: 2,
        attachments: 4,
        has_description: false,
        has_other_info: true,
      }),
    ).toEqual({
      photoCount: 0,
      documentCount: 3,
      noticeCount: 1,
      attachmentCount: 4,
      hasDescription: false,
      hasOtherInfo: true,
    });
  });

  it("leaves everything unknown without a summary", () => {
    expect(Object.values(reportModalProps(null)).every((value) => value === null)).toBe(true);
  });
});
