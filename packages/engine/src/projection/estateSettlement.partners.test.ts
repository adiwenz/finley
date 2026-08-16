/**
 * **A household of two, and the estate the LAST of them leaves.**
 *
 * Two facts have to line up for a couple, and they are decided in different places. Which death
 * ends the household is {@link import("../job/personActiveWindow").memberHorizonReach}'s answer,
 * turned into `householdDeathMonthExclusive` by {@link
 * import("./buildHouseholdInput").buildHouseholdSimInput}; what the estate then owes is {@link
 * settleEstate}'s. The simulator settles only where the two coincide, so a partner who outlives
 * the primary must both extend the run AND be the death that licenses the settlement — get either
 * half wrong and a real death silently settles nothing at all, taking the retirement solver's
 * terminal test with it.
 *
 * The first death is not an ending. The survivor goes on being funded at full household cost, the
 * tax year the partner died in still closes in its own December and settles the following April,
 * and only the second death reaches the estate.
 */
import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { Projection } from "../index";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type ProjectionSeries,
  type SimOwnedSeries,
} from "./simulate";
import type { SimPerson } from "./simulate.types";
import { planOutcome } from "../retirement/retirementSolver";

const RATE = 0.25;

/** Flat 25%, scalar and breakdown rounded identically so the two reconcile. */
const flat25: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) => Math.round(((byCat.wages ?? 0) + (byCat.ordinaryIncome ?? 0)) * RATE),
  computeTaxByCategoryCents: (byCat) => {
    const out: Partial<Record<string, Cents>> = {};
    for (const category of ["wages", "ordinaryIncome"] as const) {
      const cents = byCat[category] ?? 0;
      if (cents > 0) out[category] = Math.round(cents * RATE);
    }
    return out;
  },
};

