/**
 * The chrome every settings section shares: tinted icon tile, eyebrow, heading
 * and an optional chip listing the formats the section governs.
 */
export default function SettingsCard({
  icon,
  eyebrow,
  title,
  chip,
  description,
  index = 1,
  children,
}) {
  return (
    <section className="glass reveal flex flex-col p-5 sm:p-7" style={{ "--i": index }}>
      <div className="flex items-center justify-between gap-3 border-b hairline pb-4">
        <div className="flex items-center gap-3">
          <span
            className="icon-tile icon-tile-track"
            style={{ "--track": "rgb(var(--c-accent))" }}
            aria-hidden="true"
          >
            {icon}
          </span>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 className="h3 text-ink">{title}</h2>
          </div>
        </div>
        {chip ? (
          <span className="chip chip-sm bg-accent/10 font-medium text-accent">{chip}</span>
        ) : null}
      </div>

      {description ? (
        <p className="prose-muted mt-4 text-xs sm:text-sm">{description}</p>
      ) : null}

      <div className="mt-6 space-y-5">{children}</div>
    </section>
  );
}
