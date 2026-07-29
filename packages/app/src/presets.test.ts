/**
 * The starter simulations a fresh session can load: a healthy default plus three teaching
 * scenarios — paycheck to paycheck, living on a credit card, and a student loan into
 * negative net worth. These tests pin each one's financial *shape*, so a tweak to the
 * numbers can't turn "living on credit" into a plan that quietly accumulates wealth.
 */

import { describe, it, expect } from "vitest";
import {
  interpretLedger,
  buildHouseholdSimInput,
  simulateHousehold,
  createProjectionBase,
  firstInsolventMonth,
  dollarsToCents,
  type ProjectionContext,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import {
  projectScenario,
  solveRetirement,
  evaluateFullRetirementAtAge,
} from "@finley/engine";
import { PRESETS, presetById, buildPresetLedger, type Preset } from "./presets";
import { buildPerLineBudgetData } from "./components/baseAdjustments/perLineBudget";
import { START_YEAR } from "./config";

const CTX: ProjectionContext = { jurisdiction: usJurisdiction, startYear: START_YEAR };

/** Reproduce the app's projection pipeline for a preset (plan + its seed events). */
function project(preset: Preset): ProjectionSeries {
  const base = createProjectionBase(preset.plan, CTX);
  const ledger = buildPresetLedger(base, preset.events);
  const household = interpretLedger(ledger, base);
  return simulateHousehold(buildHouseholdSimInput(household, base), usJurisdiction);
}

const realNetWorthAt = (series: ProjectionSeries, month: number): number | null =>
  series.months[month]?.netWorthRealCents ?? null;

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
    // The spend each scenario was tuned against, kept here as an independent source of truth
    // so a drift in the budget lines that changes the projection is caught.
    const AUTHORED_SPEND: Record<string, number> = {
      default: dollarsToCents(3500),
      "paycheck-to-paycheck": dollarsToCents(3600),
      "living-on-credit": dollarsToCents(3600),
      "student-loan": dollarsToCents(3000),
      "taxed-in-retirement": dollarsToCents(5500),
    };
    for (const preset of PRESETS) {
      const lines = preset.plan.budgetLines;
      // No lines opens the Base + Adjustments editor onto an empty spending chart.
      expect(lines.length).toBeGreaterThan(0);
      const total = lines.reduce(
        (sum, line) => sum + (line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0),
        0,
      );
      expect(total).toBe(AUTHORED_SPEND[preset.id]);
    }
  });

  it("default: builds real wealth across the working years and stays solvent", () => {
    const series = project(presetById("default"));
    const opening = realNetWorthAt(series, 0)!;
    const midCareer = realNetWorthAt(series, 120)!;
    expect(midCareer).toBeGreaterThan(opening * 3);
    expect(firstInsolventMonth(series)).toBeGreaterThan(120);
  });

  it("paycheck-to-paycheck: survives working years but barely accumulates and can't fund retirement", () => {
    const paycheck = project(presetById("paycheck-to-paycheck"));
    const wealthy = project(presetById("default"));
    const paycheckMid = realNetWorthAt(paycheck, 120)!;
    const wealthyMid = realNetWorthAt(wealthy, 120)!;
    // Afloat while earning — no debt spiral — but only a sliver of the default's wealth.
    expect(paycheckMid).toBeGreaterThan(0);
    expect(paycheckMid).toBeLessThan(wealthyMid * 0.25);
    // No emergency cushion means retirement is unfundable: insolvency lands around it.
    expect(firstInsolventMonth(paycheck)).not.toBeNull();
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
    expect(firstInsolventMonth(series)).not.toBeNull();
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
    const base = createProjectionBase(preset.plan, CTX);
    const household = interpretLedger(buildPresetLedger(base, preset.events), base);
    const series = simulateHousehold(buildHouseholdSimInput(household, base), usJurisdiction);
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
      const base = createProjectionBase(preset.plan, CTX);
      const ledger = buildPresetLedger(base, preset.events);
      const scenario = { plan: preset.plan, ledger };
      const graphSurvives =
        firstInsolventMonth(projectScenario(scenario, CTX)) === null;
      // Underwater is not out of money: the student-loan scenario opens negative yet pays
      // every bill, so the panel must not call retirement infeasible for a plan the graph
      // draws surviving.
      const pinnedWorks = evaluateFullRetirementAtAge(scenario, preset.plan.retirementAge, CTX)
        .feasible;
      if (graphSurvives) expect(pinnedWorks).toBe(true);
    },
  );

  it("student-loan: an underwater opening still has a feasible retirement age", () => {
    const preset = presetById("student-loan");
    const base = createProjectionBase(preset.plan, CTX);
    const scenario = { plan: preset.plan, ledger: buildPresetLedger(base, preset.events) };
    const series = projectScenario(scenario, CTX);
    expect(series.months[0]!.netWorthRealCents).toBeLessThan(0);
    expect(solveRetirement(scenario, CTX).fullRetirementAge).not.toBeNull();
  });
});