function account(id: string, ownerId: string, dollars: number, liquid = false): SimAccount {
  return new SimAccount({
    id,
    ownerId,
    liquid,
    taxProfile: liquid ? CASH_INTEREST_TAX_PROFILE : PRE_TAX_TAX_PROFILE,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/** Wages for one owner, ending where the series says — NOT where its owner dies. */
function wages(ownerId: string, monthlyDollars: number, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId,
    sourceId: `job:${ownerId}`,
  };
}

const MONTHS_PER_YEAR = 12;

function ownedSpending(ownerId: string, monthlyDollars: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId,
  };
}

const spending = (monthlyDollars: number): SimOwnedSeries => ownedSpending("p1", monthlyDollars);

/** A person who dies at `deathMonth` — the first month they are gone — or never. */
function person(id: string, deathMonth?: number): SimPerson {
  return {
    id,
    name: id,
    ...(deathMonth !== undefined
      ? { activeWindow: { startMonth: 0, endMonthExclusive: deathMonth } }
      : {}),
  };
}

/**
 * A two-person household whose LAST member dies at the horizon — the only shape that settles an
 * estate. `persons` carries each member's own window, so a partner may die long before it.
 */
function couple(
  horizonMonths: number,
  persons: SimPerson[],
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): ProjectionSeries {
  return simulateHousehold(
    {
      horizonMonths,
      householdDeathMonthExclusive: horizonMonths,
      annualInflationRate: 0,
      startYear: 2026,
      persons,
      accounts,
      incomeSeries: [],
      expenseSeries: [],
      ...overrides,
    },
    flat25,
  );
}

const settlementOf = (series: ProjectionSeries) => {
  const settlement = series.estateSettlement;
  if (settlement === undefined) throw new Error("expected an estate settlement");
  return settlement;
};

describe("Estate settlement — a household of two", () => {
  it("settles once, at the last member's death, and not at the first", () => {
    // Sam dies at month 12; Alex lives to the horizon at month 36. One settlement, dated the final
    // month — the run does not end, and nothing is settled, when the first of them dies.
    const series = couple(
      36,
      [person("p1"), person("p2", 12)],
      [account("cash", "p1", 100_000, true)],
      { expenseSeries: [spending(1_000)] },
    );
    expect(series.months.length).toBe(36);
    expect(settlementOf(series).month).toBe(35);
  });

  it("counts the dead partner's own accounts as estate assets", () => {
    // Ownership does not follow a person out of the household: Sam's account is still household
    // wealth at the end, and an estate that dropped it would understate what the heirs receive.
    const series = couple(
      24,
      [person("p1"), person("p2", 6)],
      [account("cash", "p1", 40_000, true), account("sams-ira", "p2", 60_000)],
    );
    const settlement = settlementOf(series);
    expect(settlement.totalAssetsCents).toBe(dollarsToCents(100_000));
    expect(settlement.terminalEconomicNetWorthCents).toBe(dollarsToCents(100_000));
  });

  it("stops the dead partner's wages at their death, so the estate inherits nothing they never earned", () => {
    // The income series runs the whole horizon; the active window is what ends it. Sam is paid for
    // six months of a twelve-month run, so the household banks six — not twelve — of them.
    const paidTo = (deathMonth: number | undefined): Cents => {
      const series = couple(
        12,
        [person("p1"), person("p2", deathMonth)],
        [account("cash", "p1", 0, true)],
        { incomeSeries: [wages("p2", 1_000)] },
      );
      return settlementOf(series).totalAssetsCents;
    };
    const wholeYear = paidTo(undefined);
    const halfYear = paidTo(6);
    expect(wholeYear).toBe(dollarsToCents(12_000) - Math.round(dollarsToCents(12_000) * RATE));
    expect(halfYear).toBe(dollarsToCents(6_000) - Math.round(dollarsToCents(6_000) * RATE));
  });

  it("prices the final year's tax over BOTH members, including one who died inside it", () => {
    // Both die in the same tax year, Sam in July and Alex in November, so the year closes in
    // neither a December nor an April — `settleEstate` prices it. Sam's seven months of wages are
    // as taxable as Alex's eleven, and an estate that walked only the surviving member would
    // under-charge by Sam's whole share.
    //
    // No liquid account and no spending: nothing is drawn, so the year's only income is wages and
    // the estate's tax is exactly a quarter of them.
    const series = couple(
      23,
      [person("p1", 23), person("p2", 19)],
      [account("cash", "p1", 0, true)],
      { incomeSeries: [wages("p1", 1_000), wages("p2", 1_000)] },
    );
    const settlement = settlementOf(series);
    // Year 1 is months 12–22: Alex is paid all eleven, Sam months 12–18, seven of them.
    const finalYearLiabilityCents = Math.round(
      (dollarsToCents(11_000) + dollarsToCents(7_000)) * RATE,
    );
    const instalmentsPaidCents = series.months
      .slice(12)
      .reduce((total, m) => total + m.flows!.taxCents, 0);
    // The year's whole liability, over both of them, is instalments plus the estate's balance —
    // nothing of Sam's seven months goes uncharged just because Sam died in July.
    expect(instalmentsPaidCents + settlement.finalTaxDueCents).toBe(finalYearLiabilityCents);
    // And what is left over is exactly the twelfth instalment the run had no December to pay: the
    // estimate saw both members' years, Sam's death included, and priced eleven of the twelve.
    expect(settlement.finalTaxDueCents).toBe(Math.round(finalYearLiabilityCents / 12));
    // The estate is worse off by exactly that unpaid balance.
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      settlement.totalAssetsCents - settlement.finalTaxDueCents,
    );
  });

  it("closes the dead partner's last tax year inside the household's life, not at the estate", () => {
    // Sam dies in October of year 0, having earned $40,000 that year. The first death is not an
    // ending, so that year closes in its OWN December and settles in its own April, out of the
    // surviving household — it is not carried a decade forward to the estate. Here it is settled
    // by the instalments alone: the year's estimate is a simulation of the year, so it already
    // knew Sam's wages stopped in September and paced the whole liability across the twelve.
    const series = couple(
      36,
      [person("p1"), person("p2", 10)],
      [account("cash", "p1", 100_000, true)],
      { incomeSeries: [wages("p2", 4_000, 9)] },
    );
    const yearZeroTaxCents = series.months
      .slice(0, 12)
      .reduce((total, m) => total + m.flows!.taxCents, 0);
    expect(yearZeroTaxCents).toBe(Math.round(dollarsToCents(40_000) * RATE));
    // Which leaves the following April nothing to charge…
    expect(series.months[15]!.flows!.taxCents).toBe(0);
    // …and the estate, dying two years later, no trace of the year Sam died in.
    expect(settlementOf(series).finalTaxDueCents).toBe(0);
  });
});

