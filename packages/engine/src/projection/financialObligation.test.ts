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
  assetAcquisitionObligation,
  oneTimeSpendObligation,
  obligationLiabilityId,
  orderObligationsByPriority,
  OBLIGATION_PRIORITY,
  type FinancialObligation,
  type ObligationSource,
} from "./financialObligation";
import { dollarsToCents, SimCashFlowSeries } from "../money/cashFlowSeries";
import { AmortizingLoan, RevolvingCard, type LiabilityKind } from "../liability/liability";
import { buildLiabilityPaymentRecords } from "./liabilitySteps";
import type { SimOwnedSeries } from "./simulate.types";

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

describe("oneTimeSpendObligation — the double-count tripwire", () => {
  it("is treatment expense, funded explicitly", () => {
    const draw = oneTimeSpendObligation({
      id: "spend-1",
      label: "New roof",
      month: 12,
      amountCents: dollarsToCents(30_000),
      orderedAccountIds: ["brokerage", "checking"],
    });
    expect(draw.treatment).toBe("expense");
    expect(draw.funding).toEqual({
      kind: "explicit",
      orderedAccountIds: ["brokerage", "checking"],
    });
  });

  it("counts toward expenseReportingTotal at its full amount, never automaticFundingTotal", () => {
    // The epic's tripwire: this money already left through the explicit draw, so folding it into
    // the automatic total would ask the waterfall/decumulation to cover it a second time.
    const budgetLine = obligation({
      treatment: "expense",
      funding: { kind: "automatic" },
      amountCents: dollarsToCents(2_000),
    });
    const spend = oneTimeSpendObligation({
      id: "spend-1",
      label: "New roof",
      month: 12,
      amountCents: dollarsToCents(30_000),
      orderedAccountIds: ["brokerage"],
    });
    const list = [budgetLine, spend];
    expect(expenseReportingTotal(list)).toBe(dollarsToCents(32_000));
    expect(automaticFundingTotal(list)).toBe(dollarsToCents(2_000));
  });

  it("two spends in one plan never collide on id", () => {
    const a = oneTimeSpendObligation({
      id: "spend-1",
      label: "Roof",
      month: 12,
      amountCents: dollarsToCents(30_000),
      orderedAccountIds: ["brokerage"],
    });
    const b = oneTimeSpendObligation({
      id: "spend-2",
      label: "Car",
      month: 24,
      amountCents: dollarsToCents(20_000),
      orderedAccountIds: ["brokerage"],
    });
    expect(a.id).not.toBe(b.id);
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

const budgetSource = (id: string, category: ObligationSource["category"]): ObligationSource => ({
  kind: "budgetLine",
  id,
  category,
  editable: true,
});

describe("assetAcquisitionObligation — the down payment as an explicit obligation", () => {
  it("represents a cross-account draw as an explicitly-funded asset acquisition", () => {
    // The Home Purchase down payment: a fixed amount drained from an ordered source list, buying
    // a house rather than spending — so asset-acquisition, and explicit because it names its own
    // accounts instead of drawing the shared waterfall. The ordered list rides through verbatim.
    const o = assetAcquisitionObligation({
      id: "downpayment:e1",
      sourceId: "downpayment",
      month: 12,
      amountCents: dollarsToCents(4_000),
      orderedAccountIds: ["brokerage", "savings"],
    });
    expect(o.month).toBe(12);
    expect(o.amountCents).toBe(dollarsToCents(4_000));
    expect(o.treatment).toBe("asset-acquisition");
    expect(o.funding).toEqual({
      kind: "explicit",
      orderedAccountIds: ["brokerage", "savings"],
    });
    // `sourceId` is the report-band namespace: the simulator names this draw's gain/tax bands
    // `downpayment:<account>` / `downpayment-tax:<account>` off it.
    expect(o.sourceId).toBe("downpayment");
    // `id` derives from the caller-supplied `id`, not `sourceId` — two purchases share the same
    // `sourceId` ("downpayment") but must not share an obligation `id`.
    expect(o.id).toBe("draw:downpayment:e1");
  });

  it("gives two home purchases distinct, stable obligation ids despite sharing sourceId", () => {
    // Both purchases report through the same "downpayment" band, but each is its own
    // FinancialObligation and must not collide on `id` — the bug this test guards against.
    const first = assetAcquisitionObligation({
      id: "downpayment:e1",
      sourceId: "downpayment",
      month: 3,
      amountCents: dollarsToCents(50_000),
      orderedAccountIds: ["brokerage"],
    });
    const second = assetAcquisitionObligation({
      id: "downpayment:e2",
      sourceId: "downpayment",
      month: 20,
      amountCents: dollarsToCents(75_000),
      orderedAccountIds: ["savings"],
    });
    expect(first.id).not.toBe(second.id);
    expect(first.sourceId).toBe("downpayment");
    expect(second.sourceId).toBe("downpayment");
    // Stable: rebuilding the same event's obligation reproduces the same id.
    const firstAgain = assetAcquisitionObligation({
      id: "downpayment:e1",
      sourceId: "downpayment",
      month: 3,
      amountCents: dollarsToCents(50_000),
      orderedAccountIds: ["brokerage"],
    });
    expect(firstAgain.id).toBe(first.id);
  });

  it("stays out of the shared waterfall and off the expense report", () => {
    // Explicitly funded, so it must not inflate what the waterfall covers; an acquisition, so it
    // is not an expense — the two named sums both exclude it, exactly as they will once it is the
    // sole record of the down payment.
    const o = assetAcquisitionObligation({
      id: "downpayment:e1",
      sourceId: "downpayment",
      month: 0,
      amountCents: dollarsToCents(4_000),
      orderedAccountIds: ["brokerage"],
    });
    expect(automaticFundingTotal([o])).toBe(0);
    expect(expenseReportingTotal([o])).toBe(0);
  });
});

describe("buildObligations — one obligation per source", () => {
  it("turns an authored budget line into an editable automatic expense", () => {
    const [o] = buildObligations(
      [expenseSeries(1_600, { label: "Housing", obligationSource: budgetSource("housing", "needs") })],
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

  it("turns a health budget line into an EDITABLE healthcare expense", () => {
    // Health is authored as a `healthcare`-category budget line, so it arrives here with every
    // other line: same kind, same editability. Only the category still says it is health.
    const [o] = buildObligations(
      [
        expenseSeries(450, {
          label: "Healthcare",
          obligationSource: { kind: "budgetLine", id: "health", category: "healthcare", editable: true },
        }),
      ],
      3,
      [],
      new Map(),
    );
    expect(o.sourceKind).toBe("budgetLine");
    expect(o.editable).toBe(true);
    expect(o.category).toBe("healthcare");
    expect(o.treatment).toBe("expense");
    // And it takes the `line:` prefix every budget line gets, where it used to carry its
    // source id verbatim as a plan-level series.
    expect(o.id).toBe("line:health");
    expect(o.amountCents).toBe(dollarsToCents(450));
  });

  it("turns an event-spawned child-cost series into a non-editable event expense", () => {
    const [o] = buildObligations(
      [
        expenseSeries(900, {
          label: "Child cost",
          obligationSource: { kind: "event", id: "child-1:childCost", category: "other", editable: false },
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
          obligationSource: { kind: "event", id: "sep-1:alimony", category: "other", editable: false },
        }),
        expenseSeries(1_200, {
          label: "Child support",
          obligationSource: { kind: "event", id: "sep-1:childSupport", category: "other", editable: false },
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
      obligationSource: budgetSource("housing", "needs"),
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

describe("buildObligations — priority resolved from source kind", () => {
  it("ranks a debt payment in the mandatory tier — never rationed, above every expense", () => {
    const loan = new AmortizingLoan({
      id: "loan-1",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(200_000),
      apr: 0.05,
      termMonths: 360,
    });
    const month = 12;
    const payment = loan.monthlyPaymentCents(dollarsToCents(200_000), month);
    const [o] = buildObligations([], month, [loan], new Map([[loan.id, payment]]));
    expect(o.priority).toBe(OBLIGATION_PRIORITY.mandatory);
    expect(o.priority).toBeLessThan(OBLIGATION_PRIORITY.needs);
  });

  it("puts a healthcare line in the needs tier, the rank health always funded at", () => {
    // Carried on the source by budget-line compilation (`budgetLinePriority`), which resolves
    // the `healthcare` category to the same 0 the needs tier uses.
    const [o] = buildObligations(
      [
        expenseSeries(450, {
          obligationSource: {
            kind: "budgetLine",
            id: "health",
            category: "healthcare",
            editable: true,
            priority: OBLIGATION_PRIORITY.needs,
          },
        }),
      ],
      0,
      [],
      new Map(),
    );
    expect(o.priority).toBe(OBLIGATION_PRIORITY.needs);
  });

  it("puts a child-cost event in the needs tier", () => {
    // A child's cost carries no source priority, so it defaults to the needs tier by its kind.
    const [o] = buildObligations(
      [
        expenseSeries(900, {
          obligationSource: { kind: "event", id: "child-1:childCost", category: "other", editable: false },
        }),
      ],
      0,
      [],
      new Map(),
    );
    expect(o.priority).toBe(OBLIGATION_PRIORITY.needs);
  });

  it("ranks a court-ordered stream alongside debt when its source carries the mandatory tier", () => {
    // Alimony and child support are legally non-rationable; their compiler stamps the mandatory
    // tier on the source (they cannot be told apart from a child's cost by kind alone).
    const [o] = buildObligations(
      [
        expenseSeries(2_000, {
          obligationSource: {
            kind: "event",
            id: "sep-1:alimony",
            category: "other",
            editable: false,
            priority: OBLIGATION_PRIORITY.mandatory,
          },
        }),
      ],
      0,
      [],
      new Map(),
    );
    expect(o.priority).toBe(OBLIGATION_PRIORITY.mandatory);
  });

  it("carries a budget line's own priority through, ranking wants below needs", () => {
    const needsLine = expenseSeries(1_600, {
      obligationSource: { kind: "budgetLine", id: "housing", category: "needs", editable: true, priority: 0 },
    });
    const wantsLine = expenseSeries(300, {
      obligationSource: { kind: "budgetLine", id: "streaming", category: "wants", editable: true, priority: 1_000 },
    });
    const [needs, wants] = buildObligations([needsLine, wantsLine], 0, [], new Map());
    expect(needs.priority).toBe(0);
    expect(wants.priority).toBe(1_000);
    expect(needs.priority).toBeLessThan(wants.priority);
  });

  it("funds an untracked series after every authored tier", () => {
    const [o] = buildObligations([expenseSeries(300)], 0, [], new Map());
    expect(o.priority).toBe(OBLIGATION_PRIORITY.untracked);
    expect(o.priority).toBeGreaterThan(OBLIGATION_PRIORITY.needs);
  });
});

describe("orderObligationsByPriority — the reported chart-band order", () => {
  it("sorts lower priority first — mandatory debt below needs below wants", () => {
    // The waterfall consumed an order-invariant sum, so buildObligations returns source order;
    // the flow record orders by priority so bands stack mandatory-at-the-bottom.
    const ordered = orderObligationsByPriority([
      obligation({ id: "line:streaming", priority: 1_000 }),
      obligation({ id: "debt:mortgage", priority: OBLIGATION_PRIORITY.mandatory }),
      obligation({ id: "line:housing", priority: OBLIGATION_PRIORITY.needs }),
    ]);
    expect(ordered.map((o) => o.id)).toEqual(["debt:mortgage", "line:housing", "line:streaming"]);
  });

  it("breaks ties on the stable id, so a tier holds one order across months", () => {
    // Two needs-tier obligations must not reshuffle between months; the id tie-break pins them
    // whatever order they arrived in.
    const ids = ["line:zebra", "line:apple", "line:mango"];
    const forward = orderObligationsByPriority(
      ids.map((id) => obligation({ id, priority: OBLIGATION_PRIORITY.needs })),
    );
    const reversed = orderObligationsByPriority(
      [...ids].reverse().map((id) => obligation({ id, priority: OBLIGATION_PRIORITY.needs })),
    );
    expect(forward.map((o) => o.id)).toEqual(["line:apple", "line:mango", "line:zebra"]);
    expect(reversed.map((o) => o.id)).toEqual(forward.map((o) => o.id));
  });

  it("does not mutate the input list", () => {
    const input = [obligation({ id: "b", priority: 1 }), obligation({ id: "a", priority: 0 })];
    orderObligationsByPriority(input);
    expect(input.map((o) => o.id)).toEqual(["b", "a"]);
  });
});
