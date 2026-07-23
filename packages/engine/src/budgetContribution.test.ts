/**
 * Issue #72 rewire: a budget CONTRIBUTION line (`target: account`) is funded in the
 * waterfall and accumulates in its account, instead of being dropped (the pre-rewire
 * behaviour) or — worse — modelled as an expense that leaves net worth. These pin the
 * end-to-end fact through the real projection: a "$500/mo into brokerage" line moves
 * money account→account (net worth is not reduced) and the brokerage balance climbs.
 *
 * A contribution is also a COMMITTED outflow: the full amount always lands in the account,
 * and the part discretionary can't cover is borrowed (a §5.1 shortfall), so an unaffordable
 * auto-invest makes the plan unfinanceable rather than silently shrinking to fit.
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

  it("is committed: the FULL contribution lands even when discretionary can't cover it", () => {
    // Take-home is ~$7,200/mo ($8k gross − 10% deferral). Rent $6,500 + $600 health leaves
    // ~$100 discretionary, far short of the $500 contribution — yet the whole $500 still
    // lands in brokerage each month (the rest borrowed), identical to the comfortable arm.
    const strainedRent = { ...rent, amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(6500) } };
    const strained: Plan = { ...samplePlan, goals: [], budgetLines: [strainedRent, invest] };
    const comfy = project(withContribution).months; // rent $3,000 — $500 easily afforded
    const tight = project(strained).months;
    // Same brokerage balance in both: an unaffordable contribution is borrowed, never shrunk.
    expect(tight[12].accountBalancesCents["brokerage"]).toBe(comfy[12].accountBalancesCents["brokerage"]);
  });

  it("makes the plan unfinanceable when the contribution is far beyond your means", () => {
    // $1,000,000/mo into brokerage on an ~$7.2k take-home: it can't be borrowed for long, so
    // the §5.1 cascade exhausts savings and credit within the first year and the plan is insolvent.
    const absurd: Plan = {
      ...samplePlan,
      goals: [],
      budgetLines: [rent, { ...invest, amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(1_000_000) } }],
    };
    const months = project(absurd).months;
    const firstInsolvent = months.findIndex((m) => m.isInsolvent);
    expect(firstInsolvent).toBeGreaterThan(0); // month 0 is the flow-free snapshot
    expect(firstInsolvent).toBeLessThan(13); // and it's immediate, not a far-future failure
  });

  it("does NOT inflate net worth when a committed contribution overshoots into insolvency", () => {
    // The whole point: a $10,000,000/mo contribution you can't fund must not show as a
    // ~$10M net-worth spike in the insolvent month. The part that couldn't actually be
    // funded (from cash, savings, or credit) is unwound, so net worth stays near the
    // pre-contribution level rather than booking a phantom asset.
    const absurd: Plan = {
      ...samplePlan,
      goals: [],
      budgetLines: [rent, { ...invest, amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(10_000_000) } }],
    };
    const months = project(absurd).months;
    const firstInsolvent = months.findIndex((m) => m.isInsolvent);
    expect(firstInsolvent).toBeGreaterThan(0);
    const nw = months[firstInsolvent].netWorthNominalCents;
    expect(nw).not.toBeNull();
    // Nowhere near the $10M deposit — it stays around opening savings + real monthly saving.
    expect(nw!).toBeLessThan(dollarsToCents(1_000_000));
  });
});