/**
 * **Which of the two dies first must not matter.** Every fixture above names `p1` as the survivor,
 * so nothing in this file yet distinguishes "the household outlives a member" from "the member at
 * index 0 outlives everyone" — and the engine has a `persons[0]` in every loop it writes. A rule
 * that quietly treats the first-listed person as the one who must be alive would pass all of them.
 *
 * So each fixture here is built from ROLES — survivor and first-to-die — and run twice with the
 * roles bound to opposite people, holding the person-relative economics identical: the same
 * accounts, the same spending, the same wages, owned by whoever is playing that part. The two runs
 * are then compared month for month. Anything that differs is a dependence on the label rather
 * than on the life, which is the regression this exists to catch.
 *
 * The household is the requested one: two 65-year-olds in 2026, one living to 90 and one to 75,
 * on $20,000 of savings, a $500,000 pre-tax account and $50,000 of taxable investments.
 */
describe("Estate settlement — a partner dying first, and the same run mirrored", () => {
  const AGE_AT_START = 65;
  /** The first month a member of this cohort is gone: they die on reaching `lifeExpectancy`. */
  const deathMonthAt = (lifeExpectancy: number): number =>
    (lifeExpectancy - AGE_AT_START) * MONTHS_PER_YEAR;
  const FIRST_DEATH = deathMonthAt(75);
  const LAST_DEATH = deathMonthAt(90);

  /** Who plays which part. Person ORDER is always `[p1, p2]`; only the roles move. */
  interface Cast {
    readonly survivor: string;
    readonly firstToDie: string;
  }
  const PARTNER_FIRST: Cast = { survivor: "p1", firstToDie: "p2" };
  const PRIMARY_FIRST: Cast = { survivor: "p2", firstToDie: "p1" };

  /** Taxable investments — the third profile, which `account` above does not reach. */
  function taxable(id: string, ownerId: string, dollars: number): SimAccount {
    return new SimAccount({
      id,
      ownerId,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(dollars),
      initialAnnualRate: 0,
    });
  }

  interface Fixture {
    readonly savings?: number;
    readonly retirement?: number;
    readonly brokerage?: number;
    readonly annualSpend?: number;
    /** Identical jobs for both, scheduled to run well past the first death. */
    readonly jobs?: boolean;
    /** Neither member dies early — the control for "did the death change anything?". */
    readonly bothLive?: boolean;
  }

  /**
   * The pre-tax account belongs to the member who dies FIRST, deliberately: it is the survivor's
   * only real source of money, so the mirror swaps who owns the wealth as well as who is left to
   * spend it. Ownership that failed to outlive its owner would show up here as an immediate
   * insolvency rather than as a rounding difference.
   */
  function household(cast: Cast, fixture: Fixture = {}): ProjectionSeries {
    const {
      savings = 20_000,
      retirement = 500_000,
      brokerage = 50_000,
      annualSpend = 48_000,
      jobs = false,
      bothLive = false,
    } = fixture;
    const dies = bothLive ? undefined : FIRST_DEATH;
    return couple(
      LAST_DEATH,
      [
        person("p1", cast.firstToDie === "p1" ? dies : undefined),
        person("p2", cast.firstToDie === "p2" ? dies : undefined),
      ],
      [
        account("savings", cast.survivor, savings, true),
        account("retirement", cast.firstToDie, retirement),
        taxable("brokerage", cast.survivor, brokerage),
      ],
      {
        expenseSeries: [ownedSpending(cast.survivor, annualSpend / MONTHS_PER_YEAR)],
        ...(jobs
          ? {
              incomeSeries: [
                wages(cast.survivor, 50_000 / MONTHS_PER_YEAR),
                wages(cast.firstToDie, 50_000 / MONTHS_PER_YEAR),
              ],
            }
          : {}),
      },
    );
  }

  /** Everything about a month that is a HOUSEHOLD fact rather than a person-scoped one. */
  const householdShape = (series: ProjectionSeries) =>
    series.months.map((m) => ({
      netWorth: m.netWorthNominalCents,
      insolvent: m.isInsolvent,
      tax: m.flows!.taxCents,
      balances: m.accountBalancesCents,
    }));

  const incomeAt = (series: ProjectionSeries, month: number): Record<string, Cents> =>
    Object.fromEntries(
      (series.months[month]!.flows!.incomeSources ?? []).map((s) => [s.sourceId, s.cashInflowCents]),
    );

  it("runs on past the first death and settles only at the last", () => {
    const series = household(PARTNER_FIRST);
    // The partner dies at 75 and the run does not so much as pause: it reaches the primary's 90th
    // year in full, and the estate is dated to the last month of it.
    expect(series.months.length).toBe(LAST_DEATH);
    expect(series.months[FIRST_DEATH]).toBeDefined();
    expect(settlementOf(series).month).toBe(LAST_DEATH - 1);
  });

  it("settles at the LAST death when the FIRST-listed person is the one who dies early", () => {
    // The same claim with the roles swapped: `persons[0]` dies at month 120 and the household goes
    // on without them for fifteen years. A rule keying the household's end to the first person
    // listed would end the run here, settle at month 119, and lose those years entirely.
    const series = household(PRIMARY_FIRST);
    expect(series.months.length).toBe(LAST_DEATH);
    expect(settlementOf(series).month).toBe(LAST_DEATH - 1);
  });

  /**
   * Both fixtures, and the second is the one with teeth. In the headline fixture every flow
   * belongs to the survivor, so the death moves no money and two mirrored runs are equal for a
   * reason that has nothing to do with symmetry. Giving both members a wage makes the death
   * economically real in each direction, so a rule exempting `persons[0]` from dying — or from
   * losing its income when it does — separates the pair.
   */
  const MIRRORED: readonly (readonly [string, Fixture])[] = [
    ["no person-scoped flows", {}],
    ["a wage each, ending at its owner's death", { jobs: true }],
  ];

  it("produces the identical household, month for month, whichever of them dies first", () => {
    for (const [name, fixture] of MIRRORED) {
      const shapes = [PARTNER_FIRST, PRIMARY_FIRST].map((cast) =>
        householdShape(household(cast, fixture)),
      );
      expect(shapes[0], name).toEqual(shapes[1]);
    }
  });

  it("settles the identical estate, and reaches the identical verdict, either way", () => {
    for (const [name, fixture] of MIRRORED) {
      const [partnerFirst, primaryFirst] = [PARTNER_FIRST, PRIMARY_FIRST].map((c) =>
        household(c, fixture),
      );
      expect(settlementOf(primaryFirst), name).toEqual(settlementOf(partnerFirst));
      expect(planOutcome(primaryFirst), name).toBe(planOutcome(partnerFirst));
    }
  });

  it("stops only the dead member's job, and leaves the survivor's untouched", () => {
    for (const cast of [PARTNER_FIRST, PRIMARY_FIRST]) {
      const series = household(cast, { jobs: true });
      const before = incomeAt(series, FIRST_DEATH - 1);
      const after = incomeAt(series, FIRST_DEATH);
      // Both were being paid the same wage, on schedules running to the horizon…
      expect(before[`job:${cast.survivor}`]).toBeGreaterThan(0);
      expect(before[`job:${cast.firstToDie}`]).toBe(before[`job:${cast.survivor}`]);
      // …and the death ends exactly one of them, at its own amount, in its own month.
      expect(after[`job:${cast.firstToDie}`]).toBeUndefined();
      expect(after[`job:${cast.survivor}`]).toBe(before[`job:${cast.survivor}`]);
      // Still solvent and still earning, so the household is plainly carrying on.
      expect(planOutcome(series)).toBe("survives");
    }
  });

  it("changes nothing at all when the member who dies had no money of their own to stop", () => {
    // The control. In the headline fixture every flow belongs to the survivor, so the partner's
    // death moves no income, no spending and no balance — and the run proves it by being byte for
    // byte the run in which nobody died early. Whatever this household's fate is, the first death
    // is not the cause of it.
    expect(householdShape(household(PARTNER_FIRST))).toEqual(
      householdShape(household(PARTNER_FIRST, { bothLive: true })),
    );
  });

  it("charges no final tax at the first death — the year closes normally around it", () => {
    // A settlement fired at the first death would have to price a final year, and the charge would
    // land in this month. On the solvent fixture — steady draws, so a steady instalment — the
    // death month is indistinguishable from the five around it, January though it is.
    const series = household(PARTNER_FIRST, { savings: 1_000, brokerage: 0, annualSpend: 12_000 });
    const around = series.months
      .slice(FIRST_DEATH - 2, FIRST_DEATH + 3)
      .map((m) => m.flows!.taxCents);
    expect(new Set(around).size).toBe(1);
    expect(around[2]).toBeGreaterThan(0);
  });

  it("has no estate at all until the household is actually over", () => {
    // The same fixture stopped at the first death, with no household death declared: a survivor is
    // still alive, so there is nothing to settle. `estateSettlement` is one field, so "exactly
    // once" is the difference between this and the run above.
    const stopped = simulateHousehold(
      {
        horizonMonths: FIRST_DEATH,
        annualInflationRate: 0,
        startYear: 2026,
        persons: [person("p1"), person("p2", FIRST_DEATH)],
        accounts: [account("savings", "p1", 20_000, true)],
        incomeSeries: [],
        expenseSeries: [],
      },
      flat25,
    );
    expect(stopped.estateSettlement).toBeUndefined();
    expect(settlementOf(household(PARTNER_FIRST)).month).toBe(LAST_DEATH - 1);
  });

  it("does not fail the plan at the first death when the survivor is left barely liquid", () => {
    // $1,000 of cash and no taxable investments at the moment the partner dies: judged as an
    // estate right then, the household is worth almost nothing outside a retirement account it
    // does not yet own outright, and the terminal test would fail it. It is not an estate. The
    // survivor lives another fifteen years on that account and dies ahead.
    for (const cast of [PARTNER_FIRST, PRIMARY_FIRST]) {
      const series = household(cast, {
        savings: 1_000,
        brokerage: 0,
        annualSpend: 12_000,
      });
      expect(series.months[FIRST_DEATH]!.isInsolvent).toBe(false);
      expect(series.months.slice(0, LAST_DEATH).every((m) => !m.isInsolvent)).toBe(true);
      expect(settlementOf(series).month).toBe(LAST_DEATH - 1);
      expect(settlementOf(series).terminalEconomicNetWorthCents).toBeGreaterThan(0);
      expect(planOutcome(series)).toBe("survives");
    }
  });
});

