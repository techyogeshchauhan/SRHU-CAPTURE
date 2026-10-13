import { describe, expect, it } from "vitest";

import { albumNeighbours, periodOf, periodRange } from "../../src/utils/galleryAlbums";

const TODAY = "2026-10-10";

describe("periodRange", () => {
  it("runs each period up to today", () => {
    expect(periodRange("month", TODAY)).toEqual({ startDate: "2026-10-01", endDate: TODAY });
    expect(periodRange("year", TODAY)).toEqual({ startDate: "2026-01-01", endDate: TODAY });
    expect(periodRange("quarter", TODAY)).toEqual({ startDate: "2026-07-12", endDate: TODAY });
  });

  it("is no range for all time", () => {
    expect(periodRange("", TODAY)).toEqual({ startDate: "", endDate: "" });
  });
});

describe("periodOf", () => {
  it("recognises a period's own range", () => {
    expect(periodOf("2026-10-01", TODAY, TODAY)).toBe("month");
    expect(periodOf("2026-01-01", TODAY, TODAY)).toBe("year");
  });

  it("calls no range all time, and anything else custom", () => {
    expect(periodOf("", "", TODAY)).toBe("");
    expect(periodOf("2026-03-01", "2026-03-31", TODAY)).toBe("custom");
  });
});

describe("albumNeighbours", () => {
  const ids = ["a", "b", "c"];

  it("finds both sides in the middle", () => {
    expect(albumNeighbours(ids, "b")).toEqual({ index: 1, prev: "a", next: "c" });
  });

  it("stops at the ends", () => {
    expect(albumNeighbours(ids, "a")).toEqual({ index: 0, prev: null, next: "b" });
    expect(albumNeighbours(ids, "c")).toEqual({ index: 2, prev: "b", next: null });
  });

  it("knows nothing of an album that is not on the page", () => {
    expect(albumNeighbours(ids, "z")).toEqual({ index: -1, prev: null, next: null });
  });
});
