import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  SYNTHETIC_CARD_ID,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { createProjectionBase } from "./projectionBase";
import { PLAN_DEFAULTS } from "./planDefaults";
import type { Plan } from "@finley/engine";

function endingNetWorthCents(budget: Plan): number {
  const series = replayLedger(emptyLedger, createProjectionBase(budget), nullJurisdiction);
  // Net worth is null once a plan goes insolvent (§5.1), so read the last KNOWN
  // value: the true final balance for a surviving plan, or the honest terminal
  // ("money runs out") value for one that doesn't.
  const known = series.months
    .map((m) => m.netWorthNominalCents)
    .filter((c): c is number => c !== null);
  return known[known.length - 1];
}

/** Nominal net worth at a given age under a jurisdiction (US = SS modelled). */
function netWorthAtAge(budget: Plan, age: number, jurisdiction = usJurisdiction): number {
  const series = replayLedger(emptyLedger, createProjectionBase(budget), jurisdiction);
  return series.months[(age - budget.currentAge) * 12].netWorthNominalCents!;
}

describe("createProjectionBase — retirement + Social Security wired into the graph (§5.4/§7)", () => {
  it("gives the projection person an SS basis: birth year (from age) and claiming age", () => {
    const base = createProjectionBase({ ...PLAN_DEFAULTS, currentAge: 40, ssClaimingAge: 68 });
    const p = base.initialPersons![0];
    expect(p.birthYear).toBe(base.startYear! - 40);
    expect(p.ssClaimingAge).toBe(68);
  });

  it("stops employment income at the retirement age — working longer ends richer", () => {
    // Same plan, later retirement = more earning years + fewer drawdown years, so a
    // later retirement leaves a strictly healthier terminal balance (retiring at 55
    // exhausts the plan; retiring at 70 survives with far more to spare).
    const early = endingNetWorthCents({ ...PLAN_DEFAULTS, retirementAge: 55 });
    const late = endingNetWorthCents({ ...PLAN_DEFAULTS, retirementAge: 70 });
    expect(late).toBeGreaterThan(early);
  });

  it("pays Social Security from the claiming age — it lifts late net worth vs a no-SS jurisdiction", () => {
    // The US jurisdiction models the benefit; the null one does not. Post-claim, the
    // SS income keeps the portfolio materially higher.
    const withSS = netWorthAtAge(PLAN_DEFAULTS, 80, usJurisdiction);
    const noSS = netWorthAtAge(PLAN_DEFAULTS, 80, nullJurisdiction);
    expect(withSS).toBeGreaterThan(noSS);
  });
});

describe("createProjectionBase — retirement decumulation liquidates instead of borrowing (#35)", () => {
  it("funds the default retiree from investments — the synthetic card never carries a balance", () => {
    // The reported defect: retirement spending exceeded income, drained the one liquid
    // account, then piled onto the unlimited synthetic 22% card while six-figure
    // investments compounded untouched. With the desired-withdrawal channel wired, the
    // shortfall is met by selling assets, so the card stays flat at 0 the whole horizon.
    const series = replayLedger(
      emptyLedger,
      createProjectionBase({ ...PLAN_DEFAULTS, retirementAge: 63 }),
      usJurisdiction,
    );
    for (const m of series.months) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
    }
  });

  it("funds late-retirement expenses by liquidating investments, staying solvent (not a -$2.1M crater)", () => {
    // Once the liquid buffer is spent down (D2), the shortfall is met by SELLING assets:
    // a taxable-fund sale re-enters as capitalGains at the chokepoint, and the fund it
    // came from shrinks. Previously this shortfall hit the 22% card and net worth cratered
    // to ~-$2.1M; now the plan stays solidly solvent.
    const budget = { ...PLAN_DEFAULTS, retirementAge: 63 };
    const series = replayLedger(emptyLedger, createProjectionBase(budget), usJurisdiction);
    // Decumulation actually fires: some retirement month liquidates a taxable investment,
    // surfacing as capitalGains income (the plan has no other capitalGains source).
    const liquidated = series.months.some(
      (m) => (m.flows?.incomeByCategoryCents["capitalGains"] ?? 0) > 0,
    );
    expect(liquidated).toBe(true);
    // Real net worth never craters — it stays positive through the whole horizon.
    const minRealNetWorth = Math.min(...series.months.map((m) => m.netWorthRealCents!));
    expect(minRealNetWorth).toBeGreaterThan(0);
  });
});