/**
 * The seam between the two decisions, exercised through the facade so the horizon really is
 * derived from the plan rather than handed to the simulator. The sample primary is 40 at 2026 with
 * an expectancy of 85, so they die at month 540.
 */
describe("Estate settlement — which death ends the household", () => {
  const PRIMARY_DEATH_MONTH = (85 - 40) * 12;

  function withPartner(birthYear: number, lifeExpectancy: number): ProjectionSeries {
    const projection = Projection.fromState(
      stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] }, budgetLines: [] }),
      nullJurisdiction,
    );
    projection.marry({ month: 12, name: "Sam", birthYear, lifeExpectancy });
    return projection.run(nullJurisdiction).series;
  }

  it("settles at the primary's death when the partner dies first", () => {
    // Sam, born 1976 at expectancy 85, dies in 2061 — fifteen years before the primary's 2071.
    // The primary's own death is what ends the household, and what the estate is dated to.
    const series = withPartner(1976, 85);
    expect(series.months.length).toBe(PRIMARY_DEATH_MONTH);
    expect(settlementOf(series).month).toBe(PRIMARY_DEATH_MONTH - 1);
  });

  it("runs on to the survivor and settles at THEIR death when the partner outlives the primary", () => {
    // Sam is born 1996 and reaches 85 in 2081, eleven years past the primary. Those eleven years
    // are inside the run, and the estate is settled at the end of them — the case where taking the
    // primary's death as the household's would settle early and leave the survivor unmodelled.
    const series = withPartner(1996, 85);
    const samsDeathMonth = (1996 + 85 - SAMPLE_START_YEAR) * 12;
    expect(samsDeathMonth).toBeGreaterThan(PRIMARY_DEATH_MONTH);
    expect(series.months.length).toBe(samsDeathMonth);
    expect(settlementOf(series).month).toBe(samsDeathMonth - 1);
  });

  it("settles when both die in the same month, which is one ending and not two", () => {
    // Same birth year and expectancy as the primary: one death month, reached once, settled once.
    const series = withPartner(SAMPLE_START_YEAR - 40, 85);
    expect(series.months.length).toBe(PRIMARY_DEATH_MONTH);
    expect(settlementOf(series).month).toBe(PRIMARY_DEATH_MONTH - 1);
  });
});
