import { Link } from "react-router-dom";
import { IconArrowRight } from "../teacher/icons";

/**
 * The one KPI card every dashboard uses — Teacher, Dean and Super Admin — so
 * the three read as one product: label and icon on top, the count, then a
 * one-line hint. With `to` the whole card is a link and the hint gets an
 * arrow; without it the card is static and does not lift on hover.
 *
 * `track` is the hex the count, icon tile and top edge are tinted from, the
 * same `--track` convention the status chips use.
 *
 * A `to` of "#id" jumps to that section of the same page (a plain anchor;
 * the router does not scroll to hashes).
 *
 * `compact` draws a smaller box -- tighter padding, a smaller count and
 * icon -- for a row of figures above a list rather than a dashboard.
 */
export default function StatCard({ label, value, Icon, track, hint, to, index = 0, compact = false }) {
  const inPage = typeof to === "string" && to.startsWith("#");
  const Tag = to ? (inPage ? "a" : Link) : "div";

  return (
    <Tag
      {...(inPage ? { href: to } : to ? { to } : {})}
      style={{ "--track": track, "--i": index + 1 }}
      className={`stat-card reveal group rounded-2xl ${compact ? "px-3 py-2.5" : "p-3.5 sm:p-4"} ${to ? "" : "is-static"}`}
    >
      <div className="relative flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted sm:text-sm">{label}</p>
        {Icon && (
          <span
            className={`icon-tile icon-tile-track shrink-0 rounded-lg ${
              compact ? "h-6 w-6 [&>svg]:h-3.5 [&>svg]:w-3.5" : "h-8 w-8 [&>svg]:h-4 [&>svg]:w-4"
            }`}
          >
            <Icon />
          </span>
        )}
      </div>

      <p
        className={`stat-num relative ${compact ? "mt-0.5 text-xl sm:text-[1.375rem]" : "mt-1 text-[1.75rem] sm:text-[2rem]"}`}
        style={{ color: track }}
      >
        {value}
      </p>

      {hint && (
        <p
          className={`relative ${compact ? "mt-1" : "mt-1.5"} flex min-w-0 items-center gap-1 text-xs font-medium text-muted ${
            to ? "transition group-hover:text-ink" : ""
          }`}
          title={hint}
        >
          <span className="truncate">{hint}</span>
          {to && (
            <IconArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
          )}
        </p>
      )}
    </Tag>
  );
}
