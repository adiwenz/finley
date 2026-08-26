import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type ProjectionSeries } from "./simulate";
import { OBLIGATION_PRIORITY, type FinancialObligation } from "./financialObligation";
import type { SimPerson } from "./simulate.types";
import {
  buildRmdSources,
  establishRmdRequirements,
  recordAccountDistributions,
  type RmdState,
} from "./rmd";

/** Non-compounding by default, so balances move only by withdrawal/deposit. */
function account(
  id: string,
  taxProfile: SimAccountTaxProfile,
  dollars: number,
  liquid = false,
  annualRate = 0,
): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: annualRate,
  });
}

/** Surplus idles in the liquid cash account, so a forced excess's net take-home lands there. */
function baseInput(
  person: SimPerson,
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
  return {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

/** Stub: 10% of the pre-tax balance once the holder reaches 73; no tax. */
const rmdStub: Jurisdiction = {
  id: "rmd-stub",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
  requiredMinimumDistributionCents: (balance, ctx) =>
    ctx.age >= 73 ? Math.round(balance / 10) : 0,
};

const born73In2026: SimPerson = { id: "p1", name: "You", birthYear: 1953 };

/** Level monthly spending for the whole run; returns the series so a caller can override one month. */
function spending(monthlyDollars: number): HouseholdSimInput["expenseSeries"][number] {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
  };
}

/** What the sim forced out as this year's Required Minimum Distribution, this month. */
function rmdAt(series: ProjectionSeries, month: number): number {
  return (series.months[month]!.flows?.incomeSources ?? [])
    .filter((source) => source.sourceId === "rmd:p1")
    .reduce((total, source) => total + source.cashInflowCents, 0);
}

const balanceAt = (series: ProjectionSeries, month: number, id: string): number =>
  series.months[month]!.accountBalancesCents[id] ?? 0;

describe("Required Minimum Distributions — an annual minimum, trued up in December", () => {
  it("not satisfied at all: no normal withdrawal happens, so December forces the whole requirement", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    // Nothing forced, and nothing else touches the account, before December.
    for (let month = 0; month <= 10; month++) {
      expect(rmdAt(series, month)).toBe(0);
      expect(balanceAt(series, month, "pretax")).toBe(dollarsToCents(100_000));
    }
    // December (month 11, age 73): the full 10% of $100k moves pre-tax → cash.
    expect(rmdAt(series, 11)).toBe(dollarsToCents(10_000));
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(90_000));
    expect(balanceAt(series, 11, "cash")).toBe(dollarsToCents(10_000));
    // Tax-free stub → net worth unchanged, only relocated.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(100_000));
  });

  it("fully satisfied by normal withdrawals: December forces nothing further", () => {
    // $1,000/mo spent, cash starts empty, so every month's spending is an ordinary pre-tax
    // draw — $11,000 qualifying YTD before December's own draw already clears the $10,000
    // requirement, and December's own $1,000 draw only adds to the cushion.
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ], { expenseSeries: [spending(1_000)] }),
      rmdStub,
    );
    expect(rmdAt(series, 11)).toBe(0);
    // The whole year's spending — $12,000 — came out of pre-tax, none of it forced.
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(88_000));
    expect(balanceAt(series, 11, "cash")).toBe(0);
  });

  it("partially satisfied: December forces exactly the shortfall, no more", () => {
    // $500/mo spent from an empty cash account draws $6,000 of ordinary pre-tax withdrawals
    // over the year (including December's own $500) — short of the $10,000 requirement by
    // exactly $4,000.
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ], { expenseSeries: [spending(500)] }),
      rmdStub,
    );
    expect(rmdAt(series, 11)).toBe(dollarsToCents(4_000));
    // $6,000 of ordinary draws plus the $4,000 forced remainder: $10,000 total, matching the
    // untouched-account case regardless of how it was split between the two.
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(90_000));
    // The forced $4,000 wasn't needed for December's own $500 of spending, so it banks in full.
    expect(balanceAt(series, 11, "cash")).toBe(dollarsToCents(4_000));
  });

  it("satisfied by a December normal withdrawal: a one-time December expense clears the year on its own", () => {
    const flat = spending(0);
    // A single $20,000 expense landing in December alone — no spending in any other month —
    // forces a pre-tax draw larger than the whole year's requirement, in the same month
    // December's true-up would otherwise fire.
    flat.series.addOverride(11, dollarsToCents(20_000), "thisMonthOnly");
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ], { expenseSeries: [flat] }),
      rmdStub,
    );
    // Nothing touches the account before December's one-time expense.
    for (let month = 0; month <= 10; month++) {
      expect(balanceAt(series, month, "pretax")).toBe(dollarsToCents(100_000));
    }
    expect(rmdAt(series, 11)).toBe(0);
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(80_000));
    expect(balanceAt(series, 11, "cash")).toBe(0);
  });

  it("fires exactly once per calendar year, in December, not every month", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ], { horizonMonths: 24 }),
      rmdStub,
    );
    // No draw between the first year's trigger (month 11) and the second's (month 23).
    for (let month = 12; month <= 22; month++) expect(rmdAt(series, month)).toBe(0);
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(90_000));
    expect(balanceAt(series, 22, "pretax")).toBe(dollarsToCents(90_000));
    // Month 23 (2027, age 74): 10% of the remaining $90k = $9k.
    expect(rmdAt(series, 23)).toBe(dollarsToCents(9_000));
    expect(balanceAt(series, 23, "pretax")).toBe(dollarsToCents(81_000));
  });

  it("draws from forced-distribution-eligible accounts only — tax-exempt/capital-gains are exempt", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 50_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(90_000));
    expect(balanceAt(series, 11, "taxexempt")).toBe(dollarsToCents(50_000));
    expect(balanceAt(series, 11, "cash")).toBe(dollarsToCents(10_000));
  });

  it("does not fire before the holder reaches the start age", () => {
    const tooYoung: SimPerson = { id: "p1", name: "You", birthYear: 1970 }; // 56 in 2026
    const series = simulateHousehold(
      baseInput(tooYoung, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(100_000));
    expect(balanceAt(series, 11, "cash")).toBe(0);
  });

  it("null jurisdiction: no RMD seam → pre-tax balances are left untouched", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      nullJurisdiction,
    );
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(100_000));
    expect(balanceAt(series, 11, "cash")).toBe(0);
  });
});

