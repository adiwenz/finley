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
  ref,
  CONTRIBUTION_TARGETS,
  healthcareMonthlyCents,
  type BudgetLine,
  type Plan,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
import { PLAN_DEFAULTS } from "./planDefaults";
import { buildPerLineBudgetData } from "./components/baseAdjustments/perLineBudget";

/**
 * Build a preset's declared {@link Projection}: a single `fromInput` over its `ScenarioInput`,
 * the same path {@link presetState} takes. A rejected preset is a preset bug, not user error, so
 * this throws rather than skipping the scenario.
 */
function projectionOf(preset: Preset): Projection {
  const built = Projection.fromInput(preset.input, usJurisdiction);
  if (!built.ok) throw new Error(`Preset "${preset.id}" was rejected: ${built.error.reason}`);
  return built.projection;
}

/** The built plan the preset resolves to — jobs and goals minted, budget lines label-keyed. */
function planOf(preset: Preset): Plan {
  return projectionOf(preset).plan;
}

/** Reproduce the app's projection pipeline for a preset (plan + its seed events). */
function project(preset: Preset): ProjectionSeries {
  return projectionOf(preset).run(usJurisdiction).series;
}

/** The first insolvent month off the preset's completed run — a field on `ProjectionResult`. */
const firstInsolventMonthOf = (preset: Preset): number | null =>
  projectionOf(preset).run(usJurisdiction).firstInsolventMonth;

const realNetWorthAt = (series: ProjectionSeries, month: number): number | null =>
  series.months[month]?.netWorthRealCents ?? null;

/**
 * The spend each scenario was tuned against, kept here as an independent source of truth so a
 * drift in the budget lines that changes the projection is caught.
 */
/**
 * Each preset's authored monthly spend, HEALTH INCLUDED — health is a `healthcare`-category
 * budget line now, so it counts in the budget it used to sit outside as a plan field. The
 * teaching scenarios carry a $450 line, the default and taxed-in-retirement a $700 one.
 */
