import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { outcomesDue } from "../../services/research";
import { verificationMeta } from "../../utils/research";
import { trackOf } from "../teacher/status";
import { IconChevronDown, IconClock, IconCopy } from "../teacher/icons";

/**
 * Other records that claim the same work. A co-authored paper recorded for
 * each author is expected; the same faculty member twice is a real duplicate.
 * `linkTo(id)` links each to the viewer's record page, or null.
 */
export function DuplicateNotice({ duplicates = [], linkTo, title = "Also recorded elsewhere" }) {
  if (!duplicates.length) return null;
  const same = duplicates.some((d) => d.same_faculty);
  return (
    <section className="flex items-start gap-3 rounded-2xl border px-5 py-4" data-tint="" style={{ "--track": trackOf("under_review") }} role="note">
      <IconCopy className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("under_review") }} />
      <div className="min-w-0">
        <h2 className="h3 text-base text-ink">{same ? "This may be a duplicate" : title}</h2>
        <p className="prose-muted mt-0.5 text-xs">
          {same
            ? "The same faculty member already has a record of this work. Check before submitting both."
            : "Other faculty members have recorded the same work — usual for co-authors, worth a glance otherwise."}
        </p>
        <ul className="mt-2 list-none space-y-1 p-0 text-sm">
          {duplicates.map((d) => {
            const text = (
              <>
                <span className="font-medium">{d.title}</span> — {d.faculty_name}
                <span className="text-muted"> · same {d.match} · {verificationMeta(d.verification_status).label}</span>
              </>
            );
            const to = linkTo?.(d.id);
            return (
              <li key={d.id} className="text-ink">
                {to ? (
                  <Link to={to} className="hover:text-accent">
                    {text}
                  </Link>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** What the record is waiting on (a patent due for publication ...). */
export function RemindersNotice({ reminders = [], editTo }) {
  if (!reminders.length) return null;
  return (
    <section className="flex items-start gap-3 rounded-2xl border px-5 py-4" data-tint="" style={{ "--track": trackOf("pending") }} role="note">
      <IconClock className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("pending") }} />
      <div className="min-w-0 flex-1">
        <h2 className="h3 text-base text-ink">Needs an update</h2>
        <ul className="mt-1 list-none space-y-1 p-0 text-sm text-ink">
          {reminders.map((r) => (
            <li key={r.key}>{r.message}</li>
          ))}
        </ul>
      </div>
      {editTo && (
        <Link to={editTo} className="btn btn-ghost btn-xs shrink-0">
          Update
        </Link>
      )}
    </section>
  );
}

/**
 * The portfolio's "Outcomes due" list: every record waiting on an update,
 * collapsed to a few until opened. Hidden when nothing is due.
 */
export function OutcomesDuePanel({ base, showFaculty = false }) {
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    outcomesDue()
      .then((body) => live && setItems(body.items || []))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, []);

  if (!items?.length) return null;
  const shown = open ? items : items.slice(0, 3);

  return (
    <section className="glass mt-5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-accent/5"
      >
        <span className="icon-tile icon-tile-track h-9 w-9 shrink-0 rounded-xl" style={{ "--track": trackOf("pending") }}>
          <IconClock className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">
            Outcomes due · {items.length} {items.length === 1 ? "record needs" : "records need"} an update
          </span>
          <span className="block text-xs text-muted">Patents due for publication, papers since published, idle drafts.</span>
        </span>
        <IconChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      <ul className="list-none border-t hairline p-0">
        {shown.map((item) => (
          <li key={item.id} className="border-b hairline last:border-b-0">
            <Link to={`${base}/${item.id}`} className="block px-5 py-3 transition hover:bg-accent/5">
              <span className="block text-sm font-medium text-ink">
                {item.title}
                {showFaculty && item.faculty?.name && <span className="font-normal text-muted"> — {item.faculty.name}</span>}
              </span>
              <span className="block text-xs text-muted">{item.reminders[0]?.message}</span>
            </Link>
          </li>
        ))}
      </ul>
      {items.length > 3 && !open && (
        <button type="button" onClick={() => setOpen(true)} className="w-full border-t hairline px-5 py-2.5 text-xs font-semibold text-accent">
          Show all {items.length}
        </button>
      )}
    </section>
  );
}
