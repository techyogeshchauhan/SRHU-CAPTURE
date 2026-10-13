import { describe, expect, it } from "vitest";

import { dmyToIso, isoToDmy, maskDmy } from "../../src/utils/dates";

describe("dd/mm/yyyy dates", () => {
  it("shows a stored date as dd/mm/yyyy", () => {
    expect(isoToDmy("2026-09-05")).toBe("05/09/2026");
    expect(isoToDmy("")).toBe("");
    expect(isoToDmy("05/09/2026")).toBe("");
  });

  it("reads a typed date back as YYYY-MM-DD", () => {
    expect(dmyToIso("05/09/2026")).toBe("2026-09-05");
    expect(dmyToIso("05-09-2026")).toBe("2026-09-05");
    expect(dmyToIso("29/02/2028")).toBe("2028-02-29"); // leap year
  });

  it("refuses incomplete or impossible dates", () => {
    for (const bad of ["", "5/9/2026", "05/09/26", "31/02/2026", "29/02/2027", "00/01/2026", "12/13/2026", "31/04/2026"]) {
      expect(dmyToIso(bad)).toBe("");
    }
  });

  it("puts the slashes in while typing", () => {
    expect(maskDmy("0")).toBe("0");
    expect(maskDmy("0509")).toBe("05/09");
    expect(maskDmy("05092026")).toBe("05/09/2026");
    expect(maskDmy("05/09/2026 extra 99")).toBe("05/09/2026");
  });

  it("round-trips", () => {
    expect(dmyToIso(isoToDmy("2026-12-31"))).toBe("2026-12-31");
  });
});
