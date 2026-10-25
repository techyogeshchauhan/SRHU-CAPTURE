import { describe, expect, it } from "vitest";

import {
  authorIndex,
  changesSinceVerified,
  compactDetails,
  formatFieldValue,
  isFieldRequired,
  isFieldShown,
  outcomeTrack,
  summariseHistory,
} from "../../src/utils/research";
import { trackOf } from "../../src/components/teacher/status";

const PATENT = {
  key: "patent",
  date_label: "Filing date",
  outcomes: [
    { key: "filed", label: "Filed" },
    { key: "published", label: "Published" },
    { key: "granted", label: "Granted" },
    { key: "refused", label: "Refused" },
  ],
  closed_outcomes: ["refused"],
  fields: [
    { key: "application_number", label: "Application number", type: "text", required: true },
    { key: "grant_date", label: "Grant date", type: "date", required_from: "granted" },
    { key: "page_count", label: "Page count", type: "number" },
  ],
};

describe("isFieldRequired", () => {
  const grantDate = PATENT.fields[1];

  it("asks for a stage's fields once the outcome reaches it", () => {
    expect(isFieldRequired(PATENT, grantDate, "published")).toBe(false);
    expect(isFieldRequired(PATENT, grantDate, "granted")).toBe(true);
  });

  it("never asks a closed outcome for them", () => {
    expect(isFieldRequired(PATENT, grantDate, "refused")).toBe(false);
  });

  it("always asks for a required field", () => {
    expect(isFieldRequired(PATENT, PATENT.fields[0], "filed")).toBe(true);
  });
});

describe("outcomeTrack", () => {
  it("colours the line by how far along it is", () => {
    expect(outcomeTrack(PATENT, "filed")).toBe(trackOf("draft"));
    expect(outcomeTrack(PATENT, "published")).toBe(trackOf("under_review"));
    expect(outcomeTrack(PATENT, "granted")).toBe(trackOf("approved"));
    expect(outcomeTrack(PATENT, "refused")).toBe(trackOf("rejected"));
  });
});

describe("formatFieldValue", () => {
  it("formats numbers and lists as text", () => {
    expect(formatFieldValue(PATENT.fields[2], 1250000)).toBe("12,50,000");
    expect(formatFieldValue({ type: "multiselect" }, ["Scopus", "PubMed"])).toBe("Scopus, PubMed");
    expect(formatFieldValue({ type: "text" }, "")).toBe("");
  });
});

describe("changesSinceVerified", () => {
  const record = {
    title: "Herbal dressing",
    record_date: "2026-03-10",
    outcome_status: "granted",
    details: { application_number: "2026110", grant_date: "2026-09-01" },
    evidence: [
      { id: "a", tag: "Filing receipt", file_name: "receipt.pdf" },
      { id: "b", tag: "Grant certificate", file_name: "grant.pdf" },
    ],
    verified_snapshot: {
      title: "Herbal dressing",
      record_date: "2026-03-10",
      outcome_status: "filed",
      details: { application_number: "2026110" },
      evidence: [{ id: "a", tag: "Filing receipt", file_name: "receipt.pdf" }],
    },
  };

  it("lists exactly what moved since verification", () => {
    const rows = changesSinceVerified(record, PATENT);
    expect(rows.map((r) => r.label)).toEqual(["Status", "Grant date", "Evidence added"]);
    expect(rows[0]).toMatchObject({ before: "Filed", after: "Granted" });
  });

  it("is empty for a record never verified", () => {
    expect(changesSinceVerified({ ...record, verified_snapshot: null }, PATENT)).toEqual([]);
  });
});

describe("compactDetails", () => {
  it("drops what was left empty", () => {
    expect(compactDetails({ a: "", b: [], c: "x", d: ["y"], e: 0 })).toEqual({ c: "x", d: ["y"], e: 0 });
  });
});

