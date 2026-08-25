/**
 * "A new partner after separation", held to the thing a two-year gap exists to prove: that the
 * engine models three PEOPLE with their own windows, not one "partner" slot two names take turns
 * in. Blake leaves at month 60, Alex runs the household alone until month 84, and Casey joins
 * then with money, a paycheck and a career of their own.
 *
 * Everything here runs the real preset through the real engine and the real jurisdiction, because
 * the failures this file guards against are all failures of composition — a balance introduced at
 * the wrong month, an ex-partner's loan still in the budget, an April settlement deciding who owns
 * the rent. A fixture would have to restate the composition to test it.
 */

import { describe, expect, it } from "vitest";
import { Projection, dollarsToCents, eventAccountDescriptors } from "@finley/engine";
import type { Household, ProjectionSeries, ScenarioInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import {
  PRESETS,
  SEQUENTIAL_JOIN_MONTH,
  SEQUENTIAL_SEPARATION_MONTH,
  presetById,
  presetState,
} from "./presets";
import { START_YEAR } from "./config";
import { timelineMarkers } from "./ledgerView";
import {
  SHARED_SPENDING_BAND_ID,
  buildCashFlowChartData,
  cashFlowBandsForView,
  refundBandId,
} from "./components/baseAdjustments/cashFlowChartData";
import { buildTaxChartData } from "./components/baseAdjustments/taxesByMonth";
import { buildNetWorthBreakdown } from "./components/netWorthChart/netWorthBreakdown";
import { buildAccountBalanceData } from "./components/accountBalanceChart/accountBalanceSeries";

const PRESET_ID = "partner-sequential";
const SEPARATION = SEQUENTIAL_SEPARATION_MONTH;
const JOIN = SEQUENTIAL_JOIN_MONTH;
/** The last month of the two-year gap — Alex alone, and the only phase with no partner at all. */
const ALONE = JOIN - 1;

const fresh = () => Projection.fromState(presetState(presetById(PRESET_ID)), usJurisdiction);

/**
 * Ids are minted, so every one is looked up by the NAME the preset authored. Writing `person-8`
 * down would make this file agree with the engine's counter rather than with the household.
 */
function roster(household: Household) {
  const idOf = (name: string) => {
    const m = household.memberships.find((x) => x.person.name === name);
    if (m === undefined) throw new Error(`no household member named ${name}`);
    return m.person;
  };
  return { alex: idOf("Alex"), blake: idOf("Blake"), casey: idOf("Casey") };
}

const RUN = fresh().run(usJurisdiction);
const PEOPLE = roster(RUN.household);
const ALEX = PEOPLE.alex.id;
const BLAKE = PEOPLE.blake.id;
const CASEY = PEOPLE.casey.id;
const NAMES = new Map(RUN.household.memberships.map((m) => [m.person.id, m.person.name]));

const monthsOf = (series: ProjectionSeries) => series.months;
const flowsAt = (m: number) => {
  const f = RUN.series.months[m]?.flows;
  if (f === undefined) throw new Error(`month ${m} has no flows`);
  return f;
};
/** Every person's charged share of the month's obligations, ex-partners included as an explicit 0. */
const sharesAt = (m: number) => flowsAt(m).obligationChargedByPersonCents;

describe("who is in the household, and when", () => {
  it("runs Alex+Blake, then Alex alone, then Alex+Casey, at exactly the authored boundaries", () => {
    const names = (m: number) => RUN.membersAt(m).map((p) => p.name).sort();
    expect(names(0)).toEqual(["Alex", "Blake"]);
    expect(names(SEPARATION - 1)).toEqual(["Alex", "Blake"]);
    expect(names(SEPARATION)).toEqual(["Alex"]);
    expect(names(ALONE)).toEqual(["Alex"]);
    expect(names(JOIN)).toEqual(["Alex", "Casey"]);
    expect(names(JOIN + 1)).toEqual(["Alex", "Casey"]);

    // The windows themselves, so the boundary is a fact about the membership and not just about
    // the two months either side of it that the check above happens to sample.
    const window = (id: string) => {
      const m = RUN.household.memberships.find((x) => x.person.id === id)!;
      return [m.startMonth, m.endMonth];
    };
    expect(window(ALEX)).toEqual([-Infinity, null]);
    expect(window(BLAKE)[1]).toBe(SEPARATION);
    expect(window(CASEY)).toEqual([JOIN, null]);
  });

  it("ages Casey along the household's timeline rather than re-reading their birth year", () => {
    // 32 when the projection opens, 39 in year 7 — the seven elapsed years, and the reason the
    // preset states an age at start and a join MONTH rather than an age at joining.
    const ageAt = (birthYear: number, month: number) => START_YEAR + Math.floor(month / 12) - birthYear;
    expect(ageAt(PEOPLE.casey.birthYear, 0)).toBe(32);
    expect(ageAt(PEOPLE.casey.birthYear, JOIN)).toBe(39);
    expect(ageAt(PEOPLE.alex.birthYear, 0)).toBe(35);
    expect(ageAt(PEOPLE.blake.birthYear, 0)).toBe(37);
  });

  it("points 'separate' at whichever partner is actually there, and at nobody in the gap", () => {
    expect(RUN.activePartnerAt(0)?.name).toBe("Blake");
    expect(RUN.activePartnerAt(SEPARATION - 1)?.name).toBe("Blake");
    expect(RUN.activePartnerAt(SEPARATION)).toBeNull();
    expect(RUN.activePartnerAt(ALONE)).toBeNull();
    expect(RUN.activePartnerAt(JOIN)?.name).toBe("Casey");

    // And the engine refuses a second separation for someone who has already gone, rather than
    // recording one that would silently do nothing.
    expect(() => fresh().separate({ month: 70, partnerPersonId: BLAKE })).toThrow(
      /person "[^"]+" is already separated/,
    );
    expect(() => fresh().separate({ month: 100, partnerPersonId: CASEY })).not.toThrow();
  });
});

