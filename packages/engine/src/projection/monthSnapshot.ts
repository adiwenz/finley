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
  month: number,
): Cents {
  const years = month / 12;
  return Math.round(nominalCents / Math.pow(1 + annualInflationRate, years));
}

/**
 * Step 11: snapshot net worth = Σassets + Σproperties − Σliabilities; real = nominal
 * / (1+infl)^yrs (§0.4). When `netWorthTerminated` (a PRIOR month already went
 * insolvent, §5.1) both net-worth figures are reported as `null` — the model can no
 * longer say what net worth is once unfunded spending has been dropped. The balances
 * themselves are still emitted (diagnostic), only the aggregate net worth is nulled.
 */
export function snapshotMonth(
  state: SimState,
  month: number,
  annualInflationRate: number,
  isInsolvent: boolean,
  netWorthTerminated: boolean,
  liabilityPaymentRecords: Record<string, LiabilityPaymentRecord>,
  flows: ProjectionMonthFlows | undefined,
): ProjectionMonth {
  let nominalNetWorth: Cents = 0;

  const accountBalancesCents: Record<string, Cents> = {};
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    accountBalancesCents[acc.id] = bal;
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
      : toRealCents(nominalNetWorth, annualInflationRate, month),
    accountBalancesCents,
    liabilityBalancesCents,
    liabilityPaymentRecords,
    propertyValuesCents,
    isInsolvent,
    ...(flows !== undefined ? { flows } : {}),
  };
}
