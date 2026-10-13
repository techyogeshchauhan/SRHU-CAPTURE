import { outcomeLabel, outcomeTrack, verificationMeta } from "../../utils/research";

/**
 * Where the record stands. `recorded` marks one the Event Manager submitted:
 * accepted at once, without the Dean, so it reads "Recorded".
 */
export function VerificationChip({ status, recorded = false, size = "sm" }) {
  const meta = verificationMeta(status);
  return (
    <span style={{ "--track": meta.track }} className={`chip chip-track ${size === "sm" ? "chip-sm" : ""}`}>
      <span className="dot dot-sm" />
      {recorded && status === "verified" ? "Recorded" : meta.label}
    </span>
  );
}

/**
 * Where the research itself stands -- a patent's Filed / Published / Granted.
 * Hidden for a category with a single outcome, where it would say nothing.
 */
export function OutcomeChip({ category, outcome, size = "sm" }) {
  if (!category || (category.outcomes || []).length <= 1) return null;
  return (
    <span
      style={{ "--track": outcomeTrack(category, outcome) }}
      className={`chip chip-track ${size === "sm" ? "chip-sm" : ""}`}
      title={`${category.short} status`}
    >
      {outcomeLabel(category, outcome)}
    </span>
  );
}
