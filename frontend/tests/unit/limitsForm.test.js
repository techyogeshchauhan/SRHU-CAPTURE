import { describe, expect, it } from "vitest";

import {
  effectiveCeiling,
  fromServer,
  isDirty,
  toWire,
  validateLimits,
} from "../../src/utils/limitsForm";
import { DEFAULT_LIMIT_BOUNDS, DEFAULT_UPLOAD_LIMITS } from "../../src/utils/uploadLimits";

const bounds = DEFAULT_LIMIT_BOUNDS;
const base = () => fromServer(DEFAULT_UPLOAD_LIMITS);

describe("fromServer / toWire", () => {
  it("round-trips without changing the values", () => {
    expect(toWire(fromServer(DEFAULT_UPLOAD_LIMITS))).toEqual(DEFAULT_UPLOAD_LIMITS);
  });

  it("keeps null as null rather than turning it into 0", () => {
    const values = fromServer({ max_photo_total_mb: null });
    expect(values.max_photo_total_mb).toBeNull();
    expect(toWire(values).max_photo_total_mb).toBeNull();
  });

  it("treats an emptied input as no cap", () => {
    expect(toWire({ max_photo_total_mb: "" }).max_photo_total_mb).toBeNull();
  });

  it("keeps the mandatory-upload switches as booleans", () => {
    const values = fromServer({ photos_required: false, videos_required: true });
    expect(values).toEqual({ photos_required: false, videos_required: true });
    expect(toWire(values)).toEqual({ photos_required: false, videos_required: true });
  });

  it("does not report the switches as validation errors", () => {
    expect(validateLimits({ ...base(), videos_required: true }, bounds)).toEqual({});
  });
});

describe("validateLimits", () => {
  it("accepts the shipped defaults", () => {
    expect(validateLimits(base(), bounds)).toEqual({});
  });

  it("rejects a decimal instead of silently truncating it", () => {
    // The previous form validated with Number.isFinite but saved with parseInt,
    // so 20.5 was accepted and stored as 20.
    const errors = validateLimits({ ...base(), max_photo_size_mb: "20.5" }, bounds);
    expect(errors.max_photo_size_mb).toMatch(/whole number/);
  });

  it.each(["", " ", "-1", "2e3", "abc", "1.0"])("rejects %o", (input) => {
    expect(validateLimits({ ...base(), max_photos_per_event: input }, bounds))
      .toHaveProperty("max_photos_per_event");
  });

  it("rejects values outside the server's bounds", () => {
    expect(validateLimits({ ...base(), max_photos_per_event: "101" }, bounds))
      .toHaveProperty("max_photos_per_event");
    expect(validateLimits({ ...base(), max_photos_per_event: "0" }, bounds))
      .toHaveProperty("max_photos_per_event");
  });

  it("requires the non-nullable fields but allows the optional ones to be null", () => {
    expect(validateLimits({ ...base(), max_photo_size_mb: null }, bounds))
      .toHaveProperty("max_photo_size_mb");
    expect(validateLimits({ ...base(), max_photo_total_mb: null }, bounds))
      .not.toHaveProperty("max_photo_total_mb");
  });

  it("flags both sides of a broken photo relationship", () => {
    const errors = validateLimits(
      { ...base(), max_photo_size_mb: "40", max_photo_total_mb: "10" },
      bounds,
    );
    expect(errors.max_photo_size_mb).toBeTruthy();
    expect(errors.max_photo_total_mb).toBe(errors.max_photo_size_mb);
  });

  it("flags both sides of a broken video relationship", () => {
    const errors = validateLimits(
      { ...base(), max_video_size_mb: "300", max_video_total_mb: "100" },
      bounds,
    );
    expect(errors.max_video_size_mb).toBeTruthy();
    expect(errors.max_video_total_mb).toBe(errors.max_video_size_mb);
  });

  it("checks the video relationship even when the total is itself invalid", () => {
    // This lived in an `else if`, so it never ran when the total was out of range.
    const errors = validateLimits(
      { ...base(), max_video_size_mb: "300", max_video_total_mb: "99999" },
      bounds,
    );
    expect(errors.max_video_total_mb).toBeTruthy();
  });

  it("rejects a per-file cap above the deployment ceiling", () => {
    // The combined budget is raised alongside it, so the relationship rule --
    // which is the more fundamental problem and reports first -- stays quiet.
    const errors = validateLimits(
      { ...base(), max_video_size_mb: "500", max_video_total_mb: "500" },
      bounds,
      { deploymentCeilingMb: 200 },
    );
    expect(errors.max_video_size_mb).toMatch(/200 MB/);
  });

  it("lets a relationship error take precedence over the ceiling message", () => {
    const errors = validateLimits(
      { ...base(), max_video_size_mb: "500", max_video_total_mb: "100" },
      bounds,
      { deploymentCeilingMb: 200 },
    );
    expect(errors.max_video_size_mb).toMatch(/combined video budget/);
  });

  it("allows a per-file cap exactly at the ceiling", () => {
    const errors = validateLimits(
      { ...base(), max_video_size_mb: "200", max_video_total_mb: "200" },
      bounds,
      { deploymentCeilingMb: 200 },
    );
    expect(errors).toEqual({});
  });
});

describe("isDirty", () => {
  it("is false for an untouched form and true after one edit", () => {
    const pristine = base();
    expect(isDirty({ ...pristine }, pristine)).toBe(false);
    expect(isDirty({ ...pristine, max_photos_per_event: "9" }, pristine)).toBe(true);
  });

  it("notices a toggle being switched off", () => {
    const pristine = fromServer({ ...DEFAULT_UPLOAD_LIMITS, max_photo_total_mb: 50 });
    expect(isDirty({ ...pristine, max_photo_total_mb: null }, pristine)).toBe(true);
  });
});

describe("effectiveCeiling", () => {
  it("caps photos by count x per-file when there is no combined budget", () => {
    const totals = effectiveCeiling(base());
    expect(totals.photosMb).toBe(10 * 20);
  });

  it("lets a combined budget narrow the count-based figure", () => {
    const values = fromServer({ ...DEFAULT_UPLOAD_LIMITS, max_photo_total_mb: 60 });
    expect(effectiveCeiling(values).photosMb).toBe(60);
  });

  it("reports the largest single file across all three kinds", () => {
    expect(effectiveCeiling(base()).largestSingleMb).toBe(200);
  });

  it("sums the worst case for one event", () => {
    // 200 MB photos + 200 MB video + 15 MB documents
    expect(effectiveCeiling(base()).worstCaseMb).toBe(415);
  });
});
