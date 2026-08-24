import { describe, expect, it } from "vitest";
import { dollarsToCents, Projection } from "@finley/engine";
import { payrollTaxTables, usJurisdiction } from "@finley/rules";
import { PRESETS, presetById, presetState } from "./presets";
import { DEFAULT_INPUT, PLAN_DEFAULTS } from "./planDefaults";

const expenseTotal = (preset: (typeof PRESETS)[number]) =>
  (preset.input.budgetLines ?? []).reduce(
    (sum, line) =>
      sum +
      (line.target.kind === "expense" && line.amountSource.kind === "literal"
        ? line.amountSource.monthlyCents
        : 0),
    0,
  );

describe("presets", () => {
  it("offers the intended starter scenarios with user-facing labels and descriptions", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      "default",
      "paycheck-to-paycheck",
      "living-on-credit",
      "student-loan",
      "two-jobs",
      "career-break",
      "three-jobs",
      "bonus",
      "taxed-in-retirement",
      "cash-in-retirement",
      "partner-debt",
      "partner-proportional",
      "partner-even-split",
      "partner-separation",
      "partner-sequential",
    ]);
    for (const preset of PRESETS) {
      expect(preset.label).not.toBe("");
      expect(preset.description).not.toBe("");
    }
  });

  it("uses the same authored input as the fresh default instead of maintaining a second default", () => {
    expect(presetById("default").input).toBe(DEFAULT_INPUT);
    expect(presetState(presetById("default")).scenario.plan).toEqual(PLAN_DEFAULTS);
  });

  it("keeps each teaching scenario's authored budget non-empty", () => {
    for (const preset of PRESETS) {
      expect(preset.input.budgetLines?.length ?? 0).toBeGreaterThan(0);
      expect(expenseTotal(preset)).toBeGreaterThan(0);
    }
  });

  it("authors a seed timeline only for the student loan and the partner households", () => {
    const withEvents = PRESETS.filter((preset) => (preset.input.events?.length ?? 0) > 0);
    expect(withEvents.map((preset) => preset.id)).toEqual([
      "student-loan",
      "partner-debt",
      "partner-proportional",
      "partner-even-split",
      "partner-separation",
      "partner-sequential",
    ]);
    expect(presetById("student-loan").input.events?.[0]).toMatchObject({
      type: "takeLoan",
      kind: "studentLoan",
      month: 0,
    });
  });

  it("builds every preset through the public scenario-input path", () => {
    for (const preset of PRESETS) {
      const state = presetState(preset);
      expect(state.scenario.plan.primary.name).toBe(preset.input.name);
    }
  });

  it("lands the bonus preset's adjustment on its job, with an id the ENGINE minted", () => {
    const preset = presetById("bonus");
    const job = presetState(preset).scenario.plan.primary.jobs[0];
    expect(job?.incomeOverrides).toEqual([
      { id: expect.any(String), month: 5, kind: "addBonus", cents: 2_000_000 },
    ]);
    // Nothing the preset itself wrote — the adjustment goes through the same authoring call the
    // Base + Adjustments editor makes, so the preset states only the month, kind and amount.
    expect(preset.incomeAdjustments?.[0]?.override).not.toHaveProperty("id");
  });

  it("refuses a preset that adjusts a job it never authored", () => {
    expect(() =>
      presetState({
        ...presetById("bonus"),
        incomeAdjustments: [{ jobIndex: 3, override: { month: 0, kind: "addBonus", cents: 100 } }],
      }),
    ).toThrow(/never authored/);
  });

  it("gives the two-jobs preset two concurrent jobs on the one person", () => {
    const jobs = presetState(presetById("two-jobs")).scenario.plan.primary.jobs;
    expect(jobs).toHaveLength(2);
    // Both owned by the same person: the multiple-jobs correction is person-scoped, and a preset
    // that split them across a household would demonstrate the opposite of what it claims to.
    expect(new Set(jobs.map((job) => job.ownerId)).size).toBe(1);
  });

  /**
   * The Social Security preset, pinned end to end.
   *
   * Its whole claim is arithmetic no single employer can see, so the arithmetic is asserted here
   * rather than described: three salaries each under the wage base, a household over it, and an
   * April that hands the difference back.
   */
  it("gives the three-jobs preset three equal concurrent jobs on the one person", () => {
    const jobs = presetState(presetById("three-jobs")).scenario.plan.primary.jobs;
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((job) => job.ownerId)).size).toBe(1);
    // Equal by construction: an unequal set would raise the question of which job reached the cap.
    expect(new Set(jobs.map((job) => job.salary?.currentSalaryCents)).size).toBe(1);
  });

  it("keeps every salary under the Social Security wage base while the household clears it", () => {
    const jobs = presetState(presetById("three-jobs")).scenario.plan.primary.jobs;
    const salaryCents = jobs[0]!.salary!.currentSalaryCents;
    const wageBaseCents = payrollTaxTables(DEFAULT_INPUT.startYear).oasdiWageBaseCents;
    // Each employer withholds OASDI on every dollar it pays, because none of them ever reaches
    // the cap on its own — which is exactly why, between them, they overshoot.
    expect(salaryCents).toBeLessThan(wageBaseCents);
    expect(salaryCents * jobs.length).toBeGreaterThan(wageBaseCents);
  });

  it("turns that per-employer cap into a visible April refund", () => {
    const series = Projection.fromState(
      presetState(presetById("three-jobs")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const april = series.months[15]!.flows!;
    expect(april.taxSettlementCents).toBe(-459_231);
    expect(-april.taxSettlementCents).toBeGreaterThan(dollarsToCents(3_000));
    expect(-april.taxSettlementCents).toBeLessThan(dollarsToCents(10_000));
  });

  it("sizes that refund as the excess Social Security, net of what April also charges", () => {
    const jobs = presetState(presetById("three-jobs")).scenario.plan.primary.jobs;
    const { oasdiWageBaseCents, oasdiRate } = payrollTaxTables(DEFAULT_INPUT.startYear);
    const householdWagesCents = jobs[0]!.salary!.currentSalaryCents * jobs.length;
    const excessCreditCents = Math.round((householdWagesCents - oasdiWageBaseCents) * oasdiRate);
    expect(excessCreditCents).toBe(530_100);

    const series = Projection.fromState(
      presetState(presetById("three-jobs")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    // The credit is the whole reason April is a refund at all — everything else the filing settles
    // points the other way (the unwithheld Additional Medicare surtax, and income tax on savings
    // interest), so the money back is strictly smaller than the credit that caused it.
    expect(-series.months[15]!.flows!.taxSettlementCents).toBeLessThan(excessCreditCents);
  });

  it("keeps April a refund for the whole of the first twenty years", () => {
    const series = Projection.fromState(
      presetState(presetById("three-jobs")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const settlements = Array.from({ length: 20 }, (_, year) => {
      const month = 15 + year * 12;
      return [month, series.months[month]!.flows!.taxSettlementCents] as const;
    });
    // It does eventually become a balance due — the surtax threshold is unindexed and the
    // portfolio's untaxed-at-source interest grows — but not while the preset is being read.
    expect(settlements.filter(([, cents]) => cents >= 0)).toEqual([]);
  });

  it("stays solvent through the working years, so the refund is not read against a collapse", () => {
    const result = Projection.fromState(
      presetState(presetById("three-jobs")),
      usJurisdiction,
    ).run(usJurisdiction);
    expect(result.series.months.slice(0, 360).some((m) => m.isInsolvent)).toBe(false);
  });

  /**
   * The refund preset, pinned end to end.
   *
   * It exists to be looked at — it is the only scenario whose April hands money back at a scale a
   * chart can show — so the figures it produces are the ones manual QA compares against, and they
   * are held here rather than left to drift.
   */
  it("zeroes exactly the six unpaid months of the career-break preset", () => {
    const preset = presetById("career-break");
    const job = presetState(preset).scenario.plan.primary.jobs[0];
    expect(job?.incomeOverrides?.map((o) => o.month)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(job?.incomeOverrides?.every((o) => o.kind === "setTo" && o.cents === 0)).toBe(true);
  });

  it("turns that half-year into a visible April refund the following year", () => {
    const series = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const april = series.months[15]!.flows!;
    // Big enough to read off a chart, and the only preset in that range: every other April is a
    // balance DUE, of a few dollars to a few hundred.
    expect(april.taxSettlementCents).toBe(-454_011);
    expect(-april.taxSettlementCents).toBeGreaterThan(dollarsToCents(3_000));
    expect(-april.taxSettlementCents).toBeLessThan(dollarsToCents(10_000));
    // The refund exceeds the month's own withholding, so `taxCents` itself goes NEGATIVE — the
    // shape that made the tax chart's clamp visible in the first place.
    expect(april.taxCents).toBeLessThan(0);
  });

  it("keeps April's own withholding and FICA intact behind that refund", () => {
    const series = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const [march, april, may] = [14, 15, 16].map((m) => series.months[m]!.flows!);
    // Pay is level either side, so April's own withholding is its neighbours' — the refund
    // settles a different year and must not touch it.
    const withheld = (f: typeof april) => f.taxCents - f.taxSettlementCents;
    expect(withheld(april!)).toBe(withheld(march!));
    expect(withheld(april!)).toBe(withheld(may!));
    expect(april!.payrollTaxCents).toBe(march!.payrollTaxCents);
  });

  it("stays solvent throughout, so the refund is not read against a plan collapsing under it", () => {
    const result = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction);
    expect(result.series.months.slice(0, 24).some((m) => m.isInsolvent)).toBe(false);
  });

  /**
   * The retirement pair, which only teaches anything if the two really are one household with
   * one difference. Pinned so a later tuning pass cannot quietly make them incomparable.
   */
  it("differs from the taxed-in-retirement preset by the deferral and nothing else", () => {
    const taxed = presetById("taxed-in-retirement").input;
    const cash = presetById("cash-in-retirement").input;
    const { jobs: taxedJobs, name: _taxedName, ...taxedRest } = taxed;
    const { jobs: cashJobs, name: _cashName, ...cashRest } = cash;
    expect(cashRest).toEqual(taxedRest);
    expect(cashJobs).toHaveLength(1);
    expect(cashJobs![0]!.salary).toEqual(taxedJobs![0]!.salary);
    // The one difference: the same paycheck, saved after tax instead of before it.
    expect(taxedJobs![0]!).toHaveProperty("deferral");
    expect(cashJobs![0]!).not.toHaveProperty("deferral");
  });

  it("names itself as the comparison it is, so the pair reads as a pair in the picker", () => {
    const ids = PRESETS.map((preset) => preset.id);
    // Adjacent, and in that order — the taxed one is the scenario, this one is the answer to it.
    expect(ids.indexOf("cash-in-retirement")).toBe(ids.indexOf("taxed-in-retirement") + 1);
    expect(presetById("cash-in-retirement").description).toContain("Taxed in retirement");
  });

  it("pays materially less retirement tax than its twin, which is the whole comparison", () => {
    const retirementTaxCents = (id: string): number => {
      const series = Projection.fromState(presetState(presetById(id)), usJurisdiction).run(
        usJurisdiction,
      ).series;
      return series.months
        .filter((m) => m.flows !== undefined)
        .filter((m) => m.flows!.incomeSources.every((s) => s.category !== "wages"))
        .reduce((sum, m) => sum + m.flows!.taxCents + m.flows!.payrollTaxCents, 0);
    };
    expect(retirementTaxCents("cash-in-retirement")).toBeLessThan(
      retirementTaxCents("taxed-in-retirement"),
    );
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(presetById("missing")).toBe(PRESETS[0]);
  });
});

/**
 * The partner presets, pinned end to end against the live engine.
 *
 * Each claims something about WHOSE money pays, which is exactly what the household funding
 * model decides — so each is asserted on per-account balances rather than on household net
 * worth, the one figure that cannot tell two owners apart.
 */
describe("partner presets", () => {
  const runPreset = (id: string) =>
    Projection.fromState(presetState(presetById(id)), usJurisdiction).run(usJurisdiction).series;

  /** The partner's account ids are minted, so they are found by owner rather than written down. */
  const partnerAccount = (
    balances: Readonly<Record<string, number>>,
    kind: "savings" | "brokerage" | "retirement",
  ) => {
    const entry = Object.entries(balances).find(([id]) => id.startsWith(`${kind}-person-`));
    if (entry === undefined) throw new Error(`no partner ${kind} account among ${Object.keys(balances)}`);
    return entry[1];
  };

  it("gives every partner preset a second earner with accounts of their own", () => {
    for (const id of ["partner-debt", "partner-proportional", "partner-even-split", "partner-separation"]) {
      const months = runPreset(id).months;
      const owners = Object.keys(months[1]!.netWorthByPersonCents ?? {});
      // Two people, reported apart — the whole point of partner-owned accounts.
      expect(owners).toContain("p1");
      expect(owners.some((o) => o.startsWith("person-"))).toBe(true);
    }
  });

  it("drains the debtor's own account before the other partner backstops it", () => {
    const months = runPreset("partner-debt").months;
    // Blake owes the car loan and earns too little to cover it, so their own brokerage funds the
    // gap month after month until it is empty — never Alex's account while Blake still has one.
    expect(partnerAccount(months[1]!.accountBalancesCents, "brokerage")).toBeGreaterThan(0);
    expect(partnerAccount(months[12]!.accountBalancesCents, "brokerage")).toBeLessThan(
      partnerAccount(months[1]!.accountBalancesCents, "brokerage"),
    );
    expect(partnerAccount(months[24]!.accountBalancesCents, "brokerage")).toBe(0);

    // Once Blake's own money is gone, Alex carries the remainder: Alex's savings still grow on a
    // healthy salary, but markedly slower than over the same span before the backstop began.
    const alexAt = (m: number) => months[m]!.accountBalancesCents["savings"]!;
    const beforeBackstop = alexAt(18) - alexAt(12);
    const afterBackstop = alexAt(24) - alexAt(18);
    expect(afterBackstop).toBeLessThan(beforeBackstop);
    // Solvent right through the loan and long after: the household together could always pay it,
    // even across the years Blake alone could not. (The run still ends in insolvency in extreme
    // old age, which is the retirement trajectory, not this preset's claim.)
    expect(months.slice(0, 240).every((m) => !m.isInsolvent)).toBe(true);
  });

  it("keeps the debt assigned to its owner even once the other partner is paying it", () => {
    const events = presetState(presetById("partner-debt")).scenario.ledger.events;
    const partnering = events.find((e) => e.type === "RelationshipEvent");
    const loans = events.filter((e) => e.type === "LoanEvent");
    expect(loans).toHaveLength(1);
    // Authored to the partner the relationship event minted, and nothing in the projection moves
    // it to the person whose cash ends up covering it.
    const partnerId = (partnering as { person?: { id?: string } } | undefined)?.person?.id;
    expect(partnerId).toBeDefined();
    expect((loans[0] as { ownerId?: string }).ownerId).toBe(partnerId);
  });

  it("splits proportionally or evenly on the lever alone, leaving the household total alone", () => {
    const proportional = runPreset("partner-proportional").months;
    const even = runPreset("partner-even-split").months;
    const blake = (months: typeof proportional, m: number) =>
      partnerAccount(months[m]!.accountBalancesCents, "savings");

    // Blake earns far less than Alex. A proportional share fits inside Blake's take-home, so
    // their savings GROW; an even share does not, so the difference comes out of those savings.
    expect(blake(proportional, 120)).toBeGreaterThan(blake(proportional, 1));
    expect(blake(even, 120)).toBeLessThan(blake(even, 1));

    // The household spends the same either way — only WHO paid moved, so the totals stay within
    // a fraction of a percent of each other after a decade. Not identical: surplus banks to
    // whoever earned it, so the split decides which accounts hold the money, and accounts of
    // different kinds earn different returns.
    const householdAt = (months: typeof proportional, m: number) =>
      months[m]!.netWorthNominalCents ?? 0;
    const gap = Math.abs(householdAt(proportional, 120) - householdAt(even, 120));
    expect(gap / householdAt(proportional, 120)).toBeLessThan(0.01);
  });

  it("explains that the proportional lever weighs savings as well as pay", () => {
    // The pair exists to teach the lever, so the copy has to name what the lever now reads. A
    // description that still said "proportional to what they earn" would describe an engine that
    // charged Blake a share their $30,000 of savings had no part in.
    const proportional = presetById("partner-proportional").description;
    expect(proportional).toMatch(/savings/i);
    expect(proportional).not.toMatch(/proportional to what they earn/i);
    expect(presetById("partner-even-split").description).toMatch(/afford/i);
  });

  it("charges the partner with savings and no paycheck a share of the household", () => {
    // The teaching claim under the capacity rule, on the preset that teaches it: Blake earns
    // roughly a third of Alex but holds savings of their own, so Blake's share is larger than
    // their paycheck alone would buy — and Alex's is smaller than three times Blake's.
    const flows = runPreset("partner-proportional").months[12]!.flows!;
    const alex = flows.obligationChargedByPersonCents["p1"]!;
    const blake = Object.entries(flows.obligationChargedByPersonCents).find(([id]) =>
      id.startsWith("person-"),
    )![1];
    expect(alex + blake).toBe(flows.totalObligationsCents);
    const payRatio = 8_000 / 2_400;
    expect(alex / blake).toBeLessThan(payRatio);
    expect(alex).toBeGreaterThan(blake);
  });

  it("is identical between the two split presets apart from the lever itself", () => {
    const { sharedScheme: proportionalScheme, ...proportional } = presetById("partner-proportional").input;
    const { sharedScheme: evenScheme, ...even } = presetById("partner-even-split").input;
    expect(proportionalScheme).toBe("proportional");
    expect(evenScheme).toBe("even");
    // Everything else byte-identical, so the comparison the pair invites is genuinely one-variable.
    expect(proportional).toEqual(even);
  });

  it("takes the partner's accounts out of the household when they leave", () => {
    const months = runPreset("partner-separation").months;
    const SEPARATION_MONTH = 60;
    const before = months[SEPARATION_MONTH - 1]!;
    const after = months[SEPARATION_MONTH + 1]!;

    const blakeHeld =
      partnerAccount(before.accountBalancesCents, "savings") +
      partnerAccount(before.accountBalancesCents, "brokerage") +
      partnerAccount(before.accountBalancesCents, "retirement");
    expect(blakeHeld).toBeGreaterThan(dollarsToCents(150_000));

    // Every one of Blake's accounts leaves with Blake.
    expect(partnerAccount(after.accountBalancesCents, "savings")).toBe(0);
    expect(partnerAccount(after.accountBalancesCents, "brokerage")).toBe(0);
    expect(partnerAccount(after.accountBalancesCents, "retirement")).toBe(0);

    // Alex's own savings do not: nothing of theirs departs with the partner.
    expect(after.accountBalancesCents["savings"]!).toBeGreaterThan(
      before.accountBalancesCents["savings"]! * 0.9,
    );
    // Household net worth steps down by what Blake held, not by some pooled fraction of both.
    expect((before.netWorthNominalCents ?? 0) - (after.netWorthNominalCents ?? 0)).toBeGreaterThan(
      dollarsToCents(150_000),
    );
  });
});
