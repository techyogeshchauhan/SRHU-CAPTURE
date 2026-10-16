import { describe, expect, it } from "vitest";
import { normalizeOrganizers, organizerLabel, organizersOf } from "../../src/utils/organizers";
import { readEventFields } from "../../src/utils/eventFields";

describe("event organizers", () => {
  it("retains ordered distinct names and trims whitespace", () => {
    expect(normalizeOrganizers([" Dr. Rao ", "Dr. Verma", "dr. rao", " "])).toEqual(["Dr. Rao", "Dr. Verma"]);
    expect(organizerLabel(["Dr. Rao", "Dr. Verma"])).toBe("Dr. Rao; Dr. Verma");
  });
  it("loads a legacy organizer as one whole selection", () => {
    expect(organizersOf({ organizer: "Sharma, R.; Guest" })).toEqual(["Sharma, R.; Guest"]);
    expect(organizersOf({}, "Legacy Coordinator")).toEqual(["Legacy Coordinator"]);
  });
  it("displays every selected name through the shared event reader", () => {
    expect(readEventFields({ organizers: ["Dr. Rao", "Dr. Verma"], organizer: "Outdated" }).organizer).toBe("Dr. Rao; Dr. Verma");
  });
  it("retains the existing single-organizer fallback", () => {
    expect(readEventFields({ organizer: "Dr. Rao" }).organizer).toBe("Dr. Rao");
    expect(organizersOf({})).toEqual([]);
  });
});