describe("Required Minimum Distributions — nothing is required of the dead", () => {
  /** A two-person household: Sam holds the pre-tax account and dies at `deathMonth`. */
  function household(deathMonth: number | undefined): HouseholdSimInput {
    return {
      horizonMonths: 36,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [
        { id: "p1", name: "Alex", birthYear: 1970 },
        {
          id: "p2",
          name: "Sam",
          birthYear: 1953,
          ...(deathMonth !== undefined
            ? { activeWindow: { startMonth: 0, endMonthExclusive: deathMonth } }
            : {}),
        },
      ],
      accounts: [
        new SimAccount({
          id: "sams-ira",
          ownerId: "p2",
          liquid: false,
          taxProfile: PRE_TAX_TAX_PROFILE,
          openingBalanceCents: dollarsToCents(100_000),
          initialAnnualRate: 0,
        }),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ],
      incomeSeries: [],
      expenseSeries: [],
    };
  }

  it("stops distributing a partner's account once they have died", () => {
    // Sam is active for all of 2026 (window closes at month 12) and takes that year's December
    // distribution; dead for all of 2027, so no requirement is even established for it.
    const series = simulateHousehold(household(12), rmdStub);
    expect(balanceAt(series, 11, "sams-ira")).toBe(dollarsToCents(90_000));
    expect(balanceAt(series, 12, "sams-ira")).toBe(dollarsToCents(90_000));
    expect(balanceAt(series, 35, "sams-ira")).toBe(dollarsToCents(90_000));
    // The account is not disinherited by the gate — it is still the household's, to the end.
    expect(series.months[35].netWorthNominalCents).toBe(dollarsToCents(100_000));
  });

  it("keeps distributing while they are alive, so the gate is the death and not the account", () => {
    // The same fixture with nobody dying: three years, three December distributions.
    const series = simulateHousehold(household(undefined), rmdStub);
    expect(balanceAt(series, 35, "sams-ira")).toBe(dollarsToCents(72_900));
  });

  it("trues up the year's distribution when death falls LATER in the same year", () => {
    // Sam dies in July 2027 (month 18), after 2027's January establishing month (12) but before
    // that year's December true-up (23) — the requirement was already theirs when it was set,
    // and it stands: `establishRmdRequirements` gates on eligibility, `buildRmdSources` does not.
    const series = simulateHousehold(household(18), rmdStub);
    expect(balanceAt(series, 23, "sams-ira")).toBe(dollarsToCents(81_000));
    expect(balanceAt(series, 35, "sams-ira")).toBe(dollarsToCents(81_000));
  });
});

