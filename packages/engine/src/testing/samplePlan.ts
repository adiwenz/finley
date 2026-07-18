/**
 * A small, purpose-built plan fixture for engine-native mapping/solver tests.
 *
 * Deliberately NOT a copy of the app's `PLAN_DEFAULTS` — copying it would let the
 * two drift silently and couple engine tests to a product default. This is a
 * minimal, self-contained scenario (single household, one goal) chosen so the
 * mapping wiring is easy to assert: a clear surplus to accumulate, a retirement
 * age below the health-coverage age (so the health step is exercised), and a
 * finite horizon.
 *
 * Written with `satisfies Plan` rather than a `: Plan` annotation so the fixture is
 * checked against the type without widening: tests still see each field's literal
 * value, and a drift in `Plan` fails here rather than at a use site. Pure (satisfies
 * `check-engine-purity`) and NOT barrel-exported: tests import it by relative path
 * (`../testing/samplePlan`).
 */
import type { Plan } from "../plan";
import { dollarsToCents } from "../cashFlowSeries";

export const samplePlan = {
  name: "Sample",
  incomeCents: dollarsToCents(8000),
  expenseCents: dollarsToCents(4000),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(20000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  retirementDeferralPct: 10,
  sharedScheme: "proportional",
  surplusSwept: true,
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      targetCents: dollarsToCents(20000),
      targetDate: 24,
      disposition: "retain",
      annualReturnPct: 4,
    },
  ],
  healthMonthlyCents: dollarsToCents(600),
  postCoverageHealthMonthlyCents: dollarsToCents(400),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: 40,
  retirementAge: 60,
  lifeExpectancy: 85,
  ssClaimingAge: 67,
} satisfies Plan;
