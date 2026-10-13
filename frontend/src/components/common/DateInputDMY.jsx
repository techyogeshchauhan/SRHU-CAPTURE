import { useRef, useState } from "react";

import { IconCalendar } from "../teacher/icons";
import { dmyToIso, isoToDmy, maskDmy } from "../../utils/dates";

/**
 * A date field that reads and writes dd/mm/yyyy, whatever language the browser
 * is set to. A native <input type="date"> shows the browser's own order
 * (mm/dd/yyyy on an English-US machine), which is not how dates are written
 * here.
 *
 * `value` and the reported value stay "YYYY-MM-DD" -- the form, the API and
 * every comparison keep the canonical string. Typing fills the slashes in; the
 * calendar button opens the browser's own picker, bounded by `min` / `max`.
 * An incomplete or impossible date reports "", so the form's required-field
 * check catches it.
 *
 * `onChange` receives an event-shaped `{ target: { name, value } }`, so it
 * drops in where a native input's handler was.
 */
export default function DateInputDMY({
  id,
  name,
  value = "",
  onChange,
  min,
  max,
  disabled = false,
  autoFocus = false,
  ariaInvalid,
  className = "input min-h-10 py-2",
}) {
  const [text, setText] = useState(() => isoToDmy(value));
  const [lastValue, setLastValue] = useState(value);
  const pickerRef = useRef(null);

  // Follow changes made from outside (a draft loading, the start date moving
  // the end date along) without fighting what is being typed: adjusted during
  // render, React's pattern for state that tracks a prop.
  if (value !== lastValue) {
    setLastValue(value);
    if (dmyToIso(text) !== value) setText(isoToDmy(value));
  }

  const report = (iso) => onChange?.({ target: { name, value: iso } });

  const handleType = (event) => {
    const next = maskDmy(event.target.value);
    setText(next);
    const iso = dmyToIso(next);
    if (iso !== value) report(iso);
  };

  const handlePick = (event) => {
    const iso = event.target.value;
    setText(isoToDmy(iso));
    report(iso);
  };

  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker || disabled) return;
    try {
      picker.showPicker();
    } catch {
      picker.focus();
      picker.click();
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        onChange={handleType}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={ariaInvalid}
        aria-describedby={id ? `${id}-format` : undefined}
        className={`${className} pr-11`}
      />
      <span id={id ? `${id}-format` : undefined} className="sr-only">
        Date in day, month, year order
      </span>
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        className="icon-btn icon-btn-sm absolute right-1.5 top-1/2 h-8 w-8 -translate-y-1/2 text-muted hover:text-accent"
        aria-label="Choose a date from the calendar"
        title="Choose from calendar"
      >
        <IconCalendar className="h-4 w-4" />
      </button>
      {/* The browser's calendar, kept out of sight; the button opens it. */}
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value || ""}
        min={min}
        max={max}
        onChange={handlePick}
        disabled={disabled}
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}
