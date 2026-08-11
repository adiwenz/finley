/**
 * Per-line funding attribution on the flow record, end to end. The seam is the simulator's public
 * output: each month's `flows.resolvedFunding` names, per obligation, the sources that paid it in
 * the order the cascade consumed them — income cash, liquid drawdown, decumulation, then credit.
 *
 * The reconciliation these tests pin: every obligation is fully funded until credit is genuinely
 * exhausted, each record's `funded + shortfall` equals what was requested, its sources sum to the
 * funded amount, and they never appear out of cascade order. The scenarios are hand-sized so the
 * expected split follows from the priority rule, not from re-running the engine's own arithmetic.
 */

import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { HouseholdSimInput, SimOwnedSeries, SimPerson } from "./simulate.types";
import type { FundingSourceKind, ResolvedFunding } from "./resolvedFunding";
import { explicitObligation } from "./financialObligation";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../plan/simAccount";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { RevolvingCard } from "../liability/liability";
import { monthlyIncome, monthlyExpense } from "./simulate.testSupport";

const PERSON: SimPerson = { id: "p1", name: "Alice" };

/** A liquid cash buffer — the shortfall sink and the source of any liquid drawdown. */
function cashAccount(openingCents: number): SimAccount {
  return new SimAccount({
    id: "cash",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** A non-liquid investment the decumulation channel can liquidate; basis == balance ⇒ no gain. */
function investmentAccount(openingCents: number): SimAccount {
  return new SimAccount({
    id: "brokerage",
    ownerId: "p1",
    liquid: false,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** A named account an explicit obligation drains by id; basis == balance ⇒ no gain, no tax. */
function namedAccount(id: string, openingCents: number): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: false,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** An explicitly-funded down-payment draw: identity `draw:<id>`, reporting namespace `downpayment`. */
function downPayment(amountCents: number, orderedAccountIds: string[], id = "downpayment:home-1") {
  return explicitObligation({
    id,
    sourceId: "downpayment",
    month: 0,
    amountCents,
    orderedAccountIds,
    treatment: "asset-acquisition",
  });
}

/** An automatically-funded expense line carrying an explicit priority (lower funded first). */
function expenseLine(id: string, dollars: number, priority: number): SimOwnedSeries {
  return {
    series: monthlyExpense(dollarsToCents(dollars)),
    ownerId: "p1",
    label: id,
    obligationSource: { kind: "budgetLine", id, category: "needs", editable: true, priority },
  };
}

function run(
  input: Omit<HouseholdSimInput, "horizonMonths" | "annualInflationRate" | "persons">,
  jurisdiction: Jurisdiction = nullJurisdiction,
) {
  return simulateHousehold(
    { horizonMonths: 1, annualInflationRate: 0, persons: [PERSON], ...input },
    jurisdiction,
  );
}

/** A non-liquid pre-tax account (basis 0 ⇒ its whole draw is taxable gain). */
function preTaxAccount(id: string, openingCents: number): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: false,
    taxProfile: PRE_TAX_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** 25% flat on ordinary income — a pre-tax liquidation is grossed up against it. */
const flatOrdinaryTax: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
  computeTaxByCategoryCents: (byCat) => {
    const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.25);
    return t > 0 ? { ordinaryIncome: t } : {};
  },
};

/**
 * 25% on realized capital gain, with pro-rata basis recovery: only the gain fraction of a
 * liquidation is taxable, so an appreciated draw books partial principal AND partial gain.
 * The `taxableWithdrawalCents` seam is what separates this from `flatOrdinaryTax` (basis 0,
 * whole draw taxable) — it is the return-of-capital policy an appreciated account needs.
 */
const flatCapitalGainsTax: Jurisdiction = {
  id: "capgains-25",
  computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * 0.25),
  computeTaxByCategoryCents: (byCat) => {
    const t = Math.round((byCat.capitalGains ?? 0) * 0.25);
    return t > 0 ? { capitalGains: t } : {};
  },
  taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
    balanceCents <= 0 ? grossCents : Math.round((grossCents * (balanceCents - basisCents)) / balanceCents),
};

/**
 * A non-liquid capital-gains account with a growth rate. Its basis opens at the balance, so
 * the only way an unrealized gain appears is compounding across months — the sim never lets a
 * post-tax account open already appreciated. Run it forward and draw in a LATER month to
 * liquidate genuine appreciation.
 */
function appreciatingAccount(id: string, openingCents: number, annualRate: number): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: false,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: annualRate,
  });
}

