/**
 * The starter simulations a fresh session can load (issue #119). Beyond the healthy
 * default, three teaching scenarios — living paycheck to paycheck, living on a credit
 * card, and carrying a student loan into negative net worth — each of which must
 * project to its intended financial *shape*, not merely exist. These tests pin that
 * shape so a future tweak to the numbers can't silently turn "living on credit" into a
 * plan that quietly accumulates wealth.
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

describe("default simulations (issue #119)", () => {
  it("offers the healthy default plus the teaching scenarios", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "default",
      "paycheck-to-paycheck",
      "living-on-credit",
      "student-loan",
      "taxed-in-retirement",
    ]);
    // Each preset carries a distinct, non-empty human label and description.
    for (const preset of PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
    // The first preset is the current fresh-plan default, unchanged.
    expect(PRESETS[0].plan).toEqual(presetById("default").plan);
  });

  it("every preset opens on an editable line-item budget totalling its authored spend", () => {
    for (const preset of PRESETS) {
      const lines = preset.plan.budgetLines ?? [];
      // A preset with no lines opens the Base + Adjustments editor onto an empty
      // spending chart — nothing to read, nothing to click.
      expect(lines.length).toBeGreaterThan(0);
      const total = lines.reduce(
        (sum, line) => sum + (line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0),
        0,
      );
      // Itemizing the spend must not move it: the lines replace the scalar series
      // wholesale, so their total is what the scenario was tuned against.
      expect(total).toBe(preset.plan.expenseCents);
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
    // Stays afloat while earning — no debt spiral — but accumulates only a sliver of
    // the default's wealth: the defining paycheck-to-paycheck signature.
    expect(paycheckMid).toBeGreaterThan(0);
    expect(paycheckMid).toBeLessThan(wealthyMid * 0.25);
    // No emergency cushion means retirement is unfundable: insolvency lands around it.
    expect(firstInsolventMonth(paycheck)).not.toBeNull();
  });

  it("living-on-credit: overspends from the start, accruing compounding credit-card debt", () => {
    const series = project(presetById("living-on-credit"));
    // Net worth turns negative within the first two years...
    expect(realNetWorthAt(series, 24)!).toBeLessThan(0);
    // ...specifically because the §5.1 cascade routes the monthly shortfall onto a
    // synthetic credit-card liability that compounds.
    const early = series.months[12]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    const later = series.months[36]?.liabilityBalancesCents["synthetic-credit-card"] ?? 0;
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);
    // The debt is unfinanceable long-term: the plan runs out of credit.
    expect(firstInsolventMonth(series)).not.toBeNull();
  });

  it("taxed-in-retirement: taxes Social Security meaningfully, unlike the default plan", () => {
    // The scenario's whole point: taxable 401(k) withdrawals fund retirement (the spend is
    // tuned high enough that cash doesn't pile up and cover it tax-free), so that ordinary
    // income lifts the benefit over the standard deduction and the government-benefit
    // category bears real tax across a run of retirement months.
    const series = project(presetById("taxed-in-retirement"));
    const ssTax = series.months.map((m) => {
      const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
      return byCat.governmentRetirementBenefit ?? 0;
    });
    expect(ssTax.filter((c) => c > 0).length).toBeGreaterThan(24); // taxed across years, not a blip
    // And meaningfully, not a rounding-scale $25/mo: it must clear a few hundred a month in
    // some retirement month — the guard against regressing to a cash-funded retirement where
    // SS is barely taxed.
    expect(Math.max(...ssTax)).toBeGreaterThan(dollarsToCents(300));
    // Contrast: the default plan never taxes the benefit at all.
    const defaultSSTaxed = project(presetById("default")).months.some((m) => {
      const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
      return (byCat.governmentRetirementBenefit ?? 0) > 0;
    });
    expect(defaultSSTaxed).toBe(false);
  });

  it("student-loan: opens underwater on a student loan, then digs out of it", () => {
    const series = project(presetById("student-loan"));
    // Net worth starts negative — assets minus the student-loan liability (§3).
    expect(realNetWorthAt(series, 0)!).toBeLessThan(0);
    // The loan is a real amortizing student-loan liability at "now", not a cash hack.
    expect(series.months[0]?.liabilityBalancesCents).toHaveProperty("loan-student");
    // A solid income services it: net worth climbs back above water within a decade.
    expect(realNetWorthAt(series, 120)!).toBeGreaterThan(0);
  });
});

describe("the two graphs are one quantity (issue #119 follow-up)", () => {
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
      // The spending graph splits the obligation by where the money goes; the income
      // graph's dashed line is the same obligation, as one number. If the two ever
      // disagree, some real spending is being drawn nowhere.
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

describe("the panel and the graph agree (#37)", () => {
  it.each(PRESETS.map((p) => p.id))(
    "%s: retirement is called infeasible only when the projection actually runs out",
    (id) => {
      const preset = presetById(id);
      const base = createProjectionBase(preset.plan, CTX);
      const ledger = buildPresetLedger(base, preset.events);
      const scenario = { plan: preset.plan, ledger };
      const graphSurvives =
        firstInsolventMonth(projectScenario(scenario, CTX)) === null;
      // Being underwater is not running out of money: the student-loan scenario opens
      // with negative net worth and pays every bill, and the panel must not answer "no
      // retirement age is feasible" for a plan the graph draws reaching age 90.
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
