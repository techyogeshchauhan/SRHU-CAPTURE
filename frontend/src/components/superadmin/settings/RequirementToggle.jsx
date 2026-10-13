/**
 * The mandatory / optional switch for one upload kind.
 *
 * On means a teacher cannot submit an event for approval until at least one
 * file of this kind is attached; the server enforces the same rule on submit.
 */
export default function RequirementToggle({ id, noun, value, disabled, onChange }) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border hairline bg-raised/40 p-4">
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-semibold text-ink">
          {value ? "Mandatory upload" : "Optional upload"}
        </p>
        <p id={hintId} className="mt-0.5 text-xs text-muted">
          {value
            ? `On: at least one ${noun} must be uploaded before an event can be submitted.`
            : `Off: events can be submitted with or without a ${noun}.`}
        </p>
      </div>

      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
          value ? "bg-accent" : "bg-muted/40"
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-5 w-5 rounded-full bg-surface shadow transition-transform ${
            value ? "translate-x-5.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