/** The month-0 attribution list, guaranteed present on a processed month. */
function attributionAt(
  input: Parameters<typeof run>[0],
  jurisdiction: Jurisdiction = nullJurisdiction,
) {
  const funding = run(input, jurisdiction).months[0].flows?.resolvedFunding;
  if (funding === undefined) throw new Error("expected resolvedFunding on the flow record");
  return funding;
}

const byObligation = (funding: readonly ResolvedFunding[], id: string): ResolvedFunding => {
  const record = funding.find((f) => f.obligationId === id);
  if (record === undefined) throw new Error(`no funding record for ${id}`);
  return record;
};

const kinds = (record: ResolvedFunding): FundingSourceKind[] =>
  record.sources.map((s) => s.kind);

describe("resolvedFunding — per-line attribution on the flow record", () => {
  it("a month funded entirely from income attributes every obligation to income", () => {
    const funding = attributionAt({
      accounts: [cashAccount(0)],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(8000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0), expenseLine("fun", 500, 100)],
    });

    for (const id of ["line:rent", "line:fun"]) {
      const record = byObligation(funding, id);
      expect(record.shortfallCents).toBe(0);
      expect(record.fundedCents).toBe(record.requestedCents);
      expect(record.sources).toEqual([
        { kind: "income", sourceId: "income", amountCents: record.requestedCents },
      ]);
    }
  });

  it("a tight month attributes the lowest-priority obligation to drawdown and then credit", () => {
    // $1000 income, $500 liquid buffer, $2000 of obligations. The $800 need funds from income;
    // the $1200 want takes the remaining $200 income, the $500 buffer, then $500 on credit.
    const funding = attributionAt({
      accounts: [cashAccount(dollarsToCents(500))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("need", 800, 0), expenseLine("want", 1200, 100)],
    });

    expect(byObligation(funding, "line:need").sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(800) },
    ]);
    const want = byObligation(funding, "line:want");
    expect(want.shortfallCents).toBe(0);
    expect(want.sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(200) },
      { kind: "account", sourceId: "cash", amountCents: dollarsToCents(500) },
      { kind: "credit", sourceId: "credit", amountCents: dollarsToCents(500) },
    ]);
  });

  it("attributes a payroll-tax-sized shortfall the pre-allocation estimate missed to savings, not credit", () => {
    // The withdrawal-sizing pass's gap check (`estimateNetIncome` in withdrawal.ts) only calls
    // `computeTaxCents` — never `computePayrollTaxCents` — so a jurisdiction charging payroll tax
    // makes that estimate systematically overstate net income by the payroll-tax amount. Here
    // wages of $1000 exactly cover the $1000 need BEFORE payroll tax, so the sizing pass sees no
    // gap and never offers the ample cash buffer as a source; only the REAL allocation (which does
    // charge the 10% payroll tax) finds the $100 shortfall. It must still land on the buffer that
    // was sitting right there — never on a credit layer that was never actually touched.
    // `monthlyIncome`/`incomeSeries` tags no explicit `taxCategory`, so `buildIncomeSources`
    // falls back to `ordinaryIncome` — key the payroll seam off that, not `wages`.
    const payrollOnlyTax: Jurisdiction = {
      id: "payroll-only-10",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      computePayrollTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.1),
      computePayrollTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.1);
        return t > 0 ? { ordinaryIncome: t } : {};
      },
    };
    const funding = attributionAt(
      {
        accounts: [cashAccount(dollarsToCents(50000))],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
        expenseSeries: [expenseLine("need", 1000, 0)],
      },
      payrollOnlyTax,
    );

    const record = byObligation(funding, "line:need");
    expect(record.shortfallCents).toBe(0);
    expect(record.fundedCents).toBe(record.requestedCents);
    expect(kinds(record)).not.toContain("credit");
    expect(record.sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(900) },
      { kind: "account", sourceId: "cash", amountCents: dollarsToCents(100) },
    ]);
  });

  it("decumulation liquidates a named investment account between drawdown and credit", () => {
    // $1000 income, no buffer, $1500 need → $500 gap liquidated from the brokerage. nullJurisdiction
    // has no return-of-capital policy, so the whole draw books as gain — but is untaxed, so the net
    // delivered equals the gross sold.
    const funding = attributionAt({
      accounts: [cashAccount(0), investmentAccount(dollarsToCents(10000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("need", 1500, 0)],
    });

    expect(byObligation(funding, "line:need").sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(1000) },
      {
        kind: "account",
        sourceId: "brokerage",
        amountCents: dollarsToCents(500),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(500),
          principalCents: 0,
          realizedGainCents: dollarsToCents(500),
          taxCents: 0,
          netDeliveredCents: dollarsToCents(500),
        },
      },
    ]);
  });

  it("a debt obligation attributes as fully funded from the highest-priority source", () => {
    // The loan payment is mandatory (funded first); ample income covers it and the expense.
    const funding = attributionAt({
      accounts: [cashAccount(0)],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(4000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1200, 0)],
      liabilities: [
        new RevolvingCard({
          id: "card",
          ownerId: "p1",
          openingBalanceCents: dollarsToCents(2000),
          apr: 0.2,
          creditLimitCents: dollarsToCents(10000),
          startMonth: -1,
        }),
      ],
    });

    const debt = byObligation(funding, "debt:card");
    expect(debt.shortfallCents).toBe(0);
    expect(debt.fundedCents).toBe(debt.requestedCents);
    expect(kinds(debt)).toEqual(["income"]);
  });

  it("attributes an explicit obligation to its named account through the same pipeline, never income", () => {
    const funding = attributionAt({
      accounts: [cashAccount(0), namedAccount("savings", dollarsToCents(50000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0)],
      fundingDraws: [downPayment(dollarsToCents(40000), ["savings"])],
    });

    // Identity is the draw's own id, distinct from the shared reporting namespace `downpayment`.
    const draw = byObligation(funding, "draw:downpayment:home-1");
    expect(draw.sourceId).toBe("downpayment");
    expect(draw.shortfallCents).toBe(0);
    expect(draw.fundedCents).toBe(dollarsToCents(40000));
    expect(draw.fundedCents + draw.shortfallCents).toBe(draw.requestedCents);
    expect(kinds(draw)).toEqual(["account"]);
    expect(draw.sources).toEqual([
      {
        kind: "account",
        sourceId: "savings",
        amountCents: dollarsToCents(40000),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(40000),
          principalCents: dollarsToCents(40000),
          realizedGainCents: 0,
          taxCents: 0,
          netDeliveredCents: dollarsToCents(40000),
        },
      },
    ]);

    // The automatic branch still attributes to income through the SAME flat list — one pipeline.
    expect(kinds(byObligation(funding, "line:rent"))).toEqual(["income"]);
  });

  it("attributes one explicit purchase across two accounts, draining them in ordered turn", () => {
    // A $40k purchase against `["savings-a", "savings-b"]`: savings-a holds only $30k, so it is
    // emptied first and savings-b covers the $10k remainder. One obligation, two account sources —
    // the ordered draw, not two records. nullJurisdiction: basis == balance ⇒ no gain, no tax, so
    // each source's net delivered is exactly the cash pulled from that account.
    const funding = attributionAt({
      accounts: [
        cashAccount(0),
        namedAccount("savings-a", dollarsToCents(30000)),
        namedAccount("savings-b", dollarsToCents(50000)),
      ],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0)],
      fundingDraws: [downPayment(dollarsToCents(40000), ["savings-a", "savings-b"])],
    });

    const draw = byObligation(funding, "draw:downpayment:home-1");
    expect(draw.shortfallCents).toBe(0);
    expect(draw.fundedCents).toBe(dollarsToCents(40000));
    expect(draw.fundedCents + draw.shortfallCents).toBe(draw.requestedCents);
    // Both drained accounts surface as `account` sources, in the order the draw consumed them —
    // savings-a exhausted before savings-b is touched.
    expect(kinds(draw)).toEqual(["account", "account"]);
    expect(draw.sources).toEqual([
      {
        kind: "account",
        sourceId: "savings-a",
        amountCents: dollarsToCents(30000),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(30000),
          principalCents: dollarsToCents(30000),
          realizedGainCents: 0,
          taxCents: 0,
          netDeliveredCents: dollarsToCents(30000),
        },
      },
      {
        kind: "account",
        sourceId: "savings-b",
        amountCents: dollarsToCents(10000),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(10000),
          principalCents: dollarsToCents(10000),
          realizedGainCents: 0,
          taxCents: 0,
          netDeliveredCents: dollarsToCents(10000),
        },
      },
    ]);
    // The two source amounts still reconcile to the single obligation's funded total.
    expect(draw.sources.reduce((t, s) => t + s.amountCents, 0)).toBe(draw.fundedCents);
  });

  it("keeps two same-purpose explicit obligations in one month as distinct records", () => {
    // Two home-purchase down payments in the same month sharing the reporting namespace
    // `downpayment`. They must survive as two records: identity is per-purchase (`obligationId`),
    // and `sourceId` is a shared reporting band, never the key. Different amounts and different
    // named accounts so a merge would be visible as a lost or overwritten figure, not hidden by
    // coincidentally-equal values.
    const funding = attributionAt({
      accounts: [
        cashAccount(0),
        namedAccount("savings-a", dollarsToCents(50000)),
        namedAccount("savings-b", dollarsToCents(50000)),
      ],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0)],
      fundingDraws: [
        downPayment(dollarsToCents(40000), ["savings-a"], "downpayment:home-1"),
        downPayment(dollarsToCents(25000), ["savings-b"], "downpayment:home-2"),
      ],
    });

    const purchases = funding.filter((f) => f.sourceId === "downpayment");
    // Two purchases in, two records out — neither collapsed the other on the shared `sourceId`.
    expect(purchases.length).toBe(2);
    // Distinct, stable identities derived from each purchase's own id, not the shared namespace.
    expect(purchases.map((p) => p.obligationId).sort()).toEqual([
      "draw:downpayment:home-1",
      "draw:downpayment:home-2",
    ]);

    const home1 = byObligation(funding, "draw:downpayment:home-1");
    const home2 = byObligation(funding, "draw:downpayment:home-2");

    // Each keeps its own requested/funded/shortfall — no figure bled across the shared namespace.
    expect([home1.requestedCents, home1.fundedCents, home1.shortfallCents]).toEqual([
      dollarsToCents(40000),
      dollarsToCents(40000),
      0,
    ]);
    expect([home2.requestedCents, home2.fundedCents, home2.shortfallCents]).toEqual([
      dollarsToCents(25000),
      dollarsToCents(25000),
      0,
    ]);

    // Each retains its own source allocation, drawn from its own named account.
    expect(home1.sources).toEqual([
      {
        kind: "account",
        sourceId: "savings-a",
        amountCents: dollarsToCents(40000),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(40000),
          principalCents: dollarsToCents(40000),
          realizedGainCents: 0,
          taxCents: 0,
          netDeliveredCents: dollarsToCents(40000),
        },
      },
    ]);
    expect(home2.sources).toEqual([
      {
        kind: "account",
        sourceId: "savings-b",
        amountCents: dollarsToCents(25000),
        withdrawal: {
          grossWithdrawnCents: dollarsToCents(25000),
          principalCents: dollarsToCents(25000),
          realizedGainCents: 0,
          taxCents: 0,
          netDeliveredCents: dollarsToCents(25000),
        },
      },
    ]);

    // Aggregating the two purchases is a deliberate reduce over distinct records at the reporting
    // layer — available on demand, but never what the engine stored in their place.
    expect(purchases.reduce((t, p) => t + p.requestedCents, 0)).toBe(dollarsToCents(65000));
  });

  it("reconciles an explicit obligation's fundedCents with the account balance it actually moved", () => {
    const flows = run({
      accounts: [cashAccount(0), namedAccount("savings", dollarsToCents(50000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0)],
      fundingDraws: [downPayment(dollarsToCents(40000), ["savings"])],
    }).months[0].flows;
    if (flows?.resolvedFunding === undefined || flows.accountBalancesAfterFundingCents === undefined) {
      throw new Error("expected resolvedFunding and post-funding balances on the flow record");
    }
    const draw = byObligation(flows.resolvedFunding, "draw:downpayment:home-1");
    // No tax under nullJurisdiction, so cash out of the account IS cash delivered to the purchase.
    const movedCents = dollarsToCents(50000) - flows.accountBalancesAfterFundingCents["savings"];
    expect(movedCents).toBe(draw.fundedCents);
    expect(draw.sources.reduce((t, s) => t + s.amountCents, 0)).toBe(draw.fundedCents);
  });

  it("surfaces the decumulation account's full withdrawal breakdown on the funding source", () => {
    // $1000 income, no buffer, $1500 need → $500 liquidated from the brokerage.
    const month = run({
      accounts: [cashAccount(0), investmentAccount(dollarsToCents(10000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("need", 1500, 0)],
    }).months[0];
    if (month.flows?.resolvedFunding === undefined) {
      throw new Error("expected resolvedFunding on the flow record");
    }
    const source = byObligation(month.flows.resolvedFunding, "line:need").sources.find(
      (s) => s.sourceId === "brokerage",
    );
    if (source?.withdrawal === undefined) throw new Error("expected a withdrawal breakdown on the account source");

    // amountCents applied to the line IS the net the account delivered.
    expect(source.amountCents).toBe(source.withdrawal.netDeliveredCents);
    // Internal identities hold on the surfaced breakdown.
    expect(source.withdrawal.principalCents + source.withdrawal.realizedGainCents).toBe(
      source.withdrawal.grossWithdrawnCents,
    );
    expect(source.withdrawal.grossWithdrawnCents - source.withdrawal.taxCents).toBe(
      source.withdrawal.netDeliveredCents,
    );
    // Gross withdrawn matches the account balance reduction the sale actually booked.
    expect(source.withdrawal.grossWithdrawnCents).toBe(
      dollarsToCents(10000) - month.accountBalancesCents["brokerage"],
    );
  });

  it("an appreciated pre-tax withdrawal reports gross withdrawn greater than net delivered", () => {
    // $1000 income, no buffer, $2000 need → a pre-tax liquidation grossed up over 25% tax.
    const month = run(
      {
        accounts: [cashAccount(0), preTaxAccount("pretax", dollarsToCents(100000))],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
        expenseSeries: [expenseLine("need", 2000, 0)],
      },
      flatOrdinaryTax,
    ).months[0];
    if (month.flows?.resolvedFunding === undefined) {
      throw new Error("expected resolvedFunding on the flow record");
    }
    const source = byObligation(month.flows.resolvedFunding, "line:need").sources.find(
      (s) => s.sourceId === "pretax",
    );
    if (source?.withdrawal === undefined) throw new Error("expected a withdrawal breakdown on the account source");

    expect(source.amountCents).toBe(source.withdrawal.netDeliveredCents);
    // Tax is withheld from the sale, so gross sold exceeds the net delivered toward the line.
    expect(source.withdrawal.grossWithdrawnCents).toBeGreaterThan(source.withdrawal.netDeliveredCents);
    // Gross matches the balance reduction; realized gain is the whole draw (pre-tax basis 0).
    expect(source.withdrawal.grossWithdrawnCents).toBe(
      dollarsToCents(100000) - month.accountBalancesCents["pretax"],
    );
    expect(source.withdrawal.realizedGainCents).toBe(source.withdrawal.grossWithdrawnCents);
    // Returned principal matches the (zero) basis reduction of a pre-tax account.
    expect(source.withdrawal.principalCents).toBe(dollarsToCents(0) - month.accountBasisCents["pretax"]);
    expect(source.withdrawal.principalCents).toBe(0);
    expect(source.withdrawal.taxCents).toBeGreaterThan(0);
  });

  it("liquidates an appreciated capital-gains account, booking partial principal, gain and tax", () => {
    // The brokerage opens at basis == balance and grows 12%/yr. After a year of deferred
    // appreciation its basis sits below its balance, so an explicit $40k purchase in month 12
    // realizes a PROPORTIONAL gain — grossed up over the 25% capital-gains tax so the net still
    // lands the $40k. Income covers the recurring rent every month, so nothing forces an automatic
    // draw: the appreciated account is touched only by the explicit purchase. A year is the
    // shortest honest way to embed the gain — the sim never opens a post-tax account already
    // appreciated, so the basis gap can only come from compounding across months.
    const result = simulateHousehold(
      {
        horizonMonths: 13,
        annualInflationRate: 0,
        persons: [PERSON],
        accounts: [cashAccount(0), appreciatingAccount("brokerage", dollarsToCents(100000), 0.12)],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [expenseLine("rent", 1000, 0)],
        fundingDraws: [
          explicitObligation({
            id: "downpayment:home-1",
            sourceId: "downpayment",
            month: 12,
            amountCents: dollarsToCents(40000),
            orderedAccountIds: ["brokerage"],
            treatment: "asset-acquisition",
          }),
        ],
      },
      flatCapitalGainsTax,
    );

    // The month before the draw: basis still at contributions, balance grown past it — the account
    // carries an unrealized gain waiting to be realized on withdrawal.
    const prior = result.months[11];
    expect(prior.accountBasisCents["brokerage"]).toBe(dollarsToCents(100000));
    expect(prior.accountBalancesCents["brokerage"]).toBeGreaterThan(prior.accountBasisCents["brokerage"]);

    const funding = result.months[12].flows?.resolvedFunding;
    if (funding === undefined) throw new Error("expected resolvedFunding on month 12");
    const draw = byObligation(funding, "draw:downpayment:home-1");
    expect(draw.shortfallCents).toBe(0);
    expect(draw.fundedCents).toBe(dollarsToCents(40000));

    const source = draw.sources.find((s) => s.sourceId === "brokerage");
    if (source?.withdrawal === undefined) {
      throw new Error("expected a withdrawal breakdown on the brokerage source");
    }
    const w = source.withdrawal;

    // Genuine partial appreciation: a returned-principal slice AND a taxed-gain slice both present,
    // unlike a pre-tax draw (all gain, principal 0) or a cash draw (all principal, gain 0).
    expect(w.principalCents).toBeGreaterThan(0);
    expect(w.realizedGainCents).toBeGreaterThan(0);
    expect(w.taxCents).toBeGreaterThan(0);

    // The surfaced breakdown obeys its identities, and the amount applied to the line is the net.
    expect(w.principalCents + w.realizedGainCents).toBe(w.grossWithdrawnCents);
    expect(w.grossWithdrawnCents - w.taxCents).toBe(w.netDeliveredCents);
    expect(source.amountCents).toBe(w.netDeliveredCents);
    expect(w.netDeliveredCents).toBe(dollarsToCents(40000));
    // Gross sold exceeds the cash delivered by exactly the capital-gains tax the sale induced.
    expect(w.grossWithdrawnCents).toBeGreaterThan(w.netDeliveredCents);
    // Tax reconciles with the jurisdiction's own 25% on the realized gain.
    expect(w.taxCents).toBe(Math.round(w.realizedGainCents * 0.25));
  });

  it("reports a OneTimeSpend funded from an appreciated investment through the SAME pipeline a down payment uses", () => {
    // Identical setup to the down-payment appreciated-account test above, but `treatment: "expense"`
    // — the SAME `explicitObligation` abstraction, proving One-Time Spend rides the generic
    // explicit-funding reporting rather than a parallel implementation of its own.
    const result = simulateHousehold(
      {
        horizonMonths: 13,
        annualInflationRate: 0,
        persons: [PERSON],
        accounts: [cashAccount(0), appreciatingAccount("brokerage", dollarsToCents(100000), 0.12)],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [expenseLine("rent", 1000, 0)],
        fundingDraws: [
          explicitObligation({
            id: "spend:car",
            sourceId: "onetimespend",
            month: 12,
            amountCents: dollarsToCents(40000),
            orderedAccountIds: ["brokerage"],
            treatment: "expense",
            label: "Car",
          }),
        ],
      },
      flatCapitalGainsTax,
    );

    const before = result.months[11];
    const at = result.months[12];

    // The full purchase amount is reported once, in expense reporting, at its nominal amount —
    // alongside the automatic rent line, not merged into it.
    expect(at.flows!.expensesCents).toBe(dollarsToCents(1000 + 40000));
    // Never double-counted: the automatic funding total the waterfall sized is the rent line
    // alone — the explicit spend never entered it.
    expect(at.flows!.totalObligationsCents).toBe(dollarsToCents(1000));

    const funding = at.flows?.resolvedFunding;
    if (funding === undefined) throw new Error("expected resolvedFunding on month 12");
    const draw = byObligation(funding, "draw:spend:car");
    expect(draw.shortfallCents).toBe(0);
    expect(draw.fundedCents).toBe(dollarsToCents(40000));

    const source = draw.sources.find((s) => s.sourceId === "brokerage");
    if (source?.withdrawal === undefined) {
      throw new Error("expected a withdrawal breakdown on the brokerage source");
    }
    const w = source.withdrawal;

    // Returned investment principal and realized gain both surface, distinctly, through the
    // same withdrawal-breakdown channel a down payment's investment draw uses.
    expect(w.principalCents).toBeGreaterThan(0);
    expect(w.realizedGainCents).toBeGreaterThan(0);
    expect(w.taxCents).toBeGreaterThan(0);

    // Conservation: gross sold is exactly principal plus gain, and net delivered — the cash that
    // actually reached the purchase — is gross minus tax and lands on the nominal amount owed.
    // (The account's balance also grows this month, so its raw before/after drop is not the
    // draw's gross alone; `before` is read only to confirm growth genuinely occurred.)
    expect(before.accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(100000));
    expect(w.principalCents + w.realizedGainCents).toBe(w.grossWithdrawnCents);
    expect(w.grossWithdrawnCents - w.taxCents).toBe(w.netDeliveredCents);
    expect(w.netDeliveredCents).toBe(dollarsToCents(40000));
  });

  it("splits one decumulation draw across two obligations, slices summing to the account totals", () => {
    // No income, no buffer: a single $2000 pre-tax gross (25% tax) nets $1500, funding two lines.
    const month = run(
      {
        accounts: [cashAccount(0), preTaxAccount("pretax", dollarsToCents(100000))],
        incomeSeries: [],
        expenseSeries: [expenseLine("a", 600, 0), expenseLine("b", 900, 100)],
      },
      flatOrdinaryTax,
    ).months[0];
    if (month.flows?.resolvedFunding === undefined) {
      throw new Error("expected resolvedFunding on the flow record");
    }
    const resolvedFunding = month.flows.resolvedFunding;
    const slices = ["line:a", "line:b"].map((id) => {
      const s = byObligation(resolvedFunding, id).sources.find((x) => x.sourceId === "pretax");
      if (s?.withdrawal === undefined) throw new Error(`expected a withdrawal breakdown on ${id}`);
      return s;
    });

    // Every slice's applied amount is its own net; no slice flattens gross into the amount.
    for (const s of slices) expect(s.amountCents).toBe(s.withdrawal!.netDeliveredCents);

    const grossReduction = dollarsToCents(100000) - month.accountBalancesCents["pretax"];
    const sum = (pick: (w: NonNullable<(typeof slices)[number]["withdrawal"]>) => number) =>
      slices.reduce((t, s) => t + pick(s.withdrawal!), 0);
    // The slices partition the one liquidation exactly: gross sums to the balance reduction, and
    // tax sums to gross minus the total net delivered — no cent gained or lost in the split.
    expect(sum((w) => w.grossWithdrawnCents)).toBe(grossReduction);
    expect(sum((w) => w.taxCents)).toBe(grossReduction - sum((w) => w.netDeliveredCents));
    expect(sum((w) => w.principalCents) + sum((w) => w.realizedGainCents)).toBe(grossReduction);
  });

  it("splits a multi-million-dollar decumulation draw across obligations without precision loss", () => {
    // Cents this large (a $50M account funding two multi-million-dollar lines) push
    // whole * after / net well past Number.MAX_SAFE_INTEGER if the apportionment ever multiplies
    // two cent-denominated numbers together directly — this pins that it doesn't.
    const month = run(
      {
        accounts: [cashAccount(0), preTaxAccount("pretax", dollarsToCents(50_000_000))],
        incomeSeries: [],
        expenseSeries: [
          expenseLine("a", 2_000_000, 0),
          expenseLine("b", 3_000_000, 50),
          expenseLine("c", 900_000, 100),
        ],
      },
      flatOrdinaryTax,
    ).months[0];
    if (month.flows?.resolvedFunding === undefined) {
      throw new Error("expected resolvedFunding on the flow record");
    }
    const resolvedFunding = month.flows.resolvedFunding;
    const slices = ["line:a", "line:b", "line:c"].map((id) => {
      const s = byObligation(resolvedFunding, id).sources.find((x) => x.sourceId === "pretax");
      if (s?.withdrawal === undefined) throw new Error(`expected a withdrawal breakdown on ${id}`);
      return s;
    });

    for (const s of slices) {
      expect(s.amountCents).toBe(s.withdrawal!.netDeliveredCents);
      expect(s.amountCents).toBeGreaterThanOrEqual(0);
      expect(s.withdrawal!.grossWithdrawnCents).toBeGreaterThanOrEqual(0);
      expect(s.withdrawal!.principalCents).toBeGreaterThanOrEqual(0);
      expect(s.withdrawal!.realizedGainCents).toBeGreaterThanOrEqual(0);
      expect(s.withdrawal!.taxCents).toBeGreaterThanOrEqual(0);
      // Every slice keeps `gross = principal + gain` and `net = gross − tax`.
      expect(s.withdrawal!.principalCents + s.withdrawal!.realizedGainCents).toBe(
        s.withdrawal!.grossWithdrawnCents,
      );
      expect(s.withdrawal!.grossWithdrawnCents - s.withdrawal!.taxCents).toBe(
        s.withdrawal!.netDeliveredCents,
      );
    }

    const grossReduction = dollarsToCents(50_000_000) - month.accountBalancesCents["pretax"];
    // whole * after (e.g. grossCents * consumedNetCents) here comfortably exceeds
    // Number.MAX_SAFE_INTEGER — the exact case a naive `Math.round((whole * after) / net)` breaks.
    expect(grossReduction * dollarsToCents(2_000_000)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const sum = (pick: (w: NonNullable<(typeof slices)[number]["withdrawal"]>) => number) =>
      slices.reduce((t, s) => t + pick(s.withdrawal!), 0);
    // The slices partition the one liquidation exactly — no cent gained or lost to overflow.
    expect(sum((w) => w.grossWithdrawnCents)).toBe(grossReduction);
    expect(sum((w) => w.taxCents)).toBe(grossReduction - sum((w) => w.netDeliveredCents));
    expect(sum((w) => w.principalCents) + sum((w) => w.realizedGainCents)).toBe(grossReduction);
  });

  it("keeps funded+shortfall reconciled and sources in cascade order for every record", () => {
    const funding = attributionAt({
      accounts: [cashAccount(dollarsToCents(500)), investmentAccount(dollarsToCents(3000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("a", 900, 0), expenseLine("b", 900, 50), expenseLine("c", 900, 100)],
    });

    const rank: Record<FundingSourceKind, number> = { income: 0, account: 1, credit: 2 };
    for (const record of funding) {
      expect(record.fundedCents + record.shortfallCents).toBe(record.requestedCents);
      const sum = record.sources.reduce((t, s) => t + s.amountCents, 0);
      expect(sum).toBe(record.fundedCents);
      const ranks = record.sources.map((s) => rank[s.kind]);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    }
  });
});
