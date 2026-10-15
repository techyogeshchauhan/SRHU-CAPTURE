import { describe, expect, it } from "vitest";
import { encodeEventMetadata } from "../../src/utils/draftStorage";
import {
  DEFAULT_HOST_DEPARTMENT,
  getEventDepartmentName,
  readEventFields,
} from "../../src/utils/eventFields";

const fullDepartment =
  "Computer Science and Engineering, School of Science and Technology";

describe("event department display", () => {
  it.each(["SST", " sst ", "Sst"])("resolves the stored identifier %s", (department) => {
    expect(getEventDepartmentName({ department })).toBe(fullDepartment);
  });

  it("resolves the host default for events with no department", () => {
    expect(getEventDepartmentName()).toBe(fullDepartment);
    expect(getEventDepartmentName({ department: " " })).toBe(fullDepartment);
  });

  it("resolves legacy metadata returned in the API description", () => {
    const event = { description: encodeEventMetadata("Workshop", { department: "SST" }) };
    expect(getEventDepartmentName(event)).toBe(fullDepartment);
    expect(readEventFields(event).description).toBe("Workshop");
  });

  it("preserves an explicitly different department ahead of legacy metadata", () => {
    const event = {
      department: "Mechanical Engineering",
      description: encodeEventMetadata("Workshop", { department: "SST" }),
    };
    expect(getEventDepartmentName(event)).toBe("Mechanical Engineering");
  });

  it("retains custom legacy departments and already expanded names", () => {
    const event = {
      department: " ",
      description: encodeEventMetadata("", { department: "Applied Sciences" }),
    };
    expect(getEventDepartmentName(event)).toBe("Applied Sciences");
    expect(getEventDepartmentName({ department: fullDepartment })).toBe(fullDepartment);
  });

  it("leaves the raw identifier, metadata and event data unchanged", () => {
    const event = Object.freeze({
      description: encodeEventMetadata("Workshop", { department: "SST" }),
    });
    const original = JSON.stringify(event);
    getEventDepartmentName(event);
    expect(DEFAULT_HOST_DEPARTMENT).toBe("SST");
    expect(readEventFields(event).department).toBe("SST");
    expect(JSON.stringify(event)).toBe(original);
  });
});
