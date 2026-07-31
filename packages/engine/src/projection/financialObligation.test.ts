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
  type FinancialObligation,
} from "./financialObligation";
import { dollarsToCents } from "../cashFlowSeries";

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