describe("createProjectionBase — horizon spans to life expectancy (§7)", () => {
  it("projects from now to life expectancy, not a fixed 30 years", () => {
    const project = (currentAge: number, lifeExpectancy: number) =>
      replayLedger(
        emptyLedger,
        createProjectionBase({ ...PLAN_DEFAULTS, currentAge, lifeExpectancy }),
        nullJurisdiction,
      ).months.length;
    // months are [0 … (life − now)*12] inclusive → +1.
    expect(project(35, 90)).toBe((90 - 35) * 12 + 1);
    expect(project(25, 95)).toBe((95 - 25) * 12 + 1);
    // A longer life means a longer projection — it is not clamped at 30 years.
    expect(project(35, 95)).toBeGreaterThan(project(35, 65));
  });
});

describe("createProjectionBase — health as its own additive, growing expense (§5.4)", () => {
  it("spends the health line: adding health lowers ending net worth", () => {
    // A plain saver — income idles to savings — so more spend means less saved.
    const base: Plan = {
      ...PLAN_DEFAULTS,
      incomeCents: dollarsToCents(6_000),
      expenseCents: dollarsToCents(3_000),
      goals: [],
      surplusSwept: false,
      retirementDeferralPct: 0,
    };
    const withoutHealth = endingNetWorthCents({ ...base, healthMonthlyCents: 0 });
    const withHealth = endingNetWorthCents({
      ...base,
      healthMonthlyCents: dollarsToCents(500),
    });
    expect(withHealth).toBeLessThan(withoutHealth);
  });

  it("grows the health line at its own rate: a higher rate spends more over the horizon", () => {
    const base: Plan = {
      ...PLAN_DEFAULTS,
      incomeCents: dollarsToCents(6_000),
      expenseCents: dollarsToCents(3_000),
      healthMonthlyCents: dollarsToCents(500),
      goals: [],
      surplusSwept: false,
      retirementDeferralPct: 0,
    };
    const flat = endingNetWorthCents({ ...base, healthInflationPct: 0 });
    const rising = endingNetWorthCents({ ...base, healthInflationPct: 8 });
    // The rising health line costs more cumulatively → less left in savings.
    expect(rising).toBeLessThan(flat);
  });

  it("steps health down at 65 when enrolling — self-funding for life spends more", () => {
    // A near-65 saver so the Medicare boundary (age 65) lands inside the horizon and
    // the two paths (step down vs. carry the pre-65 line) actually diverge. Income
    // runs through the horizon (retirementAge past life expectancy) so the household
    // stays solvent and the health-cost difference shows up in real net worth rather
    // than being masked by the finite synthetic-card insolvency floor (#36).
    const base: Plan = {
      ...PLAN_DEFAULTS,
      currentAge: 55,
      retirementAge: 90,
      incomeCents: dollarsToCents(6_000),
      expenseCents: dollarsToCents(3_000),
      healthMonthlyCents: dollarsToCents(1_000),
      postMedicareHealthMonthlyCents: dollarsToCents(400),
      healthInflationPct: 5,
      goals: [],
      surplusSwept: false,
      retirementDeferralPct: 0,
    };
    const enrolled = endingNetWorthCents({ ...base, enrollsInMedicare: true });
    const selfFunded = endingNetWorthCents({ ...base, enrollsInMedicare: false });
    // Enrolling drops health at 65 → less spent after 65 → more left in savings.
    expect(enrolled).toBeGreaterThan(selfFunded);
  });
});

describe("createProjectionBase — SS claiming vs reinvestment at high returns (§5.4)", () => {
  it("claiming at 62 wins at 10% returns: early benefits reinvested outrun the delayed credit", () => {
    // With the eligibility COLA bridge correct, delaying claiming pays a
    // proportionally larger benefit (0.70 / 1.00 / 1.24 of PIA at 62 / 67 / 70).
    // But the claiming adjustment is priced to be roughly fair at ~2-3% real; once
    // the portfolio return clears that, taking SS early and leaving it invested wins
    // even living to life expectancy. At 10% nominal (~7% real), claim-62 ends
    // richest at age 90, strictly ahead of 67, and 67 ahead of 70.
    const nwAt90 = (ssClaimingAge: number) =>
      netWorthAtAge(
        {
          ...PLAN_DEFAULTS,
          savingsReturnPct: 10,
          retirementReturnPct: 10,
          brokerageReturnPct: 10,
          ssClaimingAge,
        },
        90,
      );
    expect(nwAt90(62)).toBeGreaterThan(nwAt90(67));
    expect(nwAt90(67)).toBeGreaterThan(nwAt90(70));
  });
});
