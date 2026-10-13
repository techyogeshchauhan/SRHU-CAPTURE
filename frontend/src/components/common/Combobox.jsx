import { useEffect, useId, useRef, useState } from "react";

/**
 * A text input with a filtered suggestion list.
 *
 * Not a <datalist>: that cannot carry a payload alongside the label — and the
 * whole point here is that picking a coordinator also fills in their mobile
 * number — nor can it be styled to match the rest of the form.
 *
 * `allowCustom` keeps whatever the teacher typed when nothing matches, which
 * is the normal case for a guest coordinator who has no account.
 */
function Combobox({
  id,
  label,
  required,
  value,
  onChange,
  onSelect,
  options,
  loading,
  placeholder,
  disabled,
  error,
  hint,
  emptyHint,
  renderOption,
  // Optional leading glyph, for forms whose other inputs carry one (the
  // registration form). Omitted, the input keeps its usual padding.
  icon,
}) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const listId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapperRef = useRef(null);

  const needle = (value || "").trim().toLowerCase();
  const matches = needle
    ? options.filter((option) => option.name.toLowerCase().includes(needle))
    : options;

  // Close when the click lands outside. `mousedown` rather than `blur` so a
  // click on an option is not cancelled before it registers.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (option) => {
    onSelect?.(option);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        if (matches.length === 0) return -1;
        const next = current + step;
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === "Enter" && open && active >= 0 && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="field" ref={wrapperRef}>
      <label htmlFor={inputId}>
        {label}
        {required && <span className="req">*</span>}
      </label>

      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted">
            {icon}
          </span>
        )}

        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && active >= 0 ? `${inputId}-option-${active}` : undefined
          }
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          className={`input min-h-10 w-full py-2 ${icon ? "pl-10" : ""}`}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />

        {open && (
          <ul
            id={listId}
            role="listbox"
            className="glass absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-xl py-1"
          >
            {loading && (
              <li className="prose-muted px-3 py-2 text-xs">Loading…</li>
            )}

            {!loading && matches.length === 0 && (
              <li className="prose-muted px-3 py-2 text-xs">
                {emptyHint || "No matches."}
              </li>
            )}

            {!loading &&
              matches.map((option, index) => (
                <li
                  key={option.id || option.name}
                  id={`${inputId}-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={`cursor-pointer px-3 py-2 text-sm ${
                    index === active ? "bg-raised" : ""
                  }`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  {renderOption ? renderOption(option) : option.name}
                </li>
              ))}
          </ul>
        )}
      </div>

      {hint && !error && <p className="prose-muted text-xs">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export default Combobox;
