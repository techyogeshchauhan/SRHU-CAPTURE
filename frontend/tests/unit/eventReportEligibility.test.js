import { describe, expect, it } from "vitest";
import { APPROVAL_REPORT_MESSAGE, DRAFT_REPORT_MESSAGE, eventReportRestriction, selectedReportsRestriction } from "../../src/utils/eventReportEligibility";

describe("Event Manager report eligibility", () => {
  it.each(["approved", "in_progress", "completed", "published"])("allows the Dean-approved stage %s", (status) => {
    expect(eventReportRestriction({ status })).toBe("");
  });

  it.each(["pending", "submitted", "under_review", "rejected", "revoked", "recorded", "resubmitted", "needs_correction", "unknown", "", undefined])("blocks an event without current approval: %s", (status) => {
    expect(eventReportRestriction({ status, report_approval_required: true, report_generated_at: "2026-10-01", history: [{ action: "approved" }] })).toBe(APPROVAL_REPORT_MESSAGE);
  });

  it("blocks server and browser-only drafts, including drafts carrying an old approval", () => {
    expect(eventReportRestriction({ status: " Draft " })).toBe(DRAFT_REPORT_MESSAGE);
    expect(eventReportRestriction({ status: "approved", isDraft: true })).toBe(DRAFT_REPORT_MESSAGE);
  });

  it("blocks the whole mixed selection without silently excluding pending events", () => {
    expect(selectedReportsRestriction([{ status: "approved" }, { status: "pending" }])).toBe(APPROVAL_REPORT_MESSAGE);
    expect(selectedReportsRestriction([{ status: "approved" }, { status: "pending" }, { isDraft: true }])).toBe(DRAFT_REPORT_MESSAGE);
    expect(selectedReportsRestriction([{ status: "approved" }, { status: "completed" }])).toBe("");
  });

  it("preserves existing recorded reports but blocks newly marked recorded events", () => {
    expect(eventReportRestriction({ status: "recorded" })).toBe("");
    expect(eventReportRestriction({ status: "recorded", report_approval_required: false })).toBe("");
    expect(eventReportRestriction({ status: "recorded", report_approval_required: true })).toBe(APPROVAL_REPORT_MESSAGE);
    expect(selectedReportsRestriction([{ status: "recorded" }, { status: "approved", report_approval_required: true }])).toBe("");
    expect(selectedReportsRestriction([{ status: "recorded" }, { status: "recorded", report_approval_required: true }])).toBe(APPROVAL_REPORT_MESSAGE);
  });

  it.each(["draft", "pending", "rejected", "revoked"])("does not grant legacy access for %s", (status) => {
    expect(eventReportRestriction({ status, report_generated_at: "2026-10-01" })).not.toBe("");
  });
});
