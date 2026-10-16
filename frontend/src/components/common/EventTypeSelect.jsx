import { useId, useState } from "react";

import Modal from "../teacher/Modal";
import ManageEventTypesModal from "./ManageEventTypesModal";

/**
 * Event category picker (PRD 4 / 14).
 *
 * The list comes from the server, so a category a teacher adds here is
 * immediately selectable by everyone — including in the Dean's filter, which
 * is what the old hardcoded copies could not do.
 *
 * "+ Add event type" is a button below the select rather than an <option>:
 * an option that acts like a button cannot be reached the same way by
 * keyboard and screen readers announce it as a choice, not an action.
 */
function EventTypeSelect({
  value,
  customValue,
  onChange,
  onCustomChange,
  types,
  loading,
  onAddType,
  disabled,
  error,
  customError,
  canManageTypes = false,
}) {
  const selectId = useId();
  const customId = useId();

  const [addOpen, setAddOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState("");

  const isOther = value === "Other";
  // An event saved with a custom type ("Other" + text) carries that text as
  // its type. The list is fetched once per session, so a type saved since --
  // or one the list does not have -- must still be offered, or the select
  // shows "Select type" and the saved choice is lost on the next save.
  const unlisted = value && value !== "Other" && !types.includes(value) ? value : null;

  const submitNewType = async () => {
    const label = newLabel.trim();
    if (!label) {
      setAddError("Enter a name for the new event type.");
      return;
    }

    setSaving(true);
    setAddError("");
    const created = await onAddType(label);
    setSaving(false);

    if (!created) {
      setAddError("Could not add that event type. Please try again.");
      return;
    }

    onChange(created);
    setAddOpen(false);
    setNewLabel("");
  };

  return (
    <div className="field">
      <label htmlFor={selectId}>
        Event Type<span className="req">*</span>
      </label>

      <select
        id={selectId}
        name="eventType"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || loading}
        aria-invalid={error ? "true" : undefined}
        className="input min-h-10 py-2"
      >
        <option value="">{loading ? "Loading types…" : "Select type"}</option>
        {types.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
        {unlisted && <option value={unlisted}>{unlisted}</option>}
        {/* Always offered, even if the server list happens to include it. */}
        {!types.includes("Other") && <option value="Other">Other</option>}
      </select>

      {error && <p className="field-error">{error}</p>}

      <button
        type="button"
        onClick={() => {
          setNewLabel("");
          setAddError("");
          setAddOpen(true);
        }}
        disabled={disabled}
        className="btn btn-ghost btn-xs mt-1 self-start"
      >
        + Add event type
      </button>

      {canManageTypes && <button type="button" className="btn btn-ghost btn-xs mt-1 self-start"
        disabled={disabled} onClick={() => setManageOpen(true)}>Manage event types</button>}
      {manageOpen && <ManageEventTypesModal onClose={() => setManageOpen(false)} onChanged={(result) => {
        const current = (value === "Other" ? customValue : value) || "";
        if (result.previous_names.some((name) => name.toLowerCase() === current.toLowerCase())) {
          onChange(result.event_type);
          onCustomChange("");
        }
      }} />}

      {isOther && (
        <div className="mt-2">
          <label htmlFor={customId} className="text-xs font-medium text-muted">
            Describe the event type<span className="req">*</span>
          </label>
          <input
            id={customId}
            name="eventTypeOther"
            type="text"
            value={customValue}
            onChange={(event) => onCustomChange(event.target.value)}
            placeholder="e.g. Alumni Meet"
            disabled={disabled}
            maxLength={60}
            aria-invalid={customError ? "true" : undefined}
            className="input mt-1 min-h-10 py-2"
          />
          <p className="prose-muted text-xs">
            Saved with the event. Use “+ Add event type” instead to make it
            available to everyone from now on.
          </p>
          {customError && <p className="field-error">{customError}</p>}
        </div>
      )}

      <Modal
        open={addOpen}
        onClose={() => !saving && setAddOpen(false)}
        eyebrow="Event types"
        title="Add a new event type"
        subtitle="It becomes selectable for every teacher, and the Dean can filter by it."
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setAddOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-brand btn-sm"
              onClick={submitNewType}
              disabled={saving}
            >
              {saving && <span className="spin h-3.5 w-3.5" />}
              {saving ? "Saving…" : "Save event type"}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor={`${selectId}-new`}>Name</label>
          <input
            id={`${selectId}-new`}
            type="text"
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitNewType();
              }
            }}
            placeholder="e.g. Hackathon"
            maxLength={60}
            autoFocus
            className="input"
          />
          {addError && <p className="field-error">{addError}</p>}
        </div>
      </Modal>
    </div>
  );
}

export default EventTypeSelect;