describe("income follows membership", () => {
  it("stops Blake's wages at month 60 and starts Casey's at month 84", () => {
    const wagesOf = (m: number, ownerId: string) =>
      flowsAt(m)
        .incomeSources.filter((s) => s.ownerId === ownerId && s.category === "wages")
        .reduce((sum, s) => sum + s.cashInflowCents, 0);

    expect(wagesOf(SEPARATION - 1, BLAKE)).toBeGreaterThan(0);
    expect(wagesOf(SEPARATION, BLAKE)).toBe(0);
    expect(wagesOf(ALONE, BLAKE)).toBe(0);

    expect(wagesOf(ALONE, CASEY)).toBe(0);
    expect(wagesOf(JOIN, CASEY)).toBeGreaterThan(0);

    // Through all three phases the household's wages are exactly the members' — during the gap,
    // Alex's alone.
    for (const m of [12, SEPARATION - 1, SEPARATION, ALONE, JOIN, JOIN + 12]) {
      const total = flowsAt(m)
        .incomeSources.filter((s) => s.category === "wages")
        .reduce((sum, s) => sum + s.cashInflowCents, 0);
      expect(total).toBe(wagesOf(m, ALEX) + wagesOf(m, BLAKE) + wagesOf(m, CASEY));
    }
    expect(wagesOf(ALONE, ALEX)).toBe(
      flowsAt(ALONE).incomeSources.filter((s) => s.category === "wages").reduce((s, x) => s + x.cashInflowCents, 0),
    );
  });

  it("clips each partner's income series to their own window, not to the job's authored end", () => {
    const incomeOf = (ownerId: string) =>
      RUN.household.series.filter((s) => s.ownerId === ownerId && s.seriesType === "income");
    // Blake's job runs to their own age 67; the separation ends the wages twenty-odd years early.
    for (const s of incomeOf(BLAKE)) expect(s.endMonth).toBe(SEPARATION - 1);
    for (const s of incomeOf(CASEY)) expect(s.startMonth).toBe(JOIN);
  });

  it("moves each filer's withholding with them", () => {
    const jobKey = (personId: string) => `job:${PEOPLE[personId === BLAKE ? "blake" : "casey"].jobs[0]!.id}`;
    const blakeJob = jobKey(BLAKE);
    const caseyJob = jobKey(CASEY);

    const taxed = (m: number) => Object.keys(flowsAt(m).taxBySourceCents);
    const fica = (m: number) => Object.keys(flowsAt(m).payrollTaxBySourceCents);

    expect(taxed(SEPARATION - 1)).toContain(blakeJob);
    expect(fica(SEPARATION - 1)).toContain(blakeJob);
    expect(taxed(SEPARATION + 3)).not.toContain(blakeJob);
    expect(fica(SEPARATION + 3)).not.toContain(blakeJob);

    expect(taxed(ALONE)).not.toContain(caseyJob);
    expect(taxed(JOIN + 3)).toContain(caseyJob);
    expect(fica(JOIN + 3)).toContain(caseyJob);
  });
});

describe("accounts follow membership, and stay owned by whoever brought them", () => {
  it("takes Blake's three balances out of household net worth at month 60", () => {
    const before = RUN.series.months[SEPARATION - 1]!;
    const after = RUN.series.months[SEPARATION]!;
    const blakeHeld = before.netWorthByPersonCents![BLAKE]!;
    expect(blakeHeld).toBeGreaterThan(dollarsToCents(150_000));
    expect(after.netWorthByPersonCents![BLAKE]).toBe(0);
    for (const kind of ["savings", "retirement", "brokerage"]) {
      expect(before.accountBalancesCents[`${kind}-${BLAKE}`]).toBeGreaterThan(0);
      expect(after.accountBalancesCents[`${kind}-${BLAKE}`]).toBe(0);
    }
  });

  it("holds nothing of either partner's through the gap", () => {
    for (const m of [SEPARATION, SEPARATION + 12, ALONE]) {
      const month = RUN.series.months[m]!;
      expect(month.netWorthByPersonCents![BLAKE]).toBe(0);
      expect(month.netWorthByPersonCents![CASEY]).toBe(0);
      expect(month.netWorthNominalCents).toBe(month.netWorthByPersonCents![ALEX]);
    }
  });

  it("introduces Casey's balances once, at month 84, and never backdates them", () => {
    // $15k savings + $60k retirement + $45k brokerage, arriving at their authored nominal figures
    // — a month's growth on top and not seven years of it, which is what a backdated opening
    // balance would look like.
    for (let m = 0; m < JOIN; m++) {
      expect(RUN.series.months[m]!.netWorthByPersonCents![CASEY]).toBe(0);
    }
    const arriving = RUN.series.months[JOIN]!.netWorthByPersonCents![CASEY]!;
    expect(arriving).toBeGreaterThan(dollarsToCents(120_000));
    expect(arriving).toBeLessThan(dollarsToCents(125_000));

    // Introduced, not re-introduced: after the first month Casey's holdings only ever move by
    // ordinary saving and growth, so no later month shows a second $120,000 step.
    for (let m = JOIN + 1; m < JOIN + 60; m++) {
      const step =
        RUN.series.months[m]!.netWorthByPersonCents![CASEY]! -
        RUN.series.months[m - 1]!.netWorthByPersonCents![CASEY]!;
      expect(step).toBeLessThan(dollarsToCents(20_000));
    }
  });

  it("keeps all nine accounts on their own owner, and moves no balance between people", () => {
    const owners = new Map(RUN.household.accounts.map((a) => [a.id, a.owners]));
    for (const holders of owners.values()) {
      // Every account names exactly one person. Nothing is jointly held, which is what lets a
      // separation decide where a balance goes without splitting anything.
      expect(holders).toHaveLength(1);
    }
    expect(owners.get(`savings-${BLAKE}`)).toEqual([BLAKE]);
    expect(owners.get(`savings-${CASEY}`)).toEqual([CASEY]);
    expect(owners.get("savings")).toEqual([ALEX]);
    expect(new Set([...owners.values()].map((h) => h[0]!)).size).toBe(3);

    // Alex's own money is untouched by either transition: nothing of Blake's stays behind and
    // nothing of Alex's leaves with them, so Alex's line steps by an ordinary month's saving in
    // the boundary month itself — compared against the month AFTER, which is the first full
    // month of the new arrangement. (Comparing backwards would not work, and should not: Alex's
    // share of the budget genuinely changes at each boundary, which is the point.)
    const alexAt = (m: number) => RUN.series.months[m]!.netWorthByPersonCents![ALEX]!;
    for (const boundary of [SEPARATION, JOIN]) {
      const step = alexAt(boundary) - alexAt(boundary - 1);
      const settled = alexAt(boundary + 1) - alexAt(boundary);
      expect(step).toBeGreaterThan(0);
      expect(Math.abs(step - settled)).toBeLessThan(dollarsToCents(100));
    }
  });
});

