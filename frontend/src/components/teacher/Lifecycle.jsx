import { IconCheck, IconX } from "./icons";
import { STATUS_TRACK } from "./status";

// Only the states the backend actually puts an event in. Submitting sets the
// status straight to "pending", so a separate "Submitted" node could never be
// the current one and has gone. "In progress" was removed from event tracking;
// "Completed" stays: the Dean closes an approved event from the event page, and
// the teacher is emailed and notified. A refused event can reach neither until
// it comes back round, so each refusal ends its own rail: "Rejected" straight
// after Pending review, "Revoked" after the Approved it had already reached.
const HAPPY_PATH = [
  { id: "draft", label: "Created" },
  { id: "pending", label: "Pending review" },
  { id: "approved", label: "Approved" },
  { id: "completed", label: "Completed" },
];

const STEPS = (status) => {
  if (status === "rejected") {
    return [HAPPY_PATH[0], HAPPY_PATH[1], { id: "rejected", label: "Rejected" }];
  }

  // A revocation comes *after* an approval, so the rail keeps the Approved
  // node the event genuinely passed through. Ending it at "Rejected" would
  // claim the Dean never approved it.
  if (status === "revoked") {
    return [
      HAPPY_PATH[0],
      HAPPY_PATH[1],
      HAPPY_PATH[2],
      { id: "revoked", label: "Revoked" },
    ];
  }

  return HAPPY_PATH;
};

/** How far along the rail a given status sits. */
function indexFor(status) {
  if (status === "draft") return 0;
  // A retired "in_progress" event sits at Approved, the stage it has become.
  if (status === "approved" || status === "published" || status === "in_progress" || status === "rejected") return 2;
  // Fourth node of the revoked trail above -- not "Pending review", which is
  // what this used to fall through to while the chip beside it read "Revoked".
  if (status === "revoked") return 3;
  if (status === "completed") return 3;
  return 1; // pending, or the legacy submitted / under_review: waiting on the Dean
}

/**
 * The approval rail. Each node is tinted from the `--track` hex of the state
 * it represents, so the tracker and the status pills always agree.
 */
export default function Lifecycle({ status = "pending", approvalOnly = false, compact = false }) {
  status = String(status || "pending").toLowerCase();
  const steps = STEPS(status).filter((step) => !approvalOnly || step.id !== "completed");
  const current = indexFor(status);

  return (
    <ol className="relative flex list-none items-start justify-between gap-1 p-0">
      {/* The spine sits behind the nodes and stops level with their centres. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 right-0 ${compact ? "top-[0.875rem]" : "top-[1.125rem]"} h-0.5 bg-line/12`}
      />

      {steps.map((step, idx) => {
        const isPast = idx < current;
        const isCurrent = idx === current;
        const track = STATUS_TRACK[step.id] || STATUS_TRACK.pending;

        const done = isPast || (isCurrent && (step.id === "approved" || step.id === "completed"));
        const failed = isCurrent && (step.id === "rejected" || step.id === "revoked");

        let nodeStyle = { borderColor: "rgb(var(--c-line) / .15)" };
        if (isPast) {
          nodeStyle = {
            background: `color-mix(in srgb, ${STATUS_TRACK.approved} 18%, transparent)`,
            borderColor: STATUS_TRACK.approved,
            color: STATUS_TRACK.approved,
          };
        } else if (isCurrent) {
          nodeStyle = {
            background: `color-mix(in srgb, ${track} 18%, transparent)`,
            borderColor: track,
            color: track,
            boxShadow: `0 0 0 ${compact ? "3px" : "4px"} color-mix(in srgb, ${track} 18%, transparent)`,
          };
        }

        return (
          <li key={step.id} className={`relative z-10 flex flex-1 flex-col items-center ${compact ? "gap-1" : "gap-2"}`}>
            <span
              style={nodeStyle}
              className={`flex items-center justify-center rounded-full border-2 bg-surface font-display font-bold text-muted ${
                compact ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-xs"
              }`}
            >
              {failed ? (
                <IconX className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
              ) : done ? (
                <IconCheck className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
              ) : (
                idx + 1
              )}
            </span>

            <span
              style={isCurrent ? { color: track } : undefined}
              className={`text-center font-semibold leading-tight ${
                compact ? "text-[10.5px] max-w-[6.5rem]" : "text-[11px]"
              } ${isCurrent ? "" : isPast ? "text-ink" : "text-muted"}`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