const AUTHORED_SPEND: Record<string, number> = {
  default: dollarsToCents(4200),
  "paycheck-to-paycheck": dollarsToCents(4050),
  "living-on-credit": dollarsToCents(4050),
  "student-loan": dollarsToCents(3450),
  "taxed-in-retirement": dollarsToCents(6200),
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
    // The healthy default preset reproduces the plan a fresh session already opens on, rather
    // than authoring a second source of truth for it.
    expect(planOf(PRESETS[0])).toEqual(PLAN_DEFAULTS);
  });

  it("every preset opens on an editable line-item budget totalling its authored spend", () => {
    for (const preset of PRESETS) {
      const lines = planOf(preset).budgetLines;
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
    // Authored as an entry: the account is named by ref (a well-known standing account resolves
    // to itself) and the line's own id is minted, like every other.
    const savings = {
      label: "Savings",
      target: {
        kind: "account" as const,
        accountRef: ref(account.accountId),
        taxTreatment: account.taxTreatment,
      },
      amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(400) },
      category: "savings" as const,
    };
    const withSavings: Preset = {
      ...preset,
      input: { ...preset.input, budgetLines: [...(preset.input.budgetLines ?? []), savings] },
    };

    // The contribution reaches the budget but never the spending obligation.
    expect(expenseTotal(planOf(withSavings).budgetLines)).toBe(AUTHORED_SPEND["student-loan"]);
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

  it("default: FICA consumes the savings surplus, so real net worth erodes across the working years yet stays solvent to retirement", () => {
    const series = project(presetById("default"));
    const opening = realNetWorthAt(series, 0)!;
    const midCareer = realNetWorthAt(series, 120)!;
    // Charging the 7.65% employee FICA share removes the default plan's entire savings
    // surplus (its whole margin was the payroll tax it used to dodge), so real net worth
    // drifts DOWN rather than compounding up — the plan holds together on wages but no
    // longer builds wealth. Remove FICA and this flips back to multiplying, so the bound
    // guards the fix.
    expect(midCareer).toBeGreaterThan(0);
    expect(midCareer).toBeLessThan(opening);
    // Still solvent through the working years, only running dry around retirement.
    expect(firstInsolventMonthOf(presetById("default"))).toBeGreaterThan(240);
  });

  it("paycheck-to-paycheck: FICA tips it from barely-surviving into insolvency during the working years", () => {
    const paycheckInsolvent = firstInsolventMonthOf(presetById("paycheck-to-paycheck"));
    const defaultInsolvent = firstInsolventMonthOf(presetById("default"));
    // Afloat at the very start — no debt spiral yet.
    expect(realNetWorthAt(project(presetById("paycheck-to-paycheck")), 0)!).toBeGreaterThan(0);
    // With no cushion to absorb the 7.65% it never charged before, the plan goes under
    // mid-career — well inside the working years, and far sooner than the default plan.
    expect(paycheckInsolvent).not.toBeNull();
    expect(paycheckInsolvent!).toBeLessThan(120);
    expect(paycheckInsolvent!).toBeLessThan(defaultInsolvent!);
  });

  it("living-on-credit: overspends from the start, accruing compounding credit-card debt", () => {
    const series = project(presetById("living-on-credit"));
    expect(realNetWorthAt(series, 24)!).toBeLessThan(0);
    // The shortfall cascade routes each month's shortfall onto a synthetic credit-card
    // liability that compounds.
    const early = series.months[12]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    const later = series.months[36]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);
    // The debt is unfinanceable long-term: the plan runs out of credit.
    expect(firstInsolventMonthOf(presetById("living-on-credit"))).not.toBeNull();
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

  it("authors the seed loan through fromInput, letting the engine mint its ids", () => {
    // The preset is a single declarative `ScenarioInput` built through `fromInput`, not a
    // hand-built ledger. It names the loan only by `ref`, so both the event id and the liability
    // id come off the counter — no authored string ("e0", "loan-student") survives into state.
    const loan = presetState(presetById("student-loan")).scenario.ledger.events.find(
      (e) => e.type === "LoanEvent",
    );
    expect(loan?.id).toMatch(/^loan-\d+$/);
    expect(loan?.type === "LoanEvent" && loan.liabilityId).toMatch(/^loan-\d+$/);
    // The authoring method mints the event and its liability as ONE id.
    expect(loan?.type === "LoanEvent" && loan.liabilityId).toBe(loan?.id);
  });

  it("student-loan: opens underwater on a student loan, then digs out of it", () => {
    const preset = presetById("student-loan");
    const series = project(preset);
    // Net worth starts negative — assets minus the student-loan liability.
    expect(realNetWorthAt(series, 0)!).toBeLessThan(0);
    // The loan is a real amortizing student-loan liability at "now", not a cash hack. Its id is
    // read back off the built ledger rather than assumed.
    const loan = presetState(preset).scenario.ledger.events.find((e) => e.type === "LoanEvent");
    expect(series.months[0]?.liabilityBalancesCents).toHaveProperty(loan!.id);
    // A solid income services it.
    expect(realNetWorthAt(series, 120)!).toBeGreaterThan(0);
  });
});

/**
 * `taxed-in-retirement` is NOT one of the three teaching scenarios: it keeps the default
 * household's two goals and its $700/$500 health figures, because it was tuned against that
 * household to show retirement withdrawals being taxed. Folding it into the teaching helper —
 * which drops the goals and trims health to $450/$350 so an income/expense gap reads cleanly —
 * silently changed the scenario while every simulation-shape assertion above stayed green. These
 * assert the authored inputs directly, so the two can never be conflated again.
 */
describe("taxed-in-retirement — authored inputs, not just projected shape", () => {
  const plan = () => planOf(presetById("taxed-in-retirement"));

  it("keeps the default household's two goals", () => {
    const goals = plan().goals;
    expect(goals.map((g) => g.name)).toEqual(["Emergency fund", "Home down payment"]);
    // Same targets and horizons as the plan a fresh session opens on — this preset varies the
    // job, the budget, the return and the life expectancy, and nothing else.
    expect(goals.map((g) => g.targetCents)).toEqual(
      PLAN_DEFAULTS.goals.map((g) => g.targetCents),
    );
    expect(goals.map((g) => g.targetDate)).toEqual(PLAN_DEFAULTS.goals.map((g) => g.targetDate));
  });

  it("keeps the default's $700 healthcare line", () => {
    // Health is a budget line now, so this reads the budget rather than a plan scalar — and
    // there is no second "from 65" figure to keep, the step-down having gone with the fields
    // that drove it.
    expect(healthcareMonthlyCents(plan().budgetLines)).toBe(dollarsToCents(700));
    // Stated as the default's value, not as a literal that could drift apart from it.
    expect(healthcareMonthlyCents(plan().budgetLines)).toBe(
      healthcareMonthlyCents(PLAN_DEFAULTS.budgetLines),
    );
  });

  it("varies only the job, budget, retirement return and life expectancy", () => {
    // The three teaching scenarios DO drop the goals and trim health; this pins that
    // taxed-in-retirement is not one of them.
    const teaching = planOf(presetById("paycheck-to-paycheck"));
    expect(teaching.goals).toEqual([]);
    expect(healthcareMonthlyCents(teaching.budgetLines)).toBe(dollarsToCents(450));
    expect(plan().retirementReturnPct).toBe(4);
    expect(plan().lifeExpectancy).toBe(72);
  });
});

describe("the two graphs are one quantity", () => {
  /** The app's own wiring: the graph reads the engine's itemized spending, nothing else. */
  function budgetChart(preset: Preset) {
    const series = project(preset);
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
      const projection = projectionOf(presetById(id));
      const graphSurvives = projection.run(usJurisdiction).firstInsolventMonth === null;
      // Underwater is not out of money: the student-loan scenario opens negative yet pays
      // every bill, so the panel must not call retirement infeasible for a plan the graph
      // draws surviving. Read off the solved age now that no age is pinned — a household whose
      // authored plan survives to life expectancy can, at worst, stop when that plan already
      // stops, so SOME age has to be reachable.
      const solvedAge = projection.retirement(usJurisdiction).solution.fullRetirementAge;
      if (graphSurvives) expect(solvedAge).not.toBeNull();
    },
  );

  it("student-loan: an underwater opening still has a feasible retirement age", () => {
    const projection = projectionOf(presetById("student-loan"));
    expect(projection.run(usJurisdiction).series.months[0]!.netWorthRealCents).toBeLessThan(0);
    expect(projection.retirement(usJurisdiction).solution.fullRetirementAge).not.toBeNull();
  });
});