/**
 * The three-function split directly, rather than through `simulateHousehold` — the same
 * `isPersonActiveAt` gate the death tests above exercise, but pointed at a `activeWindow`
 * boundary closed by separation rather than death. There is no separate separation-vs-death
 * branch to test; `activeWindow` is the one abstraction for both.
 */
describe("Required Minimum Distributions — establishRmdRequirements / buildRmdSources and activeWindow", () => {
  function rmdState(
    person: SimPerson,
    balanceCents: Cents,
    extraAccounts: SimAccount[] = [],
  ): { state: RmdState; ira: SimAccount } {
    const ira = new SimAccount({
      id: "ira",
      ownerId: person.id,
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: balanceCents,
      initialAnnualRate: 0,
    });
    const assetBalances = new Map<string, Cents>([["ira", balanceCents]]);
    for (const a of extraAccounts) assetBalances.set(a.id, a.openingBalanceCents);
    return {
      ira,
      state: {
        accounts: [ira, ...extraAccounts],
        assetBalances,
        personsById: new Map([[person.id, person]]),
        rmdRequiredByPersonYear: new Map(),
        rmdSatisfiedByPersonYear: new Map(),
      },
    };
  }

  const eligible: SimPerson = { id: "p1", name: "Sam", birthYear: 1953 }; // 73 in 2026

  it("an active partner gets a requirement established in January and forced in December", () => {
    const active: SimPerson = { ...eligible, activeWindow: { startMonth: 0, endMonthExclusive: 6 } };
    const { state: s } = rmdState(active, dollarsToCents(100_000));
    // Month 0 falls inside the window, which stays open through month 5.
    establishRmdRequirements(s, rmdStub, 0, 2026);
    const sources = buildRmdSources(s, rmdStub, 11, 2026);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceId).toBe("rmd:p1");
    expect(sources[0]!.waterfallInflowCents).toBe(dollarsToCents(10_000));
    expect(s.assetBalances.get("ira")).toBe(dollarsToCents(90_000));
  });

  it("no requirement is established once the activeWindow has already closed, so December forces nothing", () => {
    const separated: SimPerson = { ...eligible, activeWindow: { startMonth: 0, endMonthExclusive: 6 } };
    const { state: s } = rmdState(separated, dollarsToCents(100_000));
    // Month 12 — the next annual establishing month — falls after the window closed at month 6.
    establishRmdRequirements(s, rmdStub, 12, 2026);
    const sources = buildRmdSources(s, rmdStub, 23, 2026);
    expect(sources).toHaveLength(0);
    expect(s.assetBalances.get("ira")).toBe(dollarsToCents(100_000));
  });

  it("a person with no activeWindow keeps getting a requirement established every year", () => {
    const { state: s } = rmdState(eligible, dollarsToCents(100_000));
    establishRmdRequirements(s, rmdStub, 12, 2026);
    const sources = buildRmdSources(s, rmdStub, 23, 2026);
    expect(sources).toHaveLength(1);
    expect(s.assetBalances.get("ira")).toBe(dollarsToCents(90_000));
  });

  it("recordAccountDistributions reduces what December still owes", () => {
    const { state: s } = rmdState(eligible, dollarsToCents(100_000));
    establishRmdRequirements(s, rmdStub, 0, 2026);
    recordAccountDistributions(
      s,
      [{ accountId: "ira", grossWithdrawnCents: dollarsToCents(4_000) }],
      5,
      2026,
    );
    const sources = buildRmdSources(s, rmdStub, 11, 2026);
    expect(sources[0]!.waterfallInflowCents).toBe(dollarsToCents(6_000));
    // The synthetic $4,000 draw above only updates the YTD tracker in this unit test — it
    // never touched `assetBalances` itself (a real decumulation draw would have) — so only
    // December's own $6,000 forced draw reduces the balance here.
    expect(s.assetBalances.get("ira")).toBe(dollarsToCents(100_000) - dollarsToCents(6_000));
  });

  it("recordAccountDistributions ignores a draw from an account that is not forced-distribution-eligible", () => {
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: eligible.id,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(50_000),
      initialAnnualRate: 0,
    });
    const { state: s } = rmdState(eligible, dollarsToCents(100_000), [brokerage]);
    establishRmdRequirements(s, rmdStub, 0, 2026);
    recordAccountDistributions(
      s,
      [{ accountId: "brokerage", grossWithdrawnCents: dollarsToCents(4_000) }],
      5,
      2026,
    );
    const sources = buildRmdSources(s, rmdStub, 11, 2026);
    // The whole $10,000 requirement is still forced — the brokerage draw doesn't qualify.
    expect(sources[0]!.waterfallInflowCents).toBe(dollarsToCents(10_000));
  });
});

