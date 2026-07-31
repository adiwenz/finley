/**
 * The two named sums over a `FinancialObligation` list. They coincide in this slice — every
 * obligation is automatically funded and the reporting/funding split has no explicit branch to
 * separate yet — but they answer different questions and diverge permanently once explicit
 * funding lands (Slice #4). These tests pin each predicate independently so a later
 * "simplification" that collapses them back into one reduce fails here.
 */

import { describe, it, expect } from "vitest";
import {
  automaticFundingTotal,
  expenseReportingTotal,
  buildObligations,
  obligationLiabilityId,
  type FinancialObligation,
} from "./financialObligation";
import { dollarsToCents, SimCashFlowSeries } from "../cashFlowSeries";
import { AmortizingLoan, RevolvingCard, type LiabilityKind } from "../liability";
import { buildLiabilityPaymentRecords } from "./liabilitySteps";
import type { SimOwnedSeries } from "./simulate.types";
import type { SpendingSource } from "./spendingItems";

/** Build an obligation with sane defaults, overriding only what a case cares about. */
function obligation(over: Partial<FinancialObligation> = {}): FinancialObligation {
  return {
    id: "o",
    sourceId: "s",
    month: 0,
    amountCents: dollarsToCents(100),
    treatment: "expense",
    funding: { kind: "automatic" },
    priority: 100,
    sourceKind: "budgetLine",
    editable: true,
    label: "Something",
    category: "needs",
    ...over,
  };
}

describe("financialObligation — the two named sums", () => {
  it("both return 0 for an empty list", () => {
    expect(automaticFundingTotal([])).toBe(0);
    expect(expenseReportingTotal([])).toBe(0);
  });

  it("coincide when every obligation is an automatically-funded expense", () => {
    // The slice-3 reality: budget lines, healthcare and event expenses are all automatic
    // expenses, so both sums see the same list and return the same total. That they agree
    // here is exactly why they must stay two functions — collapsing them looks harmless now.
    const list = [
      obligation({ amountCents: dollarsToCents(1_600) }),
      obligation({ amountCents: dollarsToCents(450), category: "healthcare" }),
      obligation({ amountCents: dollarsToCents(900), category: "other" }),
    ];
    const expected = dollarsToCents(2_950);
    expect(automaticFundingTotal(list)).toBe(expected);
    expect(expenseReportingTotal(list)).toBe(expected);
  });

  it("automaticFundingTotal counts every automatic obligation regardless of treatment", () => {
    // The waterfall funds and decumulation sizes against the whole automatic draw — a debt
    // payment and an asset acquisition consume the same shared cash as an expense does.
    const list = [
      obligation({ treatment: "expense", amountCents: dollarsToCents(1_000) }),
      obligation({ treatment: "debt-payment", amountCents: dollarsToCents(300) }),
      obligation({ treatment: "asset-acquisition", amountCents: dollarsToCents(500) }),
    ];
    expect(automaticFundingTotal(list)).toBe(dollarsToCents(1_800));
  });

  it("automaticFundingTotal excludes explicitly-funded obligations", () => {
    // An explicit obligation is drawn from its own named accounts, not the shared waterfall,
    // so it must not inflate the amount the waterfall is asked to cover. Unused until Slice #4.
    const list = [
      obligation({ funding: { kind: "automatic" }, amountCents: dollarsToCents(1_000) }),
      obligation({
        funding: { kind: "explicit", orderedAccountIds: ["acc-1", "acc-2"] },
        amountCents: dollarsToCents(400),
      }),
    ];
    expect(automaticFundingTotal(list)).toBe(dollarsToCents(1_000));
  });

  it("expenseReportingTotal counts only expense-treatment obligations", () => {
    // Debt payments and asset acquisitions move money without being expenses — they never
    // reach the expense graph or its totals, whatever their treatment costs to fund.
    const list = [
      obligation({ treatment: "expense", amountCents: dollarsToCents(1_000) }),
      obligation({ treatment: "debt-payment", amountCents: dollarsToCents(300) }),
      obligation({ treatment: "asset-acquisition", amountCents: dollarsToCents(500) }),
    ];
    expect(expenseReportingTotal(list)).toBe(dollarsToCents(1_000));
  });

  it("expenseReportingTotal counts an expense under either funding kind", () => {
    // An explicitly-funded expense is still an expense to report — the reporting sum splits on
    // treatment, not on how the money was sourced. This is where it diverges from the funding
    // sum: the same explicit expense leaves automaticFundingTotal but stays here.
    const list = [
      obligation({ treatment: "expense", funding: { kind: "automatic" }, amountCents: dollarsToCents(1_000) }),
      obligation({
        treatment: "expense",
        funding: { kind: "explicit", orderedAccountIds: ["acc-1"] },
        amountCents: dollarsToCents(400),
      }),
    ];
    expect(expenseReportingTotal(list)).toBe(dollarsToCents(1_400));
    expect(automaticFundingTotal(list)).toBe(dollarsToCents(1_000));
  });
});

