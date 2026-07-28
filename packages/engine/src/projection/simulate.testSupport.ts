import type { SimPerson } from "./simulate.types";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../simAccount";
import { SimCashFlowSeries } from "../cashFlowSeries";

// Shared builders for the simulate.* test files, co-located with them, mirroring
// engine/src/testing/. Behaviour-identical to the originals from the top of
// simulate.test.ts, so the partitioned sibling suites stay byte-for-byte green.

export function makePerson(id = "p1", name = "Alice"): SimPerson {
  return { id, name };
}

export function makeInvestmentAccount(openingCents: number, annualRate: number): SimAccount {
  return new SimAccount({
    id: "investment",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: annualRate,
  });
}

export function monthlyIncome(monthlyCents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
}

export function monthlyExpense(monthlyCents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
}
