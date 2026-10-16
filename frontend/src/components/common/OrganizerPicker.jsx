import { useState } from "react";
import Combobox from "./Combobox";
import { IconX } from "../teacher/icons";
import { MAX_ORGANIZERS, MAX_ORGANIZER_NAME_LENGTH } from "../../utils/organizers";

/** Directory choices and guest names, using the form's existing combobox. */
export default function OrganizerPicker({ value = [], onChange, onSelect, query, onQueryChange, options = [], loading, disabled, error }) {
  const [addError, setAddError] = useState("");
  const selected = new Set(value.map((name) => name.toLocaleLowerCase()));
  const add = (option) => {
    const name = option.name.trim();
    if (!name) return;
    if (name.length > MAX_ORGANIZER_NAME_LENGTH) {
      setAddError("Each organizer name must be 120 characters or fewer.");
      return;
    }
    if (selected.has(name.toLocaleLowerCase())) {
      onQueryChange("");
      return;
    }
    if (value.length >= MAX_ORGANIZERS) {
      setAddError("Select no more than 20 organizers.");
      return;
    }
    setAddError("");
    onSelect({ ...option, name });
  };

  return (
    <div className="space-y-2">
      <Combobox
        id="organizer" label="Organizer / Faculty Coordinator" required
        value={query} onChange={(text) => { onQueryChange(text); setAddError(""); }}
        onSelect={add} options={options.filter((option) => !selected.has(option.name.toLocaleLowerCase()))}
        loading={loading} placeholder="Search or enter an organizer name" disabled={disabled}
        error={addError || error} hint="Select at least one organizer. You can add more than one."
        emptyHint="Enter a name and use Add organizer."
        renderOption={(option) => (
          <span className="flex items-baseline justify-between gap-3">
            <span>{option.name}</span><span className="prose-muted text-xs">{option.phone}</span>
          </span>
        )}
      />
      {query.trim() && (
        <button type="button" className="btn btn-ghost btn-xs" disabled={disabled}
          onClick={() => add(options.find((option) => option.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase()) || { name: query })}>
          Add organizer
        </button>
      )}
      {value.length > 0 && (
        <ul aria-label="Selected organizers" className="flex list-none flex-wrap gap-2 p-0">
          {value.map((name) => (
            <li key={name.toLocaleLowerCase()} className="inline-flex max-w-full items-center gap-2 rounded-lg border hairline bg-raised px-2.5 py-1.5 text-sm">
              <span className="min-w-0 break-words">{name}</span>
              <button type="button" aria-label={`Remove organizer ${name}`} disabled={disabled}
                className="shrink-0 text-muted hover:text-ink"
                onClick={() => { setAddError(""); onChange(value.filter((item) => item !== name)); }}>
                <IconX className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
