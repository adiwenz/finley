import type { Cents } from "../money/money";
import type { SimState } from "./runState";
import type {
  InsolvencyReport,
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
  /**
   * A PRIOR month went insolvent. Together with {@link isInsolvent} this locates the FIRST
   * insolvent month — the only one that carries an {@link InsolvencyReport} — and decides
   * termination, so both facts are derived here rather than passed in pre-combined.
   */
  readonly priorInsolvency: boolean;
  readonly liabilityPaymentRecords: Record<string, LiabilityPaymentRecord>;
  /** Absent only on `opening`: no flow has run at "now". */
  readonly flows: ProjectionMonthFlows | undefined;
}

/**
 * Step 11: net worth = Σassets + Σproperties − Σliabilities; real = nominal / (1+infl)^yrs.
 * Once insolvency hits both figures are `null` — once unfunded spending has been dropped the
 * model can no longer say what net worth is. Balances are still emitted for diagnosis; only the
 * aggregate is nulled.
 *
 * Termination starts at the insolvent month ITSELF, not the one after it. That month is already
 * contaminated: the cascade charged only the sliver of spending credit could still absorb and
 * dropped the rest, so its balance sheet keeps the passive gains (appreciation, amortization)
 * while losing most of the cost — a net worth that ticks UP in the month the plan fails. The
 * last honest figure is the last FULLY FUNDED month.
 *
 * The FIRST insolvent month additionally carries an {@link InsolvencyReport}, the one place the
 * contaminated sum is put to use: `balance sheet − uncoveredCents`, what the month would have
 * been worth had the dropped obligations been honoured with equivalent additional borrowing.
 * The raw contaminated total is NOT itself published — it is a number with no safe reading, and
 * the only question worth asking of it is answered here.
 */
export function snapshotMonth(state: SimState, params: MonthSnapshotParams): ProjectionMonth {
  const {
    month,
    elapsedMonths,
    annualInflationRate,
    isInsolvent,
    uncoveredCents,
    priorInsolvency,
    liabilityPaymentRecords,
    flows,
  } = params;
  // Insolvency is terminal for the aggregate; the report belongs to the month it first happens.
  const netWorthTerminated = priorInsolvency || isInsolvent;
  const isFirstInsolventMonth = isInsolvent && !priorInsolvency;
  let nominalNetWorth: Cents = 0;

  const netWorthByPerson = new Map<string, Cents>();
  const addToOwner = (ownerId: string, deltaCents: Cents): void => {
    netWorthByPerson.set(ownerId, (netWorthByPerson.get(ownerId) ?? 0) + deltaCents);
  };

  const accountBalancesCents: Record<string, Cents> = {};
  const accountBasisCents: Record<string, Cents> = {};
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    accountBalancesCents[acc.id] = bal;
    // Basis rides alongside the balance and never nets into net worth, so an affordability
    // check can read a would-be liquidation's untaxed gain `balance − basis`.
    accountBasisCents[acc.id] = state.basisByAccount.get(acc.id) ?? 0;
    nominalNetWorth += bal;
    addToOwner(acc.ownerId, bal);
  }

  const liabilityBalancesCents: Record<string, Cents> = {};
  for (const liab of state.liabilities) {
    const bal = state.liabilityBalances.get(liab.id) ?? 0;
    liabilityBalancesCents[liab.id] = bal;
    nominalNetWorth -= bal;
    addToOwner(liab.ownerId, -bal);
  }

  const propertyValuesCents: Record<string, Cents> = {};
  for (const p of state.properties) {
    const value = state.propertyValues.get(p.id) ?? 0;
    propertyValuesCents[p.id] = value;
    nominalNetWorth += value;
    addToOwner(p.ownerId, value);
  }

  return {
    month,
    netWorthNominalCents: netWorthTerminated ? null : nominalNetWorth,
    netWorthRealCents: netWorthTerminated
      ? null
      : toRealCents(nominalNetWorth, annualInflationRate, elapsedMonths),
    netWorthByPersonCents: netWorthTerminated ? null : Object.fromEntries(netWorthByPerson),
    // Present on exactly one month per run. `nominalNetWorth` is the contaminated total — the
    // figure the plan reached only by dropping what it could not pay — so the only form it is
    // published in is one that has charged the shortfall back.
    ...(isFirstInsolventMonth
      ? {
          insolvencyReport: {
            uncoveredCents,
            debtFundedNetWorthNominalCents: nominalNetWorth - uncoveredCents,
          },
        }
      : {}),
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
