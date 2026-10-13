import { summariseHistory } from "../../utils/research";

const ROLE_LABEL = { teacher: "Teacher", event_manager: "Event Manager", dean: "Dean" };

const dateFmt = { day: "numeric", month: "short", year: "numeric" };
const timeFmt = { hour: "numeric", minute: "2-digit" };

/** "10 Oct 2026, 9:42 pm", or "10 Oct 2026, 9:42 – 10:04 pm" for a sitting. */
function when(firstIso, lastIso) {
  const first = new Date(firstIso);
  const last = new Date(lastIso);
  if (Number.isNaN(first.getTime())) return "";
  const day = first.toLocaleDateString("en-IN", dateFmt);
  const start = first.toLocaleTimeString("en-IN", timeFmt);
  if (Number.isNaN(last.getTime()) || last.getTime() - first.getTime() < 60 * 1000) return `${day}, ${start}`;
  if (last.toDateString() !== first.toDateString()) {
    return `${day}, ${start} – ${last.toLocaleDateString("en-IN", dateFmt)}, ${last.toLocaleTimeString("en-IN", timeFmt)}`;
  }
  return `${day}, ${start} – ${last.toLocaleTimeString("en-IN", timeFmt)}`;
}

/**
 * The record's activity, newest first, one line per sitting: steps the same
 * person took together are merged, and only notes that add something (the
 * Dean's remarks, the file attached) are shown under them.
 */
export default function ResearchTimeline({ history = [] }) {
  const rows = summariseHistory(history);
  if (rows.length === 0) return <p className="prose-muted text-sm">No activity yet.</p>;

  return (
    <ol className="relative list-none space-y-3.5 p-0 pl-5">
      <span className="absolute bottom-1.5 left-[5px] top-1.5 w-px bg-line/15" aria-hidden="true" />
      {rows.map((row, index) => (
        <li key={`${row.first_at}-${index}`} className="relative">
          <span className="dot dot-sm absolute -left-5 top-1.5" style={{ "--track": row.track }} aria-hidden="true" />
          <p className="text-sm text-ink">
            <span className="font-semibold">{row.actor_name || "Someone"}</span>
            {row.actor_role && <span className="text-muted"> ({ROLE_LABEL[row.actor_role] || row.actor_role})</span>}{" "}
            {row.text}
            <span className="prose-muted ml-2 whitespace-nowrap text-xs">{when(row.first_at, row.last_at)}</span>
          </p>
          {row.notes.length > 0 && (
            <ul className="mt-1 list-none space-y-1 p-0">
              {row.notes.map((note) => (
                <li
                  key={note}
                  className="w-fit max-w-full whitespace-pre-line rounded-lg border px-3 py-1.5 text-xs text-ink"
                  data-tint=""
                  style={{ "--track": row.track }}
                >
                  {note}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
