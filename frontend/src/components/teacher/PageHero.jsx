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
 */
export default function PageHero({ eyebrow, title, accent, subtitle, actions, children, compactTitle = false }) {
  return (
    <section className="page-hero reveal">
      <RidgeCanvas />
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-vignette-page" aria-hidden="true" />

      <div className={`page-hero-content relative z-10 ${compactTitle ? "p-5 sm:p-6" : "p-6 sm:p-8"}`}>
        <div className={`page-hero-layout ${compactTitle ? "flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6" : "grid grid-cols-1 gap-5 lg:grid-cols-[1.15fr_0.85fr] lg:items-end lg:gap-8"}`}>
          <div className={`page-hero-copy min-w-0 ${compactTitle ? "flex-1" : ""}`}>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h1 className={compactTitle ? "mt-2 break-words font-display text-xl font-semibold leading-snug text-ink sm:text-2xl" : "hero-title page-hero-title mt-2 uppercase text-ink"}>
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
              <p className={`page-hero-subtitle ${compactTitle ? "mt-2 break-words text-sm text-ink/90" : "mt-3 max-w-2xl font-display text-base font-medium text-ink/90 sm:text-lg"}`}>
                {subtitle}
              </p>
            )}
          </div>

          {actions && (
            <div className={`page-hero-actions flex min-w-0 flex-wrap gap-3 lg:justify-end ${compactTitle ? "shrink-0" : ""}`}>{actions}</div>
          )}
        </div>

        {children && <div className="page-hero-facts relative mt-6">{children}</div>}
      </div>
    </section>
  );
}
