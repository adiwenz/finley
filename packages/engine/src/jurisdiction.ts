import type { Cents } from "./money";

/**
 * The jurisdiction interface — the plug-and-play seam (ARCHITECTURE.md, §5.3–5.5).
 *
 * The engine DEFINES what a jurisdiction must supply; it never hardcodes any
 * jurisdiction fact. A `rules` package (e.g. `US-2026`) IMPLEMENTS this. The
 * engine ships the trivial {@link nullJurisdiction} (zero tax, no programs) so
 * it runs and is testable standalone with no rules package present.
 *
 * Slice 0 exposes only the `computeTax` seam. Later slices widen this interface
 * (contribution limits, Social Security benefit, Medicare, RMDs) against the
 * same engine-defines-socket / rules-fills-plug pattern.
 */
export interface JurisdictionContext {
  /** Calendar year the figure applies to; all rules facts are year-parameterized. */
  readonly year: number;
}

export interface Jurisdiction {
  /** Stable identifier, e.g. `"null"` or `"US-2026"`. */
  readonly id: string;

  /**
   * The single tax chokepoint (§5.3 seam 1): taxable income in → tax owed in
   * cents out. v1 implementations may return 0; what matters is that the
   * pipeline calls exactly one replaceable function rather than smearing tax
   * logic across allocation code.
   */
  computeTaxCents(taxableIncomeCents: Cents, ctx: JurisdictionContext): Cents;
}

/**
 * The null jurisdiction: no taxes, no government programs. Lets the engine run
 * end to end on its own (ARCHITECTURE.md Phase 0/1). Never remove it — it is
 * the standalone-runnability guarantee and the baseline for engine-only tests.
 */
export const nullJurisdiction: Jurisdiction = {
  id: "null",
  computeTaxCents: () => 0,
};
