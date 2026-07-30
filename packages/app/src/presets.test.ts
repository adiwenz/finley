/**
 * The starter simulations a fresh session can load: a healthy default plus three teaching
 * scenarios — paycheck to paycheck, living on a credit card, and a student loan into
 * negative net worth. These tests pin each one's financial *shape*, so a tweak to the
 * numbers can't turn "living on credit" into a plan that quietly accumulates wealth.
 */

import { describe, it, expect } from "vitest";
import {
  Projection,
  dollarsToCents,
  CONTRIBUTION_TARGETS,
  type BudgetLine,
  type ProjectionResult,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
import { buildPerLineBudgetData } from "./components/baseAdjustments/perLineBudget";

/**
 * A preset's projection over the app's sanctioned facade path: `presetState` (which runs the
 * full ledger validation and THROWS on a bad seed — so the "a rejected seed is a preset bug"
 * oracle is preserved) then `Projection.fromState`.
 */
function projectionOf(preset: Preset): Projection {
  return Projection.fromState(presetState(preset), usJurisdiction);
}

/** One completed run over a preset — the result carrying both series and firstInsolventMonth. */
function runOfPreset(preset: Preset): ProjectionResult {
  return projectionOf(preset).run(usJurisdiction);
}

/** The projected series for a preset (plan + its seed events). */
function project(preset: Preset): ProjectionSeries {
  return runOfPreset(preset).series;
}

const realNetWorthAt = (series: ProjectionSeries, month: number): number | null =>
  series.months[month]?.netWorthRealCents ?? null;

/**
 * The spend each scenario was tuned against, kept here as an independent source of truth so a
 * drift in the budget lines that changes the projection is caught.
 */
const AUTHORED_SPEND: Record<string, number> = {
  default: dollarsToCents(3500),
  "paycheck-to-paycheck": dollarsToCents(3600),
  "living-on-credit": dollarsToCents(3600),
  "student-loan": dollarsToCents(3000),
  "taxed-in-retirement": dollarsToCents(5500),
};

/**
 * A budget's monthly SPEND: literal `expense` lines only. Contribution (`account`) lines are
 * saving — the waterfall funds them out of what is left after spending — so counting them here
 * would inflate the obligation the engine actually charges.
 */
const expenseTotal = (lines: readonly BudgetLine[]): number =>
  lines.reduce(
    (sum, line) =>
      sum +
      (line.target.kind === "expense" && line.amountSource.kind === "literal"
        ? line.amountSource.monthlyCents
        : 0),
    0,
  );

describe("default simulations", () => {
  it("offers the healthy default plus the teaching scenarios", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "default",
      "paycheck-to-paycheck",
      "living-on-credit",
      "student-loan",
      "taxed-in-retirement",
    ]);
    for (const preset of PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
    expect(PRESETS[0].plan).toEqual(presetById("default").plan);
  });

  it("every preset opens on an editable line-item budget totalling its authored spend", () => {
    for (const preset of PRESETS) {
      const lines = preset.plan.budgetLines;
      // No lines opens the Base + Adjustments editor onto an empty spending chart.
      expect(lines.length).toBeGreaterThan(0);
      // Expense targets ONLY: an `account` line is a contribution the waterfall funds, not
      // spend, so summing the budget wholesale would book saving as spending.
      expect(expenseTotal(lines)).toBe(AUTHORED_SPEND[preset.id]);
    }
  });

  it("counts only expense lines as spend — a savings contribution is not an expense", () => {
    // Budget lines carry both destinations. No preset seeds a contribution today, so the
    // totals above would hold either way; the 50/30/20 quickstart seeds one the moment a user
    // touches it, and a preset may yet ship one. Pin the split rather than the accident.
    const preset = presetById("student-loan");
    const account = CONTRIBUTION_TARGETS[0];
    const savings: BudgetLine = {
      id: "seed-savings",
      label: "Savings",
      target: { kind: "account", accountId: account.accountId, taxTreatment: account.taxTreatment },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(400) },
      category: "savings",
    };
    const withSavings: Preset = {
      ...preset,
      plan: { ...preset.plan, budgetLines: [...preset.plan.budgetLines, savings] },
    };

    // The contribution reaches the budget but never the spending obligation.
    expect(expenseTotal(withSavings.plan.budgetLines)).toBe(AUTHORED_SPEND["student-loan"]);
    const before = project(preset);
    const after = project(withSavings);
    const expensesAt = (s: ProjectionSeries, month: number): number | null =>
      s.months[month]?.flows?.expensesCents ?? null;
    // Guard the comparison below against passing on two undefineds.
    expect(expensesAt(before, 0)).toBeGreaterThan(0);
    for (const month of [0, 12, 120]) {
      expect({ month, cents: expensesAt(after, month) }).toEqual({
        month,
        cents: expensesAt(before, month),
      });
    }
    // …and it is live, not ignored: the money lands somewhere the projection can see.
    expect(after.months[120]?.netWorthRealCents).not.toBe(before.months[120]?.netWorthRealCents);
  });

  it("default: builds real wealth across the working years and stays solvent", () => {
    const result = runOfPreset(presetById("default"));
    const series = result.series;
    const opening = realNetWorthAt(series, 0)!;
    const midCareer = realNetWorthAt(series, 120)!;
    expect(midCareer).toBeGreaterThan(opening * 3);
    expect(result.firstInsolventMonth).toBeGreaterThan(120);
  });

  it("paycheck-to-paycheck: survives working years but barely accumulates and can't fund retirement", () => {
    const paycheck = runOfPreset(presetById("paycheck-to-paycheck"));
    const wealthy = project(presetById("default"));
    const paycheckMid = realNetWorthAt(paycheck.series, 120)!;
    const wealthyMid = realNetWorthAt(wealthy, 120)!;
    // Afloat while earning — no debt spiral — but only a sliver of the default's wealth.
    expect(paycheckMid).toBeGreaterThan(0);
    expect(paycheckMid).toBeLessThan(wealthyMid * 0.25);
    // No emergency cushion means retirement is unfundable: insolvency lands around it.
    expect(paycheck.firstInsolventMonth).not.toBeNull();
  });

  it("living-on-credit: overspends from the start, accruing compounding credit-card debt", () => {
    const result = runOfPreset(presetById("living-on-credit"));
    const series = result.series;
    expect(realNetWorthAt(series, 24)!).toBeLessThan(0);
    // The shortfall cascade routes each month's shortfall onto a synthetic credit-card
    // liability that compounds.
    const early = series.months[12]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    const later = series.months[36]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);
    // The debt is unfinanceable long-term: the plan runs out of credit.
    expect(result.firstInsolventMonth).not.toBeNull();
  });

  it("taxed-in-retirement: taxes Social Security meaningfully, unlike the default plan", () => {
    // Taxable 401(k) withdrawals fund retirement — the spend is tuned high enough that cash
    // can't cover it tax-free — so that ordinary income lifts the benefit over the standard
    // deduction.
    const series = project(presetById("taxed-in-retirement"));
    const ssTax = series.months.map((m) => {
      const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
      return byCat.governmentRetirementBenefit ?? 0;
    });
    expect(ssTax.filter((c) => c > 0).length).toBeGreaterThan(24); // taxed across years, not a blip
    // A few hundred, not a rounding-scale $25/mo: guards a regression to cash-funded
    // retirement.
    expect(Math.max(...ssTax)).toBeGreaterThan(dollarsToCents(300));
    // The default plan taxes the benefit only trivially: its home goal is a drawable
    // `retain` reserve, so a little taxable drawdown does reach the benefit.
    const defaultMaxSSTax = Math.max(
      0,
      ...project(presetById("default")).months.map((m) => {
        const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
        return byCat.governmentRetirementBenefit ?? 0;
      }),
    );
    // Trivial next to taxed-in-retirement's $300+. The ceiling sits at $150 (not $100): with
    // year 0 now accruing a full 12 covered-earnings months, the benefit — and the sliver of
    // it a little `retain` drawdown makes taxable — is marginally higher.
    expect(defaultMaxSSTax).toBeLessThan(dollarsToCents(150));
  });

  it("student-loan: opens underwater on a student loan, then digs out of it", () => {
    const series = project(presetById("student-loan"));
    // Net worth starts negative — assets minus the student-loan liability.
    expect(realNetWorthAt(series, 0)!).toBeLessThan(0);
    // The loan is a real amortizing student-loan liability at "now", not a cash hack.
    expect(series.months[0]?.liabilityBalancesCents).toHaveProperty("loan-student");
    // A solid income services it.
    expect(realNetWorthAt(series, 120)!).toBeGreaterThan(0);
  });
});

