import type { Cents } from "../money";
import type { SimState } from "./runState";
import type {
  LiabilityPaymentRecord,
  ProjectionMonth,
  ProjectionMonthFlows,
} from "./simulate.types";

function toRealCents(
  nominalCents: Cents,
  annualInflationRate: number,
  elapsedMonths: number,
): Cents {
  const years = elapsedMonths / 12;
  return Math.round(nominalCents / Math.pow(1 + annualInflationRate, years));
}

/** What {@link snapshotMonth} needs beyond the mutable state it reads balances off. */
export interface MonthSnapshotParams {
  /** The reported month index — `opening` carries 0, and so does `months[0]`. */
  readonly month: number;
  /**
   * Months of real time between "now" and this snapshot: what the real-dollar deflator
   * divides by, and NOT the same number as {@link month}. `months[m]` is the END of month m,
   * so m+1 months have elapsed by then, while `opening` is "now" itself at 0. Passing
   * `month` here under-deflates every real figure by exactly one month — silently, and
   * uniformly across the whole horizon.
   */
  readonly elapsedMonths: number;
  readonly annualInflationRate: number;
  readonly isInsolvent: boolean;
  /**
   * The deficit nothing could absorb this month — what the cascade DROPPED rather than
   * charged. Reported so a consumer can say how far short the month fell instead of inferring
   * it from a balance sheet that never recorded it.
   */
  readonly uncoveredCents: Cents;
  /** This month or a prior one went insolvent — nulls the aggregates, not the balances. */
  readonly netWorthTerminated: boolean;
  readonly liabilityPaymentRecords: Record<string, LiabilityPaymentRecord>;
  /** Absent only on `opening`: no flow has run at "now". */
  readonly flows: ProjectionMonthFlows | undefined;
}

/**
 * Step 11: net worth = Σassets + Σproperties − Σliabilities; real = nominal / (1+infl)^yrs.
 * Under `netWorthTerminated` both figures are `null` — once unfunded spending has been dropped
 * the model can no longer say what net worth is. Balances are still emitted for diagnosis; only
 * the aggregate is nulled.
 *
 * Termination starts at the insolvent month ITSELF, not the one after it. That month is already
 * contaminated: the cascade charged only the sliver of spending credit could still absorb and
 * dropped the rest, so its balance sheet keeps the passive gains (appreciation, amortization)
 * while losing most of the cost — a net worth that ticks UP in the month the plan fails. The
 * last honest figure is the last FULLY FUNDED month.
 */
export function snapshotMonth(state: SimState, params: MonthSnapshotParams): ProjectionMonth {
  const {
    month,
    elapsedMonths,
    annualInflationRate,
    isInsolvent,
    uncoveredCents,
    netWorthTerminated,
    liabilityPaymentRecords,
    flows,
  } = params;
  let nominalNetWorth: Cents = 0;

  const accountBalancesCents: Record<string, Cents> = {};
  const accountBasisCents: Record<string, Cents> = {};
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    accountBalancesCents[acc.id] = bal;
    // Basis rides alongside the balance and never nets into net worth, so an affordability
    // check can read a would-be liquidation's untaxed gain `balance − basis`.
    accountBasisCents[acc.id] = state.basisByAccount.get(acc.id) ?? 0;
    nominalNetWorth += bal;
  }

  const liabilityBalancesCents: Record<string, Cents> = {};
  for (const liab of state.liabilities) {
    const bal = state.liabilityBalances.get(liab.id) ?? 0;
    liabilityBalancesCents[liab.id] = bal;
    nominalNetWorth -= bal;
  }

  const propertyValuesCents: Record<string, Cents> = {};
  for (const p of state.properties) {
    const value = state.propertyValues.get(p.id) ?? 0;
    propertyValuesCents[p.id] = value;
    nominalNetWorth += value;
  }

  return {
    month,
    netWorthNominalCents: netWorthTerminated ? null : nominalNetWorth,
    netWorthRealCents: netWorthTerminated
      ? null
      : toRealCents(nominalNetWorth, annualInflationRate, elapsedMonths),
    accountBalancesCents,
    accountBasisCents,
    liabilityBalancesCents,
    liabilityPaymentRecords,
    propertyValuesCents,
    isInsolvent,
    uncoveredCents,
    ...(flows !== undefined ? { flows } : {}),
  };
}
