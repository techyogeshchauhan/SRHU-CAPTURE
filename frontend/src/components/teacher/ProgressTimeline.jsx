import { useMemo } from "react";
import { buildTimeline, describeEntry } from "../../utils/eventHistory";
import { isPendingStatus, trackOf } from "./status";

const ROLE_LABEL = { teacher: "Teacher", dean: "Dean", admin: "Admin", superadmin: "Super Admin", event_manager: "Event Manager" };

const WAITING_TRACK = "#64748B"; // slate: a step that has not happened yet

function formatStamp(value) {
  if (!value) return "Date not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date not recorded";
  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The event's full status history, oldest first: every submission, decision
 * and delivery step, who took it, and anything the Dean wrote alongside it.
 *
 * `viewerId` turns the viewer's own entries into "by you". `perspective`
 * words the trailing waiting step for whoever is reading — a teacher is
 * waiting on the Dean, a Dean is the one being waited on.
 */
export default function ProgressTimeline({ event, viewerId, perspective = "teacher", compact = false }) {
  const timeline = useMemo(() => buildTimeline(event), [event]);

  if (timeline.length === 0) {
    return <p className="prose-muted text-sm">No updates recorded for this event yet.</p>;
  }

  const inferred = timeline.some((entry) => entry.inferred);
  const awaitingReview = isPendingStatus(String(event?.status ?? "").toLowerCase());

  const actorLine = (entry) => {
    if (viewerId && entry.actor_id === viewerId) return "by you";

    const role = ROLE_LABEL[entry.actor_role];

    if (entry.actor_name) return `by ${entry.actor_name}${role ? ` · ${role}` : ""}`;

    return role ? `by the ${role}` : null;
  };

  return (
    <>
      <ol className={`tl ${compact ? "!gap-2" : ""}`} aria-label="Event history">
        {timeline.map((entry, index) => {
          const { label, tone } = describeEntry(entry);
          const track = trackOf(tone);
          const latest = index === timeline.length - 1 && !awaitingReview;
          const who = actorLine(entry);

          return (
            <li key={entry.key} className="tl-row" style={{ "--track": track }}>
              <span className={`tl-node ${compact ? "!top-[0.8rem] !h-2.5 !w-2.5" : ""}`} aria-hidden="true" />

              <div className={`tl-card ${compact ? "!py-2 !px-3 !rounded-xl" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`font-display font-semibold text-ink ${compact ? "text-xs" : "text-sm"}`}>
                    {label}
                  </span>
                  {latest && (
                    <span className={`chip chip-solid ${compact ? "chip-xs !py-0 text-[10px]" : "chip-sm"}`}>
                      Latest
                    </span>
                  )}
                </div>

                <p className={`flex flex-wrap items-center gap-x-2 text-muted ${compact ? "mt-0.5 text-[11px]" : "mt-1 text-xs"}`}>
                  <time className={`tl-time ${compact ? "text-[11px]" : ""}`} dateTime={entry.created_at || undefined}>
                    {formatStamp(entry.created_at)}
                  </time>
                  {who && <span>{who}</span>}
                </p>

                {entry.note && (
                  <blockquote
                    data-tint=""
                    style={{ "--track": track }}
                    className={`rounded-xl border ${compact ? "mt-2 px-3 py-1.5" : "mt-3 px-3.5 py-2.5"}`}
                  >
                    <span className="block text-[10px] font-semibold uppercase tracking-[.14em] text-muted">
                      {entry.actor_role === "dean" ? "Dean’s remarks" : "Note"}
                    </span>
                    <span className={`block whitespace-pre-line text-ink ${compact ? "mt-0.5 text-xs leading-5" : "mt-1 text-sm leading-6"}`}>
                      {entry.note}
                    </span>
                  </blockquote>
                )}
              </div>
            </li>
          );
        })}

        {/* What happens next, while it is still the Dean's move. Drawn as a
            step not yet taken — a slate node and a dashed card. */}
        {awaitingReview && (
          <li className="tl-row" style={{ "--track": WAITING_TRACK }}>
            <span className={`tl-node ${compact ? "!top-[0.8rem] !h-2.5 !w-2.5" : ""}`} aria-hidden="true" />
            <div className={`rounded-xl border border-dashed border-line/20 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
              <p className={`font-display font-semibold text-ink ${compact ? "text-xs" : "text-sm"}`}>
                Pending Dean review
              </p>
              <p className={`text-muted ${compact ? "mt-0.5 text-[11px]" : "mt-0.5 text-xs"}`}>
                {perspective === "dean"
                  ? "Waiting for your decision."
                  : "The Dean has not decided yet. You will see the outcome, and any remarks, here."}
              </p>
            </div>
          </li>
        )}
      </ol>

      {inferred && (
        <p className="prose-muted mt-4 text-xs">
          This event was submitted before step-by-step tracking began, so its
          history is rebuilt from its latest status. Every update from now on is
          recorded in full.
        </p>
      )}
    </>
  );
}