describe("the two graphs are one quantity", () => {
  /** The app's own wiring: the graph reads the engine's itemized spending, nothing else. */
  function budgetChart(preset: Preset) {
    const series = projectionOf(preset).run(usJurisdiction).series;
    return { series, data: buildPerLineBudgetData(series) };
  }

  it.each(PRESETS.map((p) => p.id))(
    "%s: every month's spending stack totals exactly the income graph's spending need",
    (id) => {
      const { series, data } = budgetChart(presetById(id));
      // The spending graph splits the obligation by destination; the income graph's dashed
      // line is the same obligation as one number. Disagreement means real spending is
      // drawn nowhere.
      for (const row of data.rows) {
        const flows = series.months[row.month]?.flows;
        const need = (flows?.expensesCents ?? 0) + (flows?.liabilityPaymentsCents ?? 0);
        expect({ month: row.month, cents: row.totalCents }).toEqual({
          month: row.month,
          cents: need,
        });
      }
    },
  );
});

describe("the panel and the graph agree", () => {
  it.each(PRESETS.map((p) => p.id))(
    "%s: retirement is called infeasible only when the projection actually runs out",
    (id) => {
      const preset = presetById(id);
      const projection = projectionOf(preset);
      const graphSurvives = projection.run(usJurisdiction).firstInsolventMonth === null;
      // Underwater is not out of money: the student-loan scenario opens negative yet pays
      // every bill, so the panel must not call retirement infeasible for a plan the graph
      // draws surviving.
      const pinnedWorks = projection.retirement(usJurisdiction).target.feasible;
      if (graphSurvives) expect(pinnedWorks).toBe(true);
    },
  );

  it("student-loan: an underwater opening still has a feasible retirement age", () => {
    const preset = presetById("student-loan");
    const projection = projectionOf(preset);
    expect(projection.run(usJurisdiction).series.months[0]!.netWorthRealCents).toBeLessThan(0);
    expect(projection.retirement(usJurisdiction).solution.fullRetirementAge).not.toBeNull();
  });
});
