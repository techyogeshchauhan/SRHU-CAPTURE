import { useEffect, useId, useRef, useState } from "react";

import { IconCheck, IconChevronDown } from "../teacher/icons";

/**
 * A dropdown that holds several choices: one compact field showing what is
 * chosen ("Scopus, PubMed"), opening to a list of checkboxes.
 *
 * Closes on a click outside or Escape. `value` is the array of chosen
 * options, in the options' own order; `onChange` receives the new array.
 */
export default function MultiSelectDropdown({
  id,
  options = [],
  value = [],
  onChange,
  placeholder = "Choose…",
  invalid = false,
  disabled = false,
  labelledBy,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const listId = useId();
  const chosen = options.filter((option) => value.includes(option));

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        wrapRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (option) => {
    const next = value.includes(option) ? value.filter((v) => v !== option) : [...value, option];
    onChange(options.filter((o) => next.includes(o)));
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
        aria-invalid={invalid ? "true" : undefined}
        className="input flex items-center gap-2 pr-3 text-left"
      >
        <span className={`min-w-0 flex-1 truncate ${chosen.length ? "text-ink" : "text-muted/80"}`}>
          {chosen.length ? chosen.join(", ") : placeholder}
        </span>
        {chosen.length > 1 && (
          <span className="tab-count shrink-0" aria-hidden="true">
            {chosen.length}
          </span>
        )}
        <IconChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          className="absolute left-0 right-0 z-30 mt-1.5 max-h-72 list-none overflow-y-auto rounded-xl border hairline bg-surface p-1.5 shadow-xl"
        >
          {options.map((option) => {
            const on = value.includes(option);
            return (
              <li key={option} role="option" aria-selected={on}>
                <button
                  type="button"
                  onClick={() => toggle(option)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-accent/10 ${
                    on ? "font-medium text-ink" : "text-ink"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      on ? "border-accent bg-accent text-white" : "border-line/30"
                    }`}
                    aria-hidden="true"
                  >
                    {on && <IconCheck className="h-3 w-3" />}
                  </span>
                  {option}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
