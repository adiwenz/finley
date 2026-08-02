/**
 * @vitest-environment node
 *
 * The **Funded by** section — what covered each obligation at the selected month, rendered from
 * `flows.resolvedFunding`. Server-rendered: these assert on markup, not interaction. The
 * attribution arithmetic lives in the engine and `fundingView`; this pins the wiring — one entry
 * per record keyed by `obligationId`, two same-purpose purchases kept apart, and the account
 * withdrawal breakdown surfaced where the resolver produced one.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FinancialObligation, ResolvedFunding } from "@finley/engine";
import { FundingAttribution } from "./fundingAttribution";

const INCOME_LINE: ResolvedFunding = {
  obligationId: "line:rent",
  sourceId: "rent",
  month: 12,
  requestedCents: 300_000,
  fundedCents: 300_000,
  shortfallCents: 0,
  sources: [{ kind: "income", sourceId: "income", amountCents: 300_000 }],
};

const TWO_DOWN_PAYMENTS: ResolvedFunding[] = [
  {
    obligationId: "draw:downpayment:home-1",
    sourceId: "downpayment",
    month: 120,
    requestedCents: 6_000_000,
    fundedCents: 6_000_000,
    shortfallCents: 0,
    sources: [
      {
        kind: "account",
        sourceId: "brokerage",
        amountCents: 6_000_000,
        withdrawal: {
          grossWithdrawnCents: 8_000_000,
          principalCents: 5_000_000,
          realizedGainCents: 3_000_000,
          taxCents: 2_000_000,
          netDeliveredCents: 6_000_000,
        },
      },
    ],
  },
  {
    obligationId: "draw:downpayment:home-2",
    sourceId: "downpayment",
    month: 120,
    requestedCents: 4_000_000,
    fundedCents: 4_000_000,
    shortfallCents: 0,
    sources: [{ kind: "account", sourceId: "savings", amountCents: 4_000_000 }],
  },
];

describe("FundingAttribution", () => {
  it("shows what covered an obligation, naming the source and the amount", () => {
    const obligations = [{ id: "line:rent", label: "Rent" } as unknown as FinancialObligation];
    const html = renderToStaticMarkup(
      <FundingAttribution resolvedFunding={[INCOME_LINE]} obligations={obligations} />,
    );
    expect(html).toContain("Rent");
    expect(html).toContain("Income");
  });

  it("renders two same-purpose down payments as separate entries", () => {
    const html = renderToStaticMarkup(
      <FundingAttribution resolvedFunding={TWO_DOWN_PAYMENTS} obligations={[]} />,
    );
    // Keyed by obligationId, so both purchases stand on their own despite one shared `sourceId`.
    expect(html).toContain('data-obligation="draw:downpayment:home-1"');
    expect(html).toContain('data-obligation="draw:downpayment:home-2"');
  });

  it("exposes the account withdrawal breakdown for an appreciated source", () => {
    const labels = new Map([["brokerage", "Vanguard brokerage"]]);
    const html = renderToStaticMarkup(
      <FundingAttribution
        resolvedFunding={[TWO_DOWN_PAYMENTS[0]]}
        obligations={[]}
        accountLabels={labels}
      />,
    );
    expect(html).toContain("Vanguard brokerage");
    // Gross withdrawn $80,000, realized gain $30,000, tax $20,000, net delivered $60,000.
    expect(html).toContain("$80,000");
    expect(html).toContain("$30,000");
    expect(html).toContain("$20,000");
    expect(html).toContain("$60,000");
  });

  it("renders nothing when the month funded no obligations", () => {
    const html = renderToStaticMarkup(
      <FundingAttribution resolvedFunding={[]} obligations={[]} />,
    );
    expect(html).toBe("");
  });
});
