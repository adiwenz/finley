/**
 * The shared "months from now" x-axis every projection chart draws on.
 *
 * **`x = 0` is TODAY** — the pre-flow {@link import("@finley/engine").ProjectionSeries.opening}
 * state. A processed month `m` plots at `m + 1`, so `x` reads as "months from now" and
 * end-of-month-0 sits a genuine month to the right of today rather than collapsing onto it,
 * where the step between them would look like a rendering artifact.
 *
 * Charts of **stocks** (net worth, the breakdown's balances) draw a point at {@link TODAY_X}
 * from `opening`. Charts of **flows** (income, budget, tax) leave that slot empty: today is an
 * instant, and no flow has run yet — nothing honest goes there. The slot is still reserved, so
 * every chart's `x` means the same instant and the shared selection rule, the broke marker and
 * the retirement rule land in the same place on all of them.
 *
 * Everything that crosses a chart boundary — `selectedMonth`, `firstInsolventMonth`,
 * `retirementMonth` — is a MODEL month. Convert at the Recharts boundary and nowhere else:
 * {@link toAxisX} on the way in, {@link fromAxisX} on the way back out of a click.
 */

/** Where `opening` plots: net worth as it stands right now, before any flow. */
export const TODAY_X = 0;

/** Model month → axis position. Month 0 (the first processed month) draws at x=1. */
export function toAxisX(month: number): number {
  return month + 1;
}

/**
 * Axis position → model month. Clamped at 0: a click landing on {@link TODAY_X} selects the
 * first processed month, since "today" is not a month anything can be edited at.
 */
export function fromAxisX(x: number): number {
  return Math.max(0, x - 1);
}

/**
 * A data point's tooltip heading. x=0 is the opening state; every later x is the END of
 * processed month x−1.
 *
 * `describeMonth` supplies the plan-year suffix ("Year 3 (2029)") a caller wants appended;
 * pass {@link import("./format").monthLabel} for the standard one.
 */
export function axisPointLabel(x: number, describeMonth?: (month: number) => string): string {
  if (x <= TODAY_X) return "Today · now, before any flow";
  const month = x - 1;
  const suffix = describeMonth ? ` · ${describeMonth(month)}` : "";
  return `End of month ${month}${suffix}`;
}

/**
 * Year-boundary tick positions, `[TODAY_X, toAxisX(12), toAxisX(24), …]` up to `maxX`.
 *
 * Ticks must be supplied explicitly for two reasons. Recharts' auto-placement lands them on
 * fractional-year positions that round to the same label (two "yr 1"s). And a tick is only
 * honest where a plan year actually STARTS — `toAxisX(12 * n)`, i.e. `12n + 1` — not at the
 * round number `12n`, which on this axis holds the last month of the PREVIOUS year. Labelling
 * `x = 12` as "yr 1" while the tooltip on the same pixel reads "End of month 11 · Year 0" is
 * exactly the contradiction {@link axisYearTickLabel} exists to prevent.
 *
 * Spacing widens with span: every year when zoomed in, every 5th or 10th across a full
 * 55-year horizon.
 */
export function yearTickXs(maxX: number): number[] {
  const spanYears = Math.max(1, maxX / 12);
  const stepYears = spanYears <= 6 ? 1 : spanYears <= 15 ? 2 : spanYears <= 35 ? 5 : 10;
  const ticks: number[] = [TODAY_X];
  for (let month = 0; toAxisX(month) <= maxX; month += stepYears * 12) ticks.push(toAxisX(month));
  return ticks;
}

/**
 * A year tick's label. Goes through the caller's `yearOf` so every surface naming a year
 * agrees — `format.ts` documents that rule, and the bug it prevents (the same month called
 * "year 45" on one surface and "Year 44" on another).
 */
export function axisYearTickLabel(x: number, yearOf: (month: number) => number): string {
  return x <= TODAY_X ? "now" : `yr ${yearOf(fromAxisX(x))}`;
}
