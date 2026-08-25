/**
 * Two earners, one shared budget, and nothing else moving — the fixture the partnered funding
 * suites are written against.
 *
 * Every return and the inflation rate are 0 and there are no goals, so a balance moves for
 * exactly one reason: something drew on it, or a paycheck landed in it. That is what lets a test
 * assert "this account fell by exactly this much" as a fact about funding rather than about a
 * month's interest. Alex out-earns Blake, so which of them comes up short is decided by the
 * authored split alone — the same fixture answers for 50/50, 70/30 and both extremes.
 *
 * Co-located with the suites it serves, mirroring `simulate.testSupport.ts`.
 */

import { ref } from "../input/scenarioInput";
import type { ScenarioInput } from "../input/scenarioInput";
import { dollarsToCents } from "../money/cashFlowSeries";

export const START_YEAR = 2026;
export const BUDGET = dollarsToCents(5_400);

/** The primary's cash account, as the standing build names it. */
export const ALEX_SAVINGS = "savings";

/**
 * The partner's cash account. Minted with a generated suffix, so it is found by shape rather
 * than named — `keys` is any per-account map from the run.
 */
export function blakeSavings(keys: Iterable<string>): string {
  const id = [...keys].find((k) => k.startsWith("savings-"));
  if (id === undefined) throw new Error("the partner has no savings account");
  return id;
}

export interface PartnerHouseholdOverrides {
  readonly sharePercent?: number;
  readonly alexMonthlyDollars?: number;
  readonly blakeMonthlyDollars?: number;
  readonly alexSavingsDollars?: number;
  readonly blakeSavingsDollars?: number;
}

export function partnerHousehold(over: PartnerHouseholdOverrides): ScenarioInput {
  const alexPay = over.alexMonthlyDollars ?? 4_000;
  const blakePay = over.blakeMonthlyDollars ?? 1_200;
  return {
    name: "Alex",
    startYear: START_YEAR,
    birthYear: START_YEAR - 40,
    lifeExpectancy: 70,
    benefitClaimingAge: 67,
    openingBalanceCents: dollarsToCents(over.alexSavingsDollars ?? 30_000),
    savingsReturnPct: 0,
    retirementReturnPct: 0,
    brokerageReturnPct: 0,
    inflationPct: 0,
    goals: [],
    budgetLines: [
      {
        label: "Household",
        target: { kind: "expense" },
        amountSource: { kind: "literal", monthlyCents: BUDGET },
        category: "needs",
      },
    ],
    jobs: [
      {
        startYear: START_YEAR - 20,
        endYear: START_YEAR + 20,
        salary: {
          startingSalaryCents: dollarsToCents(alexPay) * 12,
          currentSalaryCents: dollarsToCents(alexPay) * 12,
          realGrowthPct: 0,
        },
      },
    ],
    events: [
      {
        type: "startPartnered",
        ref: ref("blake"),
        partneredForMonths: 24,
        name: "Blake",
        birthYear: START_YEAR - 40,
        lifeExpectancy: 70,
        jobs: [
          {
            startYear: START_YEAR - 20,
            endYear: START_YEAR + 20,
            salary: {
              startingSalaryCents: dollarsToCents(blakePay) * 12,
              currentSalaryCents: dollarsToCents(blakePay) * 12,
              realGrowthPct: 0,
            },
          },
        ],
        accounts: {
          savingsBalanceCents: dollarsToCents(over.blakeSavingsDollars ?? 30_000),
          retirementBalanceCents: 0,
          brokerageBalanceCents: 0,
        },
        ...(over.sharePercent === undefined ? {} : { partnerSharePercent: over.sharePercent }),
      },
    ],
  };
}
