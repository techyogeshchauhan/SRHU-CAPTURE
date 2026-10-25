/**
 * Shades for the "Programs by type" breakdown on the Dean dashboard.
 *
 * The chart's job is part-to-whole magnitude, not identity: every slice is
 * named in the list beside the ring, so the colour never has to tell two
 * programs apart on its own. That makes this a **sequential** ramp — one hue,
 * more-is-darker — rather than a categorical palette, which is what the twelve
 * cycled hex codes used to be. Cycling was also unstable: a colour was picked
 * by array index, so filtering the list repainted every remaining slice.
 *
 * One hue keeps it colour-blind safe by construction and keeps it on theme in
 * both modes, because the alpha resolves against the live `--c-accent`
 * (deep sky on light, glacier cyan on dark).
 */

/** Strongest first; the ramp is applied in descending share order. */
const RAMP = [1, 0.82, 0.66, 0.52, 0.4, 0.3];

/** The tail shade, for the unlikely case of more program types than steps. */
const TAIL = 0.22;

export const alphaAt = (rank) => RAMP[rank] ?? TAIL;

/**
 * `accentRgb` is the resolved `--c-accent` channel triplet ("3 105 161").
 * SVG presentation attributes cannot be relied on to substitute `var()`, so
 * the chart is handed concrete colours and re-reads them on a theme change.
 */
export const shadeAt = (rank, accentRgb) =>
  `rgb(${accentRgb} / ${alphaAt(rank)})`;

/**
 * Events per program type, largest share first, each with its shade, from the
 * counts the server makes ({"Workshop": 4, "workshop": 1, "Seminar": 2}) --
 * so the dashboard need not download every event to draw it. Types are
 * matched case-insensitively so "Workshop" and "workshop" are one row rather
 * than two.
 */
export function programShareFromCounts(typeCounts, accentRgb) {
  const counts = new Map();

  for (const [type, value] of Object.entries(typeCounts || {})) {
    const raw = String(type ?? "").trim();
    const amount = Number(value) || 0;
    if (!raw || amount <= 0) continue;

    const key = raw.toLowerCase();
    const existing = counts.get(key);

    if (existing) existing.value += amount;
    else counts.set(key, { name: raw, value: amount });
  }

  return [...counts.values()]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .map((entry, index) => ({ ...entry, shade: shadeAt(index, accentRgb) }));
}
