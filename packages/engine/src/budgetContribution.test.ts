/**
 * Issue #72 rewire: a budget CONTRIBUTION line (`target: account`) is funded in the
 * waterfall and accumulates in its account, instead of being dropped (the pre-rewire
 * behaviour) or — worse — modelled as an expense that leaves net worth. These pin the
 * end-to-end fact through the real projection: a "$500/mo into brokerage" line moves
 * money account→account (net worth is not reduced) and the brokerage balance climbs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, type ProjectionContext } from "./projectionBase";
import { samplePlan } from "./testing/samplePlan";
import { dollarsToCents } from "./cashFlowSeries";
import type { BudgetLine } from "./budgetLine";
import type { Plan } from "./plan";

const START_YEAR = 2026;
const ctx = (): ProjectionContext => ({ jurisdiction: nullJurisdiction, startYear: START_YEAR });
const project = (plan: Plan) =>
  replayLedger(emptyLedger, createProjectionBase(plan, ctx()), nullJurisdiction);

const rent: BudgetLine = {
  id: "rent",
  label: "Rent",
  target: { kind: "expense" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(3000) },
  category: "needs",
};
const invest: BudgetLine = {
  id: "invest",
  label: "Auto-invest",
  target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
  category: "savings",
};

// A comfortable single-earner plan ($8k/mo income): plenty of discretionary to fund a
// $500/mo contribution in full. Same expenses in both arms — only the contribution differs.
const withoutContribution: Plan = { ...samplePlan, budgetLines: [rent], goals: [] };
const withContribution: Plan = { ...samplePlan, budgetLines: [rent, invest], goals: [] };

describe("budget contribution lines fund their account (#72 rewire)", () => {
  it("accumulates the contribution in the target account month over month", () => {
    const months = project(withContribution).months;
    const at = (m: number) => months[m].accountBalancesCents["brokerage"] ?? 0;
    // Year 0 accrues 11 flow-months (month 0 is the opening snapshot), so ~$5,500 by m12,
    // plus a little growth — comfortably more than $5,000, and still climbing after.
    expect(at(12)).toBeGreaterThan(dollarsToCents(5000));
    expect(at(24)).toBeGreaterThan(at(12));
  });

  it("does NOT reduce net worth — it moves cash account→account, unlike an expense", () => {
    const a = project(withoutContribution).months;
    const b = project(withContribution).months;
    const netA = a[24].netWorthNominalCents ?? 0;
    const netB = b[24].netWorthNominalCents ?? 0;
    // Idling $500/mo in cash (savings rate) vs investing it (brokerage rate) — routing it
    // to the higher-returning account never lowers net worth. A vanishing "expense" model
    // would instead make netB ~ $12k LOWER; this asserts it does not.
    expect(netB).toBeGreaterThanOrEqual(netA);
  });

  it("underfunds rather than overdraws when discretionary can't cover it", () => {
    // Rent $7,900/mo against ~$8k take-home leaves almost nothing for a $500 contribution.
    const tight: Plan = {
      ...samplePlan,
      goals: [],
      budgetLines: [
        { ...rent, amountSource: { kind: "literal", monthlyCents: dollarsToCents(7900) } },
        invest,
      ],
    };
    const months = project(tight).months;
    // Some (small) amount still saved, but far below the full $500/mo × 12.
    const brokerageAt12 = months[12].accountBalancesCents["brokerage"] ?? 0;
    expect(brokerageAt12).toBeLessThan(dollarsToCents(500 * 12));
  });
});
