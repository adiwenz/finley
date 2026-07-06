import type { Cents } from "./money";
import type { Jurisdiction, JurisdictionContext } from "./jurisdiction";

/**
 * The projection series — the engine's public output and the chart's data
 * contract (§10.6). One entry per simulated month, starting at the "now"
 * marker (month 0); there is no pre-"now" financial curve (§4.6).
 *
 * Simulate in nominal dollars, report in real dollars (§0.4): every point
 * carries both `netWorthNominalCents` and `netWorthRealCents`, so the chart can
 * draw the real and nominal curves without recomputing the conversion.
 */
export interface ProjectionMonth {
  /** Absolute month index from the financial start ("now" = 0). */
  readonly month: number;
  /** Net worth in nominal cents — what the simulation accumulates. */
  readonly netWorthNominalCents: Cents;
  /** Net worth deflated to today's dollars: nominal / (1 + inflation)^years (§0.4). */
  readonly netWorthRealCents: Cents;
  /** Per-account balances in cents, keyed by account id. Empty until Slice 1 adds accounts. */
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
}

export interface ProjectionSeries {
  readonly months: readonly ProjectionMonth[];
}

/**
 * Slice-0 walking-skeleton input. Deliberately minimal: a horizon, an opening
 * net worth, a flat monthly net cash flow, and an inflation rate for the real
 * conversion. Slice 1 (issue #2) replaces this with real income/expense/account
 * inputs and a compounding pipeline; the {@link ProjectionSeries} output shape
 * is the stable contract that survives that change.
 */
export interface SimulationInput {
  readonly horizonMonths: number;
  readonly openingNetWorthCents: Cents;
  /** Pre-tax net cash flow added each month (income − expenses). */
  readonly monthlyNetFlowCents: Cents;
  readonly annualInflationRate: number;
  /** Calendar year at month 0. Fixed default keeps the engine pure/deterministic (no `Date`). */
  readonly startYear?: number;
}

const DEFAULT_START_YEAR = 2026;

/** real = nominal / (1 + inflation)^years, converted at the reporting layer only (§0.4). */
function toRealCents(
  nominalCents: Cents,
  annualInflationRate: number,
  month: number,
): Cents {
  const years = month / 12;
  return Math.round(nominalCents / Math.pow(1 + annualInflationRate, years));
}

/**
 * Trivial end-to-end projection: proves the engine → jurisdiction → projection
 * wire before any real math lands. No compounding and no accounts yet — it
 * accumulates a flat monthly net flow (after routing it through the
 * jurisdiction's `computeTax` seam, which the null jurisdiction leaves
 * untouched) and reports nominal + real net worth each month.
 *
 * All arithmetic stays in integer cents.
 */
export function simulate(
  input: SimulationInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const months: ProjectionMonth[] = [];

  let nominal = input.openingNetWorthCents;
  for (let month = 0; month <= input.horizonMonths; month++) {
    if (month > 0) {
      const ctx: JurisdictionContext = { year: startYear + Math.floor(month / 12) };
      const taxable = input.monthlyNetFlowCents > 0 ? input.monthlyNetFlowCents : 0;
      const taxCents = jurisdiction.computeTaxCents(taxable, ctx);
      nominal += input.monthlyNetFlowCents - taxCents;
    }
    months.push({
      month,
      netWorthNominalCents: nominal,
      netWorthRealCents: toRealCents(nominal, input.annualInflationRate, month),
      accountBalancesCents: {},
    });
  }

  return { months };
}
