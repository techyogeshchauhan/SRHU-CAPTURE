import { trackOf, labelOf } from "./status";
import { IconArchive } from "./icons";

/**
 * Status pill for the teacher screens. Colour arrives as a single `--track`
 * hex and the stylesheet mixes the fill, border and dot from it.
 *
 * `archived` adds an "Archived" pill beside it: archiving is not a status, so
 * an event the Dean shelved keeps its own and is marked alongside.
 */
export default function StatusChip({ status, size = "sm", className = "", archived = false }) {
  const chip = (
    <span
      style={{ "--track": trackOf(status) }}
      className={`chip chip-track ${size === "sm" ? "chip-sm" : ""} ${archived ? "" : className}`}
    >
      <span className="dot dot-sm" />
      {labelOf(status)}
    </span>
  );
  if (!archived) return chip;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {chip}
      <span
        className={`chip ${size === "sm" ? "chip-sm" : ""} bg-muted/10 font-medium text-muted`}
        title="The Dean moved this event to the archive"
      >
        <IconArchive className="h-3 w-3" />
        Archived
      </span>
    </span>
  );
}