describe("recordFacts", () => {
  it("names what a record is in one line", async () => {
    const { recordFacts } = await import("../../src/utils/research");
    expect(
      recordFacts({ category: "journal", details: { journal: "Wound Care", volume: "12", issue: "3", indexing: ["Scopus"] } }),
    ).toBe("Wound Care · Vol. 12(3) · Scopus");
    expect(recordFacts({ category: "project", details: { role: "Principal Investigator" } })).toBe(
      "Principal Investigator",
    );
  });

  it("shows funded projects, and the text typed in for Other", async () => {
    const { recordFacts } = await import("../../src/utils/research");
    expect(
      recordFacts({
        category: "funded_project",
        details: { funding_type: "Extramural", funding_agency: "SERB", amount: 1200000, role: "Principal Investigator" },
      }),
    ).toBe("Extramural · SERB · ₹12,00,000 · Principal Investigator");
    expect(
      recordFacts({
        category: "conference",
        details: { conference: "Summit", presentation_type: "Other", presentation_type_other: "Panel discussion", mode: "Online" },
      }),
    ).toBe("Summit · Panel discussion · Online");
    expect(recordFacts({ category: "patent", details: { ipr_type: "Copyright", office: "India (IPO)" } })).toBe(
      "Copyright · India (IPO)",
    );
    expect(recordFacts({ category: "other", details: { kind: "Session chair", awarded_by: "IEEE" } })).toBe(
      "Session chair · IEEE",
    );
  });
});

describe("summariseHistory", () => {
  const vishal = { actor_name: "Vishal Tomar", actor_role: "event_manager" };
  const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 16, 0) + minutes * 60000).toISOString();

  it("merges one sitting and drops a submission that was recorded at once", () => {
    const rows = summariseHistory([
      { ...vishal, action: "created", created_at: at(0) },
      { ...vishal, action: "evidence_added", note: "Certificate: cert.pdf", created_at: at(1) },
      { ...vishal, action: "submitted", created_at: at(2) },
      { ...vishal, action: "recorded", note: "Recorded by the Event Manager; no Dean verification needed.", created_at: at(22) },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("created the record, attached evidence and recorded it");
    expect(rows[0].notes).toEqual(["Certificate: cert.pdf"]);
  });

  it("keeps different people, and long gaps, apart -- newest first", () => {
    const rows = summariseHistory([
      { ...vishal, action: "created", created_at: at(0) },
      { ...vishal, action: "submitted", created_at: at(1) },
      { actor_name: "Aparna Sharma", actor_role: "dean", action: "changes_requested", note: "Attach the receipt.", created_at: at(90) },
    ]);
    expect(rows.map((r) => r.actor_name)).toEqual(["Aparna Sharma", "Vishal Tomar"]);
    expect(rows[0].notes).toEqual(["Attach the receipt."]);
    expect(rows[1].text).toBe("created the record and submitted it for verification");
  });
});

describe("conditional fields (Other indexing)", () => {
  const journal = { outcomes: [{ key: "published", label: "Published" }], closed_outcomes: [] };
  const other = { key: "indexing_other", label: "Other indexing platform", required: true, shown_if: { field: "indexing", value: "Other" } };

  it("shows and needs the name only while Other is ticked", () => {
    expect(isFieldShown(other, { indexing: ["Scopus"] })).toBe(false);
    expect(isFieldRequired(journal, other, "published", { indexing: ["Scopus"] })).toBe(false);
    expect(isFieldShown(other, { indexing: ["Scopus", "Other"] })).toBe(true);
    expect(isFieldRequired(journal, other, "published", { indexing: ["Other"] })).toBe(true);
  });
});

describe("authorIndex", () => {
  const authors = ["Meera Joshi", "Arjun Rawat", "Stéfan J. van der Walt"];

  it("finds the faculty member however their name is written", () => {
    expect(authorIndex("Dr. Meera Joshi", authors)).toBe(0);
    expect(authorIndex("Prof Arjun Rawat", ["M. Joshi", "A. Rawat"])).toBe(1);
    expect(authorIndex("Stefan van der Walt", authors)).toBe(2);
  });

  it("does not match a different person with the same surname", () => {
    expect(authorIndex("Neha Joshi", authors)).toBe(-1);
    expect(authorIndex("Vishal Tomar", authors)).toBe(-1);
    expect(authorIndex("", authors)).toBe(-1);
  });
});
