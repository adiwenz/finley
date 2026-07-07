import type { Cents } from "./money";
import type { Jurisdiction, JurisdictionContext } from "./jurisdiction";
import type { Account } from "./account";
import { CashFlowSeries } from "./cashFlowSeries";

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
  readonly month: number;
  readonly netWorthNominalCents: Cents;
  readonly netWorthRealCents: Cents;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
}

export interface ProjectionSeries {
  readonly months: readonly ProjectionMonth[];
}

const DEFAULT_START_YEAR = 2026;

function toRealCents(
  nominalCents: Cents,
  annualInflationRate: number,
  month: number,
): Cents {
  const years = month / 12;
  return Math.round(nominalCents / Math.pow(1 + annualInflationRate, years));
}

// ---------------------------------------------------------------------------
// Slice-0 walking skeleton — kept for backward compat with existing tests
// ---------------------------------------------------------------------------

/**
 * Slice-0 walking-skeleton input. Deliberately minimal. Slice 1 (issue #2)
 * adds the real income/expense/account pipeline via simulateHousehold(); the
 * ProjectionSeries output shape is the stable contract that survives that change.
 */
export interface SimulationInput {
  readonly horizonMonths: number;
  readonly openingNetWorthCents: Cents;
  readonly monthlyNetFlowCents: Cents;
  readonly annualInflationRate: number;
  readonly startYear?: number;
}

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

// ---------------------------------------------------------------------------
// Slice-1 household simulator — real income/expense series + compounding accounts
// ---------------------------------------------------------------------------

/** A person in the household. */
export interface Person {
  readonly id: string;
  readonly name: string;
}

/** An income or expense series tied to an owner. */
export interface OwnedSeries {
  readonly series: CashFlowSeries;
  readonly ownerId: string;
}

export interface HouseholdSimInput {
  readonly horizonMonths: number;
  readonly annualInflationRate: number;
  readonly startYear?: number;
  readonly persons: readonly Person[];
  /**
   * Asset accounts. The first liquid account receives net cash flow each month
   * (simplified Slice-1 allocation; full waterfall comes in Slice 5a, issue #7).
   */
  readonly accounts: readonly Account[];
  readonly incomeSeries: readonly OwnedSeries[];
  readonly expenseSeries: readonly OwnedSeries[];
}

/**
 * Slice-1 household simulator. Fixed pipeline per month (§5):
 *  1. Net cash flow = Σ income − Σ expense, routed through jurisdiction tax seam
 *  2. Net flow deposited into the first liquid account (pre-waterfall simplification)
 *  3. One-time transfers at this month applied (§3.2)
 *  4. Every asset account compounded once at preciseMonthlyRate(rateAt(m)) (§0.2)
 *  5. Snapshot nominal net worth; reporting layer converts to real (§0.4)
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const months: ProjectionMonth[] = [];

  const balances = new Map<string, Cents>();
  for (const acc of input.accounts) {
    balances.set(acc.id, acc.openingBalanceCents);
  }

  const liquidAccount = input.accounts.find((a) => a.liquid);

  for (let month = 0; month <= input.horizonMonths; month++) {
    if (month > 0) {
      const ctx: JurisdictionContext = { year: startYear + Math.floor(month / 12) };

      // Step 1: Net cash flow
      let grossIncomeCents = 0;
      for (const s of input.incomeSeries) {
        grossIncomeCents += s.series.getMonthlyCents(month);
      }
      let expenseCents = 0;
      for (const s of input.expenseSeries) {
        expenseCents += s.series.getMonthlyCents(month);
      }
      const taxable = Math.max(0, grossIncomeCents);
      const taxCents = jurisdiction.computeTaxCents(taxable, ctx);
      const netFlowCents = grossIncomeCents - taxCents - expenseCents;

      // Step 2: Deposit net flow into first liquid account
      if (liquidAccount != null) {
        const prev = balances.get(liquidAccount.id) ?? 0;
        balances.set(liquidAccount.id, prev + netFlowCents);
      }

      // Step 3: Apply one-time transfers for this month
      for (const acc of input.accounts) {
        for (const t of acc.getTransfersAt(month)) {
          const prev = balances.get(acc.id) ?? 0;
          balances.set(acc.id, prev + t.amountCents);
        }
      }

      // Step 4: Compound every asset account exactly once (§0.2)
      for (const acc of input.accounts) {
        const balance = balances.get(acc.id) ?? 0;
        balances.set(acc.id, Math.round(balance * (1 + acc.getMonthlyRateAt(month))));
      }
    }

    // Step 5: Snapshot
    let nominalNetWorth: Cents = 0;
    const accountBalancesCents: Record<string, Cents> = {};
    for (const acc of input.accounts) {
      const bal = balances.get(acc.id) ?? 0;
      nominalNetWorth += bal;
      accountBalancesCents[acc.id] = bal;
    }

    months.push({
      month,
      netWorthNominalCents: nominalNetWorth,
      netWorthRealCents: toRealCents(nominalNetWorth, input.annualInflationRate, month),
      accountBalancesCents,
    });
  }

  return { months };
}