/**
 * **The balance the requirement is priced off.** The IRS mechanic divides the PRIOR year-end
 * balance by the year's divisor, and the engine establishes each year's requirement off the
 * balance it holds at that year's first month — ahead of both decumulation and `compoundAssets`,
 * so January's opening balance IS the prior December's close. Pin it: move the establishing step
 * after either, and these divisions stop reconciling. The forced draw itself still lands in
 * December (see the annual-minimum suite above); this suite is only about what number it trues
 * up against.
 */
describe("Required Minimum Distributions — priced off the prior year-end balance", () => {
  const DIVISOR: Record<number, number> = { 73: 26.5, 74: 25.5, 75: 24.6 };

  /** The real mechanic — balance ÷ Uniform Lifetime divisor — without importing the rules package. */
  const divisorStub: Jurisdiction = {
    id: "divisor-stub",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    requiredMinimumDistributionCents: (balance, ctx) => {
      const divisor = DIVISOR[ctx.age];
      return divisor === undefined ? 0 : Math.round(balance / divisor);
    },
  };

  /** Compounding, so a year-end balance is neither the opening balance nor a round number. */
  const growingHousehold = (): ProjectionSeries =>
    simulateHousehold(
      baseInput(
        born73In2026,
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 100_000, false, 0.12),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { horizonMonths: 36 },
      ),
      divisorStub,
    );

  it("divides the prior year-end balance by the year's divisor, to the cent", () => {
    const series = growingHousehold();
    // The first year has no prior December, so it is priced off the opening balance.
    expect(rmdAt(series, 11)).toBe(Math.round(dollarsToCents(100_000) / DIVISOR[73]!));
    // Every year after divides the balance the previous December closed at.
    for (const [month, age] of [[23, 74], [35, 75]] as const) {
      expect(rmdAt(series, month)).toBe(
        Math.round(balanceAt(series, month - 12, "pretax") / DIVISOR[age]!),
      );
    }
  });

  it("prices off the prior year's CLOSING balance, not an earlier balance from that year", () => {
    // The distinction only exists because the account compounds: had the second year's
    // requirement been priced off November's balance instead of December's, or off a balance
    // from a year further back, it would divide a different number.
    const series = growingHousehold();
    const novemberOfYear0 = balanceAt(series, 10, "pretax");
    const decemberCloseOfYear0 = balanceAt(series, 11, "pretax");
    expect(novemberOfYear0).not.toBe(decemberCloseOfYear0);
    expect(rmdAt(series, 23)).toBe(Math.round(decemberCloseOfYear0 / DIVISOR[74]!));
    expect(rmdAt(series, 23)).not.toBe(Math.round(novemberOfYear0 / DIVISOR[74]!));
  });

  /**
   * **The round-number anchor.** A holder who turns 73 the following year, holding $530,000
   * that does nothing at all in the meantime — no growth, no income, no spending, no tax. The
   * balance the second year opens with is $530,000 by construction, so the answer is
   * $530,000 / 26.5 = $20,000 exactly, and any deviation is something the model did to the
   * balance rather than a question of arithmetic.
   *
   * Deliberately the whole pipeline rather than the seam alone: the seam dividing correctly is
   * already pinned in `@finley/rules`, and every way this has been suspected of going wrong —
   * pricing off a later balance, a stray withdrawal landing before the establishing month, the
   * year's own growth reaching the base — lives between the two.
   */
  it("$530,000 turning 73 the following year, nothing else happening, is $20,000 in December, to the cent", () => {
    const series = simulateHousehold(
      baseInput(
        { id: "p1", name: "You", birthYear: 1954 }, // 72 in 2026, 73 in 2027
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 530_000),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { horizonMonths: 24 },
      ),
      divisorStub,
    );
    // Age 72 throughout 2026: nothing is required, and nothing else touches the account either.
    for (let month = 0; month <= 11; month++) {
      expect(rmdAt(series, month)).toBe(0);
      expect(balanceAt(series, month, "pretax")).toBe(dollarsToCents(530_000));
    }
    // 2027 opens on exactly the $530,000 that closed 2026, and nothing forces before its own
    // December.
    for (let month = 12; month <= 22; month++) expect(rmdAt(series, month)).toBe(0);
    expect(DIVISOR[73]).toBe(26.5);
    expect(rmdAt(series, 23)).toBe(dollarsToCents(20_000));
    expect(balanceAt(series, 23, "pretax")).toBe(dollarsToCents(510_000));
  });

  it("takes the distribution before the year's growth, so the withdrawn money never earns it", () => {
    // The balance identity that makes the crossover arithmetic true: December is
    // `(November's close − RMD) × (1 + rate)`, not `November's close × (1 + rate) − RMD`.
    const series = growingHousehold();
    const novemberClose = balanceAt(series, 10, "pretax");
    const monthlyRate = Math.pow(1.12, 1 / 12) - 1;
    expect(balanceAt(series, 11, "pretax")).toBe(
      Math.round((novemberClose - rmdAt(series, 11)) * (1 + monthlyRate)),
    );
  });
});