describe("shared spending is allocated to the household that exists this month", () => {
  it("splits by the percentage each partnership authored, between the two people who are here", () => {
    // Alex and Blake authored 70/30. Alex alone carries 100%. Casey's partnership authored
    // nothing and therefore runs at the 50/50 default — Casey does not inherit Blake's 30.
    const share = (m: number, id: string) => sharesAt(m)[id] ?? 0;
    const ratio = (m: number, id: string) => share(m, id) / flowsAt(m).totalObligationsCents;

    expect(ratio(12, ALEX)).toBeCloseTo(0.7, 4);
    expect(ratio(12, BLAKE)).toBeCloseTo(0.3, 4);

    expect(share(ALONE, ALEX)).toBe(flowsAt(ALONE).totalObligationsCents);
    expect(share(ALONE, BLAKE)).toBe(0);
    expect(share(ALONE, CASEY)).toBe(0);

    expect(ratio(JOIN + 12, ALEX)).toBeCloseTo(0.5, 4);
    expect(ratio(JOIN + 12, CASEY)).toBeCloseTo(0.5, 4);
    expect(share(JOIN + 12, BLAKE)).toBe(0);
  });

  it("assigns every cent of an odd budget, so the two shares are the household's exactly", () => {
    // Cumulative rounding, not two independent multiplications: 70% and 30% of a budget ending
    // in an odd cent would otherwise leave a cent unattributed in about half of all months.
    const wrong: string[] = [];
    for (const month of RUN.series.months) {
      const f = month.flows;
      if (f === undefined) continue;
      const total = Object.values(f.obligationChargedByPersonCents).reduce((s, c) => s + c, 0);
      if (total !== f.totalObligationsCents) wrong.push(`month ${month.month}: ${total} of ${f.totalObligationsCents}`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives Blake no share of anything after they leave", () => {
    for (let m = SEPARATION; m < RUN.series.months.length; m++) {
      const flows = RUN.series.months[m]?.flows;
      if (flows === undefined) continue;
      expect(flows.obligationChargedByPersonCents[BLAKE] ?? 0).toBe(0);
    }
  });

  it("hands every cent of every month's spending to somebody who is in the household", () => {
    const wrong: string[] = [];
    for (const month of RUN.series.months) {
      const f = month.flows;
      if (f === undefined) continue;
      const charged = Object.entries(f.obligationChargedByPersonCents);
      const total = charged.reduce((sum, [, c]) => sum + c, 0);
      if (total !== f.totalObligationsCents) {
        wrong.push(`month ${month.month}: charged ${total} of ${f.totalObligationsCents}`);
      }
      const members = new Set(RUN.membersAt(month.month).map((p) => p.id));
      for (const [id, cents] of charged) {
        if (cents !== 0 && !members.has(id)) wrong.push(`month ${month.month}: ${id} charged ${cents} while away`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("hands the whole budget to Alex in the gap, rather than half of it to nobody", () => {
    // The denominator is the household that exists this month. Splitting across the run's whole
    // roster would charge Alex a third of the rent and leave the rest on two people who are not
    // here — a sum that still balances and describes nothing.
    for (let m = SEPARATION; m < JOIN; m++) {
      const f = RUN.series.months[m]!.flows!;
      expect(f.obligationChargedByPersonCents[ALEX]).toBe(f.totalObligationsCents);
    }
  });

  it("leaves the split alone in the months a tax settlement lands", () => {
    // April moves take-home in opposite directions for the same reason — the under-withheld
    // partner pays and the over-withheld one collects. A split that read either would swing the
    // whole budget onto whoever happened to be owed money and swing it back in May. This one
    // reads neither, so each April's percentages are the March and May percentages exactly.
    const APRILS = [15, 51, 99];
    for (const april of APRILS) {
      expect(Object.keys(flowsAt(april).taxSettlementByPersonCents).length).toBeGreaterThan(0);
      for (const id of [ALEX, BLAKE, CASEY]) {
        const pct = (m: number) => (sharesAt(m)[id] ?? 0) / flowsAt(m).totalObligationsCents;
        expect(pct(april)).toBeCloseTo(pct(april - 1), 4);
        expect(pct(april)).toBeCloseTo(pct(april + 1), 4);
      }
    }
  });
});

describe("debts and taxes stay with the person who owns them", () => {
  /** Blake's car loan — the optional debt the scenario invites, authored while Blake is here. */
  const withBlakeLoan = () => {
    const q = fresh();
    q.carryLoan({
      ownerId: BLAKE,
      kind: "auto",
      balanceCents: dollarsToCents(60_000),
      apr: 0.07,
      remainingTermMonths: 12 * 10,
    });
    return q;
  };

  it("drops a departed partner's loan out of the household's budget entirely", () => {
    const q = withBlakeLoan();
    const withLoan = monthsOf(q.run(usJurisdiction).series);
    const baseline = monthsOf(RUN.series);

    // While Blake is here the payment is part of the household's obligations and charged to Blake.
    expect(withLoan[12]!.flows!.totalObligationsCents).toBeGreaterThan(baseline[12]!.flows!.totalObligationsCents);
    expect(withLoan[12]!.flows!.obligationChargedByPersonCents[BLAKE]).toBeGreaterThan(
      baseline[12]!.flows!.obligationChargedByPersonCents[BLAKE]!,
    );
    // The loan still has six years to run at the separation, and none of them are Alex's.
    for (const m of [SEPARATION, SEPARATION + 12, ALONE, JOIN, JOIN + 12]) {
      expect(withLoan[m]!.flows!.totalObligationsCents).toBe(baseline[m]!.flows!.totalObligationsCents);
    }
    const liability = q.run(usJurisdiction).household.liabilities.find((l) => l.ownerId === BLAKE);
    expect(liability?.endMonth).toBe(SEPARATION);
  });

  it("cannot charge Alex for a debt of Casey's before Casey is in the household", () => {
    // A Casey-owned holding dated at the now marker would otherwise charge the household from
    // month 0 — seven years of payments on a debt belonging to somebody who is not in it — so it
    // is refused where the month and the owner are both still in front of the author.
    expect(() =>
      fresh().carryLoan({
        ownerId: CASEY,
        kind: "auto",
        balanceCents: dollarsToCents(30_000),
        apr: 0.07,
        remainingTermMonths: 12 * 10,
      }),
    ).toThrow(/is not in the household at month -1; they join at month 84/);

    // Dated inside Casey's own window it is fine, and it costs the household nothing beforehand.
    const q = fresh();
    q.takeLoan({
      month: JOIN + 6,
      ownerId: CASEY,
      kind: "creditCard",
      openingBalanceCents: dollarsToCents(20_000),
      apr: 0.2,
      creditLimitCents: dollarsToCents(30_000),
    });
    const withCard = monthsOf(q.run(usJurisdiction).series);
    for (const m of [0, 12, SEPARATION, ALONE, JOIN]) {
      expect(withCard[m]!.flows!.totalObligationsCents).toBe(RUN.series.months[m]!.flows!.totalObligationsCents);
    }
    expect(withCard[JOIN + 12]!.flows!.totalObligationsCents).toBeGreaterThan(
      RUN.series.months[JOIN + 12]!.flows!.totalObligationsCents,
    );
  });

  it("refuses to hand a person-owned event to a partner who is not there for it", () => {
    const card = {
      kind: "creditCard" as const,
      openingBalanceCents: dollarsToCents(5_000),
      apr: 0.2,
      creditLimitCents: dollarsToCents(10_000),
    };
    expect(() => fresh().takeLoan({ ...card, month: JOIN + 6, ownerId: BLAKE })).toThrow(
      /is not in the household at month 90; they left at month 60/,
    );
    expect(() => fresh().takeLoan({ ...card, month: 12, ownerId: CASEY })).toThrow(
      /is not in the household at month 12; they join at month 84/,
    );
    // The same months, the other way round, are ordinary authoring.
    expect(() => fresh().takeLoan({ ...card, month: 12, ownerId: BLAKE })).not.toThrow();
    expect(() => fresh().takeLoan({ ...card, month: JOIN + 6, ownerId: CASEY })).not.toThrow();
  });

  it("settles a pending April on whoever earned the year, however the household has changed", () => {
    // Blake separates in the December-to-April window, so the bill for the year they worked is
    // still theirs — and Alex's filing is unaffected by it either way.
    const q = fresh();
    const blakeJob = PEOPLE.blake.jobs[0]!.id;
    for (let m = 6; m < 12; m++) q.addJobIncomeOverride(blakeJob, { month: m, kind: "setTo", cents: 0 });
    const refundApril = monthsOf(q.run(usJurisdiction).series)[15]!.flows!;
    // Over-withheld against a year that stopped early: the refund is Blake's, and a refund, not a
    // credit against Alex's bill.
    expect(refundApril.taxSettlementByPersonCents[BLAKE]).toBeLessThan(0);
    expect(refundApril.taxSettlementByPersonCents[ALEX]).toBeGreaterThan(0);

    // After the separation there is nothing of Blake's left to settle, in any April.
    for (const april of [SEPARATION + 3, SEPARATION + 15, JOIN + 3]) {
      expect(flowsAt(april).taxSettlementByPersonCents[BLAKE]).toBeUndefined();
    }
    // And nothing of Casey's before they arrive.
    for (const april of [15, 51]) {
      expect(flowsAt(april).taxSettlementByPersonCents[CASEY]).toBeUndefined();
    }
  });

  it("bands each refund to the filer who got it, and to nobody else", () => {
    const refundRun = (jobId: string, from: number) => {
      const q = fresh();
      for (let m = from; m < from + 6; m++) q.addJobIncomeOverride(jobId, { month: m, kind: "setTo", cents: 0 });
      return q.run(usJurisdiction).series;
    };
    const bandAt = (series: ProjectionSeries, month: number) => {
      const row = buildCashFlowChartData(series).rows.find((r) => r.month === month)!;
      return Object.fromEntries(
        Object.entries(row.inflowCentsByBand).filter(([id]) => id.startsWith(refundBandId(""))),
      );
    };
    // Blake's refund lands in Blake's band while Blake is still here…
    const blakeRefund = refundRun(PEOPLE.blake.jobs[0]!.id, 6);
    expect(Object.keys(bandAt(blakeRefund, 15))).toEqual([refundBandId(BLAKE)]);
    // …and Casey's in Casey's, only after Casey has joined.
    const caseyRefund = refundRun(PEOPLE.casey.jobs[0]!.id, JOIN + 6);
    expect(Object.keys(bandAt(caseyRefund, JOIN + 15))).toEqual([refundBandId(CASEY)]);
    expect(Object.keys(bandAt(caseyRefund, 15))).not.toContain(refundBandId(CASEY));
  });
});

describe("what the authored split does, and does not, respond to", () => {
  const shareOf = (series: ProjectionSeries, month: number, id: string) => {
    const f = series.months[month]!.flows!;
    return (f.obligationChargedByPersonCents[id] ?? 0) / f.totalObligationsCents;
  };

  it("holds Alex and Blake at 70/30 for every month of their partnership", () => {
    // Not one figure at one month: every month of it. Pay grows, balances grow, benefits start,
    // Aprils come and go, and none of them is a reason for a number the household wrote down to
    // change. The two shares are within a cent of 70/30 in all sixty months.
    const wrong: string[] = [];
    for (let m = 0; m < SEPARATION; m++) {
      const alex = shareOf(RUN.series, m, ALEX);
      const blake = shareOf(RUN.series, m, BLAKE);
      if (Math.abs(alex - 0.7) > 0.001 || Math.abs(blake - 0.3) > 0.001) {
        wrong.push(`month ${m}: ${alex.toFixed(4)} / ${blake.toFixed(4)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("does not move when a partner's savings arrive with them", () => {
    // Casey brings $15k cash, $45k brokerage and $60k of retirement, and Alex by year 7 holds
    // considerably more. A split that weighed balances would open at something other than half;
    // this one opens at half, on the month Casey arrives and on every month after.
    expect(shareOf(RUN.series, ALONE, CASEY)).toBe(0);
    expect(shareOf(RUN.series, JOIN, CASEY)).toBeCloseTo(0.5, 3);
    expect(shareOf(RUN.series, JOIN + 60, CASEY)).toBeCloseTo(0.5, 3);
  });

  it("does not move when the household's earnings do", () => {
    // Blake earns $5,000 against Alex's $7,000 for the whole partnership and carries 30% of it;
    // Casey earns $4,000 against Alex's grown salary and carries 50%. Whatever explains the two
    // numbers, it is not the paychecks.
    expect(shareOf(RUN.series, SEPARATION - 1, BLAKE)).toBeCloseTo(0.3, 3);
    expect(shareOf(RUN.series, SEPARATION, BLAKE)).toBe(0);
    expect(shareOf(RUN.series, SEPARATION, ALEX)).toBe(1);
  });

  it("gives each partnership its own number, with nothing carried between them", () => {
    expect(shareOf(RUN.series, 12, ALEX)).toBeCloseTo(0.7, 3);
    expect(shareOf(RUN.series, JOIN + 12, ALEX)).toBeCloseTo(0.5, 3);
    // The 30 left with Blake. Casey's partnership starts from the default, not from it.
    for (let m = SEPARATION; m < JOIN; m++) expect(shareOf(RUN.series, m, ALEX)).toBe(1);
  });

  it("keeps a Social Security claim from re-deciding anything", () => {
    // Both partners' benefits start inside the run, which is the single biggest change to who
    // earns what across the whole projection — and the percentages step at neither claim.
    const benefitMonths = RUN.series.months.filter(
      (m) => m.flows?.incomeSources.some((s) => s.category === "governmentRetirementBenefit") === true,
    );
    expect(benefitMonths.length).toBeGreaterThan(0);
    for (const month of benefitMonths) {
      // Only while both are alive: Alex is 35 at the start and lives to 90, and Casey outlives
      // them by five years. Casey carrying everything after that is a change in who is here,
      // not a change to what anybody authored.
      if (month.month < JOIN || month.month >= (90 - 35) * 12) continue;
      expect(shareOf(RUN.series, month.month, ALEX)).toBeCloseTo(0.5, 3);
    }
  });

  it("leaves a one-time spend drawing its named accounts in its named order", () => {
    // The sharing rule decides who OWES the recurring budget. It has no business anywhere near
    // an explicitly-funded draw, which spends the accounts the author picked, in their order.
    const SPEND = dollarsToCents(120_000);
    const run = (withSpend: boolean) => {
      const q = fresh();
      if (withSpend) {
        q.spendOnce({
          month: 24,
          label: "Car",
          amountCents: SPEND,
          fundingSourceIds: ["savings", `brokerage-${BLAKE}`],
        });
      }
      return q.run(usJurisdiction).series.months[24]!.accountBalancesCents;
    };
    const spent = run(true);
    const baseline = run(false);
    const drawn = (id: string) => (baseline[id] ?? 0) - (spent[id] ?? 0);
    // The whole spend comes from the two named accounts, in the named order: Alex's cash
    // cannot cover $120,000 alone, so it empties and Blake's brokerage covers the remainder.
    // A couple of hundred dollars over, because the drained money also stops earning its
    // return that month — a difference between the two runs, not a third funding source.
    expect(drawn("savings") + drawn(`brokerage-${BLAKE}`) - SPEND).toBeLessThan(dollarsToCents(500));
    expect(drawn("savings") + drawn(`brokerage-${BLAKE}`)).toBeGreaterThanOrEqual(SPEND);
    expect(drawn("savings")).toBeGreaterThan(0);
    expect(drawn(`brokerage-${BLAKE}`)).toBeGreaterThan(0);
    expect(drawn("savings")).toBeGreaterThan(drawn(`brokerage-${BLAKE}`));
    // And nothing else funds it — not Alex's own brokerage, not either retirement account.
    // Tens of dollars apart, not tens of thousands: the same knock-on as above, since a
    // household holding $120,000 less runs its month slightly differently.
    for (const untouched of ["brokerage", "retirement", `savings-${BLAKE}`, `retirement-${BLAKE}`]) {
      expect(Math.abs(drawn(untouched))).toBeLessThan(dollarsToCents(100));
    }
  });
});

describe("the long view — benefits, careers, and how far the run has to reach", () => {
  it("pays each person's Social Security on their own age, and an ex-partner's never", () => {
    const firstBenefit = (personId: string) =>
      RUN.series.months.findIndex((m) =>
        (m.flows?.incomeSources ?? []).some((s) => s.sourceId === `benefit:${personId}` && s.cashInflowCents > 0),
      );
    // Both claim at 67; Casey is three years younger, so Casey's starts three years later. The
    // gap IS the person-relativity — a claiming age read off the primary would start them together.
    const alexStart = firstBenefit(ALEX);
    const caseyStart = firstBenefit(CASEY);
    expect(alexStart).toBeGreaterThan(0);
    expect(caseyStart - alexStart).toBe(36);
    expect(firstBenefit(BLAKE)).toBe(-1);
  });

  it("dates each person's job against their own life while the chart axis stays the household's", () => {
    const job = (p: { birthYear: number; jobs: readonly { startYear: number; endYear: number }[] }) => p.jobs[0]!;
    // Ages 18→65, 18→67, 18→62, each in its owner's calendar. The three stop-work ages land in
    // the SAME calendar year here, which is the point rather than a coincidence to work around:
    // one shared month on the household's timeline, three different ages reaching it.
    expect(job(PEOPLE.alex).endYear - PEOPLE.alex.birthYear).toBe(65);
    expect(job(PEOPLE.blake).endYear - PEOPLE.blake.birthYear).toBe(67);
    expect(job(PEOPLE.casey).endYear - PEOPLE.casey.birthYear).toBe(62);
    for (const p of [PEOPLE.alex, PEOPLE.blake, PEOPLE.casey]) {
      expect(job(p).startYear - p.birthYear).toBe(18);
    }
  });

  it("will not lean on an ex-partner's career to fund Alex's retirement", () => {
    const planned = (p: Projection) => p.retirement(usJurisdiction).solution.plannedWorkStopAge;
    expect(planned(fresh())).toBe(65);
    // Blake works to 80 instead of 67 — and it changes nothing, because Blake is gone from month
    // 60 and their wages stop there whatever the job says.
    const q = fresh();
    const blakeJob = PEOPLE.blake.jobs[0]!;
    q.replacePartnerJob(blakeJob.id, {
      startYear: blakeJob.startYear,
      endYear: PEOPLE.blake.birthYear + 80,
      salary: blakeJob.salary,
    });
    expect(planned(q)).toBe(65);
  });

  it("does count Casey's career and Casey's life once Casey is here", () => {
    const q = fresh();
    const caseyJob = PEOPLE.casey.jobs[0]!;
    q.replacePartnerJob(caseyJob.id, {
      startYear: caseyJob.startYear,
      endYear: PEOPLE.casey.birthYear + 70,
      salary: caseyJob.salary,
    });
    // Casey working to 70 pushes the household's planned stop out to the year Casey reaches it,
    // stated — like every household-wide age — in the primary's own years.
    expect(q.retirement(usJurisdiction).solution.plannedWorkStopAge).toBe(73);
  });

  it("runs to Casey's 95 and not to Blake's expectancy, whatever Blake's is", () => {
    const anchor = fresh().retirement(usJurisdiction).solution.horizonAnchor;
    expect(anchor).toEqual({ age: 95, memberName: "Casey" });
    // 63 years: Casey is 32 at the start and the run has to reach their death, not Alex's 90.
    expect(RUN.series.months.length).toBe((95 - 32) * 12);

    // Blake outliving everyone changes nothing, because Blake left while both were alive and so
    // has no claim on how far the money has to last.
    const q = fresh();
    const blakeEvent = q.toState().scenario.ledger.events.find((e) => "person" in e && e.person?.name === "Blake")!;
    q.reviseTransaction(blakeEvent.id, { type: "marry", lifeExpectancy: 105 });
    expect(q.run(usJurisdiction).series.months.length).toBe(RUN.series.months.length);
    expect(q.retirement(usJurisdiction).solution.horizonAnchor).toEqual({ age: 95, memberName: "Casey" });
  });
});

describe("what the charts show", () => {
  it("steps household net worth down by exactly Blake, and up by exactly Casey", () => {
    const nw = (m: number) => RUN.series.months[m]!.netWorthNominalCents!;
    const byPerson = (m: number, id: string) => RUN.series.months[m]!.netWorthByPersonCents![id]!;
    // The comparison excludes the ordinary month by naming it: whatever Alex earned, spent, paid
    // and grew in the boundary month is Alex's own step, and the REST of the move is the
    // ownership transition — Blake's whole holding out, Casey's whole holding in.
    const alexStep = (m: number) => byPerson(m, ALEX) - byPerson(m - 1, ALEX);

    expect(nw(SEPARATION - 1) - nw(SEPARATION)).toBe(byPerson(SEPARATION - 1, BLAKE) - alexStep(SEPARATION));
    expect(nw(JOIN) - nw(JOIN - 1)).toBe(byPerson(JOIN, CASEY) + alexStep(JOIN));

    // And Alex's own step in the boundary month really is an ordinary one — the same size as the
    // month after, once the new arrangement has settled — so the household's step is the
    // ownership transition and not a month of unusual cash flow dressed up as one.
    for (const boundary of [SEPARATION, JOIN]) {
      expect(Math.abs(alexStep(boundary) - alexStep(boundary + 1))).toBeLessThan(dollarsToCents(100));
    }
  });

  it("stops Blake's person-level bands at the separation and starts Casey's at the joining", () => {
    const data = buildCashFlowChartData(RUN.series);
    const spendAt = (month: number, ownerId: string) =>
      cashFlowBandsForView(data, "outflows", "advanced", NAMES, ownerId).rows.find((r) => r.month === month)!
        .centsByBand[SHARED_SPENDING_BAND_ID];

    expect(spendAt(SEPARATION - 1, BLAKE)).toBeGreaterThan(0);
    expect(spendAt(SEPARATION, BLAKE)).toBeUndefined();
    expect(spendAt(ALONE, CASEY)).toBeUndefined();
    expect(spendAt(JOIN, CASEY)).toBeGreaterThan(0);
    // Alex's own band is unbroken across both boundaries — Alex is the one continuity here.
    for (const m of [0, SEPARATION - 1, SEPARATION, ALONE, JOIN, JOIN + 12]) {
      expect(spendAt(m, ALEX)).toBeGreaterThan(0);
    }
  });

  it("offers all three people in the cash-flow, tax and net-worth filters", () => {
    // Casey becoming selectable must not cost Blake their history: the five years Blake was here
    // are still on the chart, and still reachable.
    expect(buildTaxChartData(RUN.series, NAMES).owners).toEqual(expect.arrayContaining([ALEX, BLAKE, CASEY]));
    expect(buildCashFlowChartData(RUN.series).netOwners).toEqual(expect.arrayContaining([ALEX, BLAKE, CASEY]));

    const accounts = [...fresh().accountDescriptors(), ...eventAccountDescriptors(RUN.household.eventAccounts)];
    const breakdown = buildNetWorthBreakdown(RUN.series, { accounts });
    expect(breakdown.owners).toEqual(expect.arrayContaining([ALEX, BLAKE, CASEY]));
  });

  it("labels each partner's accounts with their own name, and charts them over their own span", () => {
    const descriptors = eventAccountDescriptors(RUN.household.eventAccounts);
    const labelled = Object.fromEntries(descriptors.map((d) => [d.id, [d.ownerId, d.label]]));
    expect(labelled[`savings-${BLAKE}`]).toEqual([BLAKE, "Blake — Cash savings"]);
    expect(labelled[`savings-${CASEY}`]).toEqual([CASEY, "Casey — Cash savings"]);
    expect(descriptors.filter((d) => d.ownerId === BLAKE)).toHaveLength(3);
    expect(descriptors.filter((d) => d.ownerId === CASEY)).toHaveLength(3);

    // Blake's account keeps the history it earned; Casey's is flat until Casey arrives with it.
    const positiveMonths = (accountId: string) =>
      RUN.series.months.filter((m) => (m.accountBalancesCents[accountId] ?? 0) > 0).map((m) => m.month);
    const blakeMonths = positiveMonths(`savings-${BLAKE}`);
    expect(blakeMonths[0]).toBe(0);
    expect(blakeMonths[blakeMonths.length - 1]).toBe(SEPARATION - 1);
    expect(positiveMonths(`savings-${CASEY}`)[0]).toBe(JOIN);
    // Both are real chart series, not empty ones the panel would silently skip.
    for (const id of [`savings-${BLAKE}`, `savings-${CASEY}`]) {
      expect(buildAccountBalanceData(RUN.series, id).points.length).toBeGreaterThan(0);
    }
  });

  it("puts all three relationship events on the timeline, in order and by name", () => {
    const markers = timelineMarkers(fresh().toState().scenario.ledger, RUN.series, NAMES);
    expect(markers.map((m) => [m.month, m.label, m.detail])).toEqual([
      [-96, "Partnered", "Blake joins the household"],
      [SEPARATION, "Separated", "Blake leaves the household"],
      [JOIN, "Partnered", "Casey joins the household"],
    ]);
    // Chronological, and each one dated in the year a reader would name it by.
    expect(markers.map((m) => m.month)).toEqual([...markers.map((m) => m.month)].sort((a, b) => a - b));
    expect(START_YEAR + SEPARATION / 12).toBe(START_YEAR + 5);
    expect(START_YEAR + JOIN / 12).toBe(START_YEAR + 7);
  });
});

describe("editing the relationships, and reloading the scenario", () => {
  const ledgerOf = (p: Projection) => p.toState().scenario.ledger;
  const eventIds = () => {
    const events = ledgerOf(fresh()).events;
    return {
      blake: events.find((e) => "person" in e && e.person?.name === "Blake")!.id,
      casey: events.find((e) => "person" in e && e.person?.name === "Casey")!.id,
      separation: events.find((e) => e.type === "SeparationEvent")!.id,
    };
  };

  it("refuses to move Casey's partnering back before Blake has left", () => {
    expect(() => fresh().reviseTransaction(eventIds().casey, { type: "marry", month: SEPARATION - 12 })).toThrow(
      /already partnered with Blake/,
    );
    // The month the last partnership ends is legal; the month before it is not.
    expect(() => fresh().reviseTransaction(eventIds().casey, { type: "marry", month: SEPARATION })).not.toThrow();
    expect(() => fresh().reviseTransaction(eventIds().casey, { type: "marry", month: SEPARATION - 1 })).toThrow(
      /already partnered with Blake/,
    );
  });

  it("refuses any edit to the separation that would leave Blake and Casey overlapping", () => {
    // Removing it and moving it past Casey are the same mistake by two routes, and both are
    // blamed on the partnering they strand rather than on the edit alone.
    expect(() => fresh().removeTransaction(eventIds().separation)).toThrow(/already partnered with Blake/);
    expect(() => fresh().reviseTransaction(eventIds().separation, { type: "separate", month: JOIN + 6 })).toThrow(
      /already partnered with Blake/,
    );
    expect(() => fresh().reviseTransaction(eventIds().separation, { type: "separate", month: JOIN })).not.toThrow();
  });

  it("supports a same-month handoff, with Blake out before Casey is in", () => {
    const input: ScenarioInput = {
      ...presetById(PRESET_ID).input,
      events: (presetById(PRESET_ID).input.events ?? []).map((e) =>
        e.type === "marry" ? { ...e, month: SEPARATION } : e,
      ),
    };
    const built = Projection.fromInput(input, usJurisdiction);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const res = built.projection.run(usJurisdiction);
    const people = roster(res.household);

    // The windows meet without overlapping, and no month has two partners in it.
    expect(res.household.memberships.find((m) => m.person.id === people.blake.id)!.endMonth).toBe(SEPARATION);
    expect(res.household.memberships.find((m) => m.person.id === people.casey.id)!.startMonth).toBe(SEPARATION);
    for (let m = 0; m < 120; m++) expect(res.membersAt(m)).toHaveLength(2);
    expect(res.membersAt(SEPARATION - 1).map((p) => p.name)).toEqual(["Alex", "Blake"]);
    expect(res.membersAt(SEPARATION).map((p) => p.name)).toEqual(["Alex", "Casey"]);

    // And the spending changes hands in that one month rather than being charged to both or to
    // neither: the gap version is what proves the boundary, this proves the boundary is tight.
    const shares = (m: number) => res.series.months[m]!.flows!.obligationChargedByPersonCents;
    expect(shares(SEPARATION - 1)[people.casey.id] ?? 0).toBe(0);
    expect(shares(SEPARATION)[people.blake.id] ?? 0).toBe(0);
    expect(shares(SEPARATION)[people.casey.id]).toBeGreaterThan(0);
  });

  it("reloads from a clean slate every time, leaking nothing from the preset before it", () => {
    // `presetState` rebuilds through the engine's own authoring on every call, so switching away
    // and back cannot carry a mutation, a stale id or a chart filter's owner with it.
    const first = presetState(presetById(PRESET_ID));
    const elsewhere = presetState(presetById("partner-uneven-split"));
    const second = presetState(presetById(PRESET_ID));
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(elsewhere.scenario.ledger.events).toHaveLength(1);

    // The authored input itself is never mutated by a build, so the preset the picker offers is
    // the same document after any number of loads.
    const authored = presetById(PRESET_ID).input;
    expect(authored.events).toHaveLength(3);
    expect(PRESETS.find((p) => p.id === PRESET_ID)!.input).toBe(authored);

    // Ownership and the editable timeline survive the round trip intact.
    const reloaded = Projection.fromState(second, usJurisdiction).run(usJurisdiction);
    const people = roster(reloaded.household);
    expect([people.alex.id, people.blake.id, people.casey.id]).toEqual([ALEX, BLAKE, CASEY]);
    expect(reloaded.household.accounts.map((a) => a.id)).toEqual(RUN.household.accounts.map((a) => a.id));
    expect(second.scenario.ledger.events.map((e) => e.type)).toEqual([
      "RelationshipEvent",
      "SeparationEvent",
      "RelationshipEvent",
    ]);
  });
});

/**
 * The dated "As of Year X" panel, which is the one surface in the app that is NOT omniscient.
 *
 * Everywhere else, seeing a partner before they arrive is the point: the timeline shows the plan,
 * the charts run the whole horizon, and Casey's job appears in the job projections years ahead of
 * the wedding. The snapshot answers a different question — who is in this household right now,
 * and what does it hold — so Casey's savings, retirement and brokerage sitting in the Year 1
 * balance list at $0 is not foresight, it is three accounts nobody has.
 */
describe("the dated household snapshot holds only the household of that month", () => {
  const ownerNamesOf = (month: number) => {
    const shown = new Set(RUN.snapshot(month).balances!.accounts.map((a) => a.id));
    const names = new Set<string>();
    for (const account of RUN.household.accounts) {
      if (!shown.has(account.id)) continue;
      for (const owner of account.owners) {
        names.add(RUN.household.memberships.find((m) => m.person.id === owner)!.person.name);
      }
    }
    return [...names].sort();
  };

  it("shows Alex and Blake at month 0, and nothing of Casey's", () => {
    expect(ownerNamesOf(0)).toEqual(["Alex", "Blake"]);
  });

  it("still shows Blake on their last month in the household", () => {
    expect(ownerNamesOf(SEPARATION - 1)).toEqual(["Alex", "Blake"]);
  });

  it("takes Blake's accounts with Blake the month they leave", () => {
    expect(ownerNamesOf(SEPARATION)).toEqual(["Alex"]);
  });

  it("leaves Alex alone through the whole gap, right up to the day before Casey", () => {
    expect(ownerNamesOf(ALONE)).toEqual(["Alex"]);
  });

  it("shows Casey's accounts from the month they join, at the balances they brought", () => {
    expect(ownerNamesOf(JOIN)).toEqual(["Alex", "Casey"]);
    const caseyAccounts = RUN.household.accounts.filter((a) => a.owners.includes(CASEY));
    const shown = new Map(RUN.snapshot(JOIN).balances!.accounts.map((a) => [a.id, a.balanceCents]));
    // Not placeholders: the money the preset gave Casey is there the month it arrives.
    expect(caseyAccounts.length).toBeGreaterThan(0);
    expect(caseyAccounts.some((a) => (shown.get(a.id) ?? 0) > 0)).toBe(true);
  });

  it("never lists a future partner's accounts, whatever they will one day hold", () => {
    // Both halves of the reported bug: the $0 rows, and the fact that a nonzero opening balance
    // would have been just as wrong — earlier, and louder.
    const caseyAccounts = new Set(
      RUN.household.accounts.filter((a) => a.owners.includes(CASEY)).map((a) => a.id),
    );
    for (const month of [0, 12, SEPARATION, ALONE]) {
      const shown = RUN.snapshot(month).balances!.accounts.map((a) => a.id);
      expect(shown.filter((id) => caseyAccounts.has(id))).toEqual([]);
    }
  });

  it("keeps the roster and the balance list telling the same story", () => {
    // They are two readings of one membership, so a month where the names and the accounts
    // disagree is the bug in either direction.
    for (const month of [0, SEPARATION - 1, SEPARATION, ALONE, JOIN]) {
      const names = RUN.snapshot(month).persons.map((p) => p.name).sort();
      expect(ownerNamesOf(month)).toEqual(names);
    }
  });

  it("leaves the whole-plan views omniscient, exactly as they were", () => {
    // The fix is scoped to the dated panel. The timeline still shows Casey's arrival from month
    // 0, and the account chart still draws every account across the whole horizon.
    const markers = timelineMarkers(fresh().toState().scenario.ledger, RUN.series, NAMES);
    expect(markers.some((m) => m.detail?.includes("Casey"))).toBe(true);
    for (const account of RUN.household.accounts) {
      expect(buildAccountBalanceData(RUN.series, account.id).points.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Whose April a settlement diagnostic explains. Three people file here, never more than two at
 * once, and the household's per-source attribution is their terms already added together — so the
 * only honest answer to "why does Alex owe this?" is Alex's own terms, which the engine keeps
 * separately for exactly that reason.
 */
describe("each filer's own settlement attribution", () => {
  const attributionAt = (month: number) => flowsAt(month).taxSettlementBySourcePersonCents;
  /** Every April the plan files, so a window claim below is about all of them, not a sample. */
  const FILING_MONTHS = RUN.series.months
    .filter((m) => Object.keys(m.flows?.taxSettlementByPersonCents ?? {}).length > 0)
    .map((m) => m.month);

  it("explains April of Year 44 with each member's own sources, not the household's", () => {
    // The reported month: a combined $13,632 that neither member settled.
    const month = 531;
    const row = buildTaxChartData(RUN.series, NAMES).rows.find((r) => r.month === month)!;
    expect(row.settlementCents).toBe(1363192);

    const alex = attributionAt(month)[ALEX]!;
    const casey = attributionAt(month)[CASEY]!;
    const total = (m: Readonly<Record<string, number>>) => Object.values(m).reduce((a, b) => a + b, 0);

    expect(total(alex)).toBe(1137272);
    expect(total(casey)).toBe(225920);
    // Their two lists are disjoint, so neither tooltip can name the other's income.
    expect(Object.keys(alex).filter((k) => k in casey)).toEqual([]);
    expect(total(alex) + total(casey)).toBe(row.settlementCents);
    // And each is exactly the band that person's own cut of the chart draws.
    expect(row.settlementByOwnerCents[`tax-settlement:${ALEX}`]).toBe(total(alex));
    expect(row.settlementByOwnerCents[`tax-settlement:${CASEY}`]).toBe(total(casey));
  });

  it("stops attributing anything to Blake once Blake has left", () => {
    const blakeMonths = FILING_MONTHS.filter((m) => ALEX in attributionAt(m) && BLAKE in attributionAt(m));
    // Blake really did file while they were here — otherwise the claim below is vacuous.
    expect(blakeMonths.length).toBeGreaterThan(0);
    expect(Math.max(...blakeMonths)).toBeLessThan(SEPARATION);
    expect(FILING_MONTHS.filter((m) => m >= SEPARATION && BLAKE in attributionAt(m))).toEqual([]);
  });

  it("attributes nothing to Casey before Casey arrives", () => {
    const caseyMonths = FILING_MONTHS.filter((m) => CASEY in attributionAt(m));
    expect(caseyMonths.length).toBeGreaterThan(0);
    expect(Math.min(...caseyMonths)).toBeGreaterThan(JOIN);
    expect(FILING_MONTHS.filter((m) => m < JOIN && CASEY in attributionAt(m))).toEqual([]);
  });

  it("leaves the household alone with Alex's own filing in the gap between partners", () => {
    const gap = FILING_MONTHS.filter((m) => m >= SEPARATION && m < JOIN);
    expect(gap.length).toBeGreaterThan(0);
    for (const month of gap) expect(Object.keys(attributionAt(month))).toEqual([ALEX]);
  });

  it("still explains the estate settlement filed after Alex dies", () => {
    // Death is not separation: the final April settles the year Alex lived through, and it is
    // still Alex's own — with Casey's, filed the same month, still separately Casey's.
    const month = 663;
    const alex = attributionAt(month)[ALEX]!;
    expect(Object.values(alex).reduce((a, b) => a + b, 0)).toBe(
      flowsAt(month).taxSettlementByPersonCents[ALEX],
    );
    expect(Object.keys(attributionAt(month)[CASEY]!).some((k) => k in alex)).toBe(false);
  });
});
