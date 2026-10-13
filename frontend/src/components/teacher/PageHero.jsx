import RidgeCanvas from "../landing/RidgeCanvas";

/**
 * The hero that opens every Teacher, Dean and Super Admin screen — the
 * landing page's hero at working size, so the whole application shares one:
 * drifting ridgelines under the same grid and vignette, an eyebrow, the
 * uppercase Sora title with its gradient-clipped word, the tagline in the
 * display face, and the page's actions in the second column (below the text
 * on a phone, as on the landing page).
 *
 * `children` is an optional full-width row under the title — the event pages
 * put their date / venue / time facts there.
 *
 * `compact` is for a page about one record (an event) rather than a section
 * of the app: the title drops to a heading size and takes the full width,
 * with the actions in a narrow column beside it. A long event name at full
 * hero size ran to five lines and pushed the record itself below the fold.
 *
 * `toolbar` (with `compact`) is for a section whose filters sit beside its
 * short title: the title keeps its own width and the actions take the rest
 * of the row, wrapping within it -- no empty strip, and no squeezed title.
 */
export default function PageHero({
  eyebrow,
  title,
  accent,
  subtitle,
  actions,
  children,
  compact = false,
  toolbar = false,
}) {
  return (
    <section className={`page-hero reveal ${compact ? "page-hero-compact" : ""}`}>
      <RidgeCanvas />
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-vignette-page" aria-hidden="true" />

      <div className={`relative z-10 ${compact ? "p-5 sm:p-6" : "p-6 sm:p-8"}`}>
        <div
          className={`grid grid-cols-1 lg:items-end ${
            compact && toolbar
              ? "gap-3 md:grid-cols-[max-content_minmax(0,1fr)] md:items-center md:gap-6"
              : compact
                ? "gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6"
                : "gap-5 lg:grid-cols-[1.15fr_0.85fr] lg:gap-8"
          }`}
        >
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h1 className={`hero-title page-hero-title uppercase text-ink ${toolbar ? "whitespace-nowrap" : "mt-2"}`}>
              {title}
              {accent && (
                <>
                  {" "}
                  {/* inline-block so the gradient spans the word itself and
                      reaches amber on its last letter, as on the landing page. */}
                  <span className="hero-accent inline-block">{accent}</span>
                </>
              )}
            </h1>
            {subtitle && (
              <p
                className={`font-display font-medium text-ink/90 ${
                  compact ? "mt-2 text-sm" : "mt-3 max-w-2xl text-base sm:text-lg"
                }`}
              >
                {subtitle}
              </p>
            )}
          </div>

          {actions && (
            <div className="flex min-w-0 flex-wrap gap-3 lg:justify-end">{actions}</div>
          )}
        </div>

        {children && <div className={`relative ${compact ? "mt-4" : "mt-6"}`}>{children}</div>}
      </div>
    </section>
  );
}