/** A fixed monthly expense series carrying the authoring provenance a source tags it with. */
function expenseSeries(monthlyDollars: number, over: Partial<SimOwnedSeries> = {}): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
    ...over,
  };
}

const budgetSource = (id: string, category: SpendingSource["category"]): SpendingSource => ({
  kind: "budgetLine",
  id,
  category,
  editable: true,
});

describe("buildObligations — one obligation per source", () => {
  it("turns an authored budget line into an editable automatic expense", () => {
    const [o] = buildObligations(
      [expenseSeries(1_600, { label: "Housing", spendingSource: budgetSource("housing", "needs") })],
      7,
      [],
      new Map(),
    );
    expect(o).toEqual({
      id: "line:housing",
      sourceId: "housing",
      month: 7,
      amountCents: dollarsToCents(1_600),
      treatment: "expense",
      funding: { kind: "automatic" },
      priority: expect.any(Number),
      sourceKind: "budgetLine",
      editable: true,
      label: "Housing",
      category: "needs",
    });
  });

  it("turns the plan's health line into a non-editable healthcare expense", () => {
    const [o] = buildObligations(
      [
        expenseSeries(450, {
          label: "Healthcare",
          spendingSource: { kind: "healthcare", id: "health", category: "healthcare", editable: false },
        }),
      ],
      3,
      [],
      new Map(),
    );
    expect(o.sourceKind).toBe("healthcare");
    expect(o.category).toBe("healthcare");
    expect(o.treatment).toBe("expense");
    expect(o.editable).toBe(false);
    // The id is the source id verbatim (only budget lines get the `line:` prefix).
    expect(o.id).toBe("health");
    expect(o.amountCents).toBe(dollarsToCents(450));
  });

  it("turns an event-spawned child-cost series into a non-editable event expense", () => {
    const [o] = buildObligations(
      [
        expenseSeries(900, {
          label: "Child cost",
          spendingSource: { kind: "event", id: "child-1:childCost", category: "other", editable: false },
        }),
      ],
      13,
      [],
      new Map(),
    );
    expect(o.sourceKind).toBe("event");
    expect(o.sourceId).toBe("child-1:childCost");
    expect(o.treatment).toBe("expense");
    expect(o.editable).toBe(false);
    expect(o.amountCents).toBe(dollarsToCents(900));
  });

  it("turns event-spawned alimony and child-support series into event expenses", () => {
    // Both court-ordered streams reach the report as event-sourced expenses, distinct only by
    // their series id — proof each stream produces its own obligation rather than merging.
    const obligations = buildObligations(
      [
        expenseSeries(2_000, {
          label: "Alimony",
          spendingSource: { kind: "event", id: "sep-1:alimony", category: "other", editable: false },
        }),
        expenseSeries(1_200, {
          label: "Child support",
          spendingSource: { kind: "event", id: "sep-1:childSupport", category: "other", editable: false },
        }),
      ],
      24,
      [],
      new Map(),
    );
    expect(obligations.map((o) => [o.sourceId, o.label, o.treatment, o.amountCents])).toEqual([
      ["sep-1:alimony", "Alimony", "expense", dollarsToCents(2_000)],
      ["sep-1:childSupport", "Child support", "expense", dollarsToCents(1_200)],
    ]);
  });

  it("turns each liability payment into a payoff-capped debt-payment obligation", () => {
    // One amortizing loan per amortizing kind plus a revolving card, each named from its kind.
    const loanKinds: Exclude<LiabilityKind, "creditCard">[] = ["mortgage", "auto", "studentLoan"];
    const loans = loanKinds.map(
      (kind) =>
        new AmortizingLoan({
          id: `loan-${kind}`,
          ownerId: "p1",
          kind,
          openingBalanceCents: dollarsToCents(30_000),
          apr: 0.06,
          termMonths: 120,
        }),
    );
    const card = new RevolvingCard({
      id: "card-1",
      ownerId: "p1",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 0.22,
    });
    const liabilities = [...loans, card];

    // The month's payment on each liability's CURRENT balance — the exact figure the
    // simulator passes into both the balance update and this list.
    const month = 50;
    const balances = new Map<string, number>([
      ...loans.map((l) => [l.id, dollarsToCents(30_000)] as const),
      [card.id, dollarsToCents(5_000)],
    ]);
    const payments = new Map(liabilities.map((l) => [l.id, l.monthlyPaymentCents(balances.get(l.id)!, month)]));

    const obligations = buildObligations([], month, liabilities, payments);
    expect(obligations.map((o) => [o.id, o.sourceKind, o.treatment, o.category, o.label])).toEqual([
      [obligationLiabilityId("loan-mortgage"), "liability", "debt-payment", "debtService", "Mortgage payment"],
      [obligationLiabilityId("loan-auto"), "liability", "debt-payment", "debtService", "Auto loan payment"],
      [obligationLiabilityId("loan-studentLoan"), "liability", "debt-payment", "debtService", "Student loan payment"],
      [obligationLiabilityId("card-1"), "liability", "debt-payment", "debtService", "Credit card payment"],
    ]);
    // Each obligation carries exactly the scheduled payment, funded automatically, not editable.
    for (const o of obligations) {
      expect(o.amountCents).toBe(payments.get(o.sourceId));
      expect(o.funding).toEqual({ kind: "automatic" });
      expect(o.editable).toBe(false);
    }
  });

  it("carries the payoff-capped amount on a debt, not the level payment, and still reports full/current", () => {
    const loan = new AmortizingLoan({
      id: "loan-student",
      ownerId: "p1",
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(30_000),
      apr: 0.06,
      termMonths: 120,
    });
    const month = 60;
    // A tiny residual balance pays off far below the ~$333 level payment — the cap is the
    // debt, not affordability.
    const tinyBalanceCents = dollarsToCents(100);
    const cappedPayment = loan.monthlyPaymentCents(tinyBalanceCents, month);
    expect(cappedPayment).toBeLessThan(loan.monthlyPaymentCents(dollarsToCents(30_000), month));

    const payments = new Map([[loan.id, cappedPayment]]);
    const [o] = buildObligations([], month, [loan], payments);
    expect(o.amountCents).toBe(cappedPayment);

    // The payment record over the same figure still reads full/current — the payoff cap is a
    // legitimate smaller payment, not an underpayment.
    const record = buildLiabilityPaymentRecords(payments)[loan.id]!;
    expect(record.paymentStatus).toBe("full");
    expect(record.loanStatus).toBe("current");
  });

  it("skips a liability with no payment due and reports a dormant series at 0", () => {
    // A series is reported even when it produces nothing this month (a band that vanishes
    // reads as deleted); a liability with no entry in `payments` is simply absent.
    const dormant = expenseSeries(0, {
      label: "Housing",
      spendingSource: budgetSource("housing", "needs"),
    });
    const loan = new AmortizingLoan({
      id: "loan-1",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(20_000),
      apr: 0.05,
      termMonths: 60,
    });
    const obligations = buildObligations([dormant], 5, [loan], new Map());
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.amountCents).toBe(0);
    expect(obligations[0]!.sourceKind).toBe("budgetLine");
  });

  it("falls back to untracked provenance for an expense series that tags none", () => {
    const [o] = buildObligations([expenseSeries(300)], 0, [], new Map());
    expect(o.sourceKind).toBe("untracked");
    expect(o.editable).toBe(false);
    expect(o.category).toBe("other");
    expect(o.amountCents).toBe(dollarsToCents(300));
  });
});
