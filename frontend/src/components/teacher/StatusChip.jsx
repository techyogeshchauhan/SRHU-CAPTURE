import { trackOf, labelOf } from "./status";

/**
 * Status pill for the teacher screens. Colour arrives as a single `--track`
 * hex and the stylesheet mixes the fill, border and dot from it.
 */
export default function StatusChip({ status, size = "sm", className = "" }) {
  return (
    <span
      style={{ "--track": trackOf(status) }}
      className={`chip chip-track ${size === "sm" ? "chip-sm" : ""} ${className}`}
    >
      <span className="dot dot-sm" />
      {labelOf(status)}
    </span>
  );
}