/**
 * **A distribution is a distribution.** The requirement is satisfied by money actually leaving
 * an eligible retirement account, so which internal mechanism pulled it — the month-to-month
 * decumulation cascade, or an explicitly-funded one-time spend naming the account — cannot
 * change what December still owes. Tracking satisfaction by mechanism instead of by account
 * made a $20,000 January withdrawal invisible to the year, and December forced a second one on
 * top of a requirement that had already been exceeded twice over.
 */
describe("Required Minimum Distributions — satisfied by the account drawn, not the path taken", () => {
  /** $265,000 ÷ the age-73 divisor of 26.5 = exactly $10,000, so every figure below is round. */
  const AGE_73_DIVISOR = 26.5;
  const divisorStub: Jurisdiction = {
    id: "divisor-stub",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    requiredMinimumDistributionCents: (balance, ctx) =>
      ctx.age >= 73 ? Math.round(balance / AGE_73_DIVISOR) : 0,
  };

  /** A $20,000 one-time spend in January, drawing `sourceId` and nothing else all year. */
  function januarySpend(sourceId: string): FinancialObligation {
    return {
      id: "draw:new-roof",
      sourceId: "new-roof",
      month: 0,
      amountCents: dollarsToCents(20_000),
      treatment: "expense",
      funding: { kind: "explicit", orderedAccountIds: [sourceId] },
      priority: OBLIGATION_PRIORITY.untracked,
      sourceKind: "untracked",
      editable: false,
      label: "New roof",
      category: "other",
    };
  }

  /** What the January draw actually took out of `accountId`, gross, per the attribution record. */
  function januaryGrossFrom(series: ProjectionSeries, accountId: string): number {
    return (series.months[0]!.flows?.resolvedFunding ?? [])
      .flatMap((r) => r.sources)
      .filter((s) => s.kind === "account" && s.sourceId === accountId)
      .reduce((total, s) => total + (s.withdrawal?.grossWithdrawnCents ?? 0), 0);
  }

  it("a one-time expense funded from the pre-tax account satisfies the year, so December forces nothing", () => {
    const series = simulateHousehold(
      baseInput(
        born73In2026,
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 265_000),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { fundingDraws: [januarySpend("pretax")] },
      ),
      divisorStub,
    );

    // January: the spend sells $20,000 of the retirement account — a real distribution, twice
    // the $10,000 the year requires.
    expect(januaryGrossFrom(series, "pretax")).toBe(dollarsToCents(20_000));
    expect(balanceAt(series, 0, "pretax")).toBe(dollarsToCents(245_000));
    // December: `max(0, $10,000 − $20,000)` is nothing, so no forced source is emitted at all.
    expect(rmdAt(series, 11)).toBe(0);
    expect(
      (series.months[11]!.flows?.incomeSources ?? []).some((s) => s.sourceId === "rmd:p1"),
    ).toBe(false);
    // $20,000 for the year, not $30,000: the account closes where January left it, with no
    // growth and nothing else drawing on it.
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(245_000));
    // Nothing was forced, so nothing banked in cash either — the whole $20,000 was spent.
    expect(balanceAt(series, 11, "cash")).toBe(0);
  });

  it("the same expense funded from a brokerage does not satisfy the year, so December forces all of it", () => {
    const series = simulateHousehold(
      baseInput(
        born73In2026,
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 265_000),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 20_000),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { fundingDraws: [januarySpend("brokerage")] },
      ),
      divisorStub,
    );

    // The identical spend, drawn from the one account no requirement attaches to.
    expect(januaryGrossFrom(series, "brokerage")).toBe(dollarsToCents(20_000));
    expect(balanceAt(series, 0, "brokerage")).toBe(0);
    expect(balanceAt(series, 0, "pretax")).toBe(dollarsToCents(265_000));
    // The retirement account was never touched, so the full requirement is still outstanding.
    expect(rmdAt(series, 11)).toBe(dollarsToCents(10_000));
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(255_000));
    // Unneeded by December's own spending, the forced distribution banks.
    expect(balanceAt(series, 11, "cash")).toBe(dollarsToCents(10_000));
  });

  it("records a distribution against its owner's year whatever mechanism reports it", () => {
    const ira = account("ira", PRE_TAX_TAX_PROFILE, 265_000);
    const s: RmdState = {
      accounts: [ira],
      assetBalances: new Map([["ira", ira.openingBalanceCents]]),
      personsById: new Map([[born73In2026.id, born73In2026]]),
      rmdRequiredByPersonYear: new Map(),
      rmdSatisfiedByPersonYear: new Map(),
    };
    establishRmdRequirements(s, divisorStub, 0, 2026);
    // The seam takes the account and the gross, and nothing else: a funding draw's withdrawal
    // and a decumulation draw's are the same fact told twice.
    recordAccountDistributions(
      s,
      [{ accountId: "ira", grossWithdrawnCents: dollarsToCents(20_000) }],
      0,
      2026,
    );
    expect(s.rmdSatisfiedByPersonYear.get("p1|2026")).toBe(dollarsToCents(20_000));
    expect(buildRmdSources(s, divisorStub, 11, 2026)).toHaveLength(0);
    // The $10,000 over-distribution stays in 2026: next year prices its own requirement off the
    // balance and starts satisfaction from zero.
    expect(s.rmdSatisfiedByPersonYear.get("p1|2027")).toBeUndefined();
  });
});
