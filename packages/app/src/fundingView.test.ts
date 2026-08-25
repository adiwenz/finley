/**
 * @vitest-environment node
 *
 * Per-line funding attribution, as the UI presents it. These pin the presentation contract the
 * spec turns on — one row per obligation, keyed by `obligationId` never `sourceId`, sources
 * labelled from `kind` never id, and the account withdrawal breakdown carried through where the
 * resolver produced one. The engine-side records are already covered by `resolvedFunding.test.ts`;
 * these guard the seam the UI reads them at.
 */

import { describe, it, expect } from "vitest";
import type { FinancialObligation, ResolvedFunding } from "@finley/engine";
import { buildFundingAttribution } from "./fundingView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { runOf } from "./testing/projectionHarness";

/** The issue's own two-down-payment example: same month, same `sourceId`, distinct `obligationId`. */
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
    sources: [
      { kind: "account", sourceId: "savings", amountCents: 4_000_000 },
    ],
  },
];

/** One automatic obligation run tight: income covers most, credit finishes it, leaving a shortfall. */
const TIGHT_LINE: ResolvedFunding = {
  obligationId: "line:rent",
  sourceId: "rent",
  month: 12,
  requestedCents: 300_000,
  fundedCents: 250_000,
  shortfallCents: 50_000,
  sources: [
    { kind: "income", sourceId: "income", amountCents: 200_000 },
    { kind: "credit", sourceId: "credit", amountCents: 50_000 },
  ],
};

describe("buildFundingAttribution — record identity", () => {
  it("keeps two obligations sharing a reporting purpose as separate rows", () => {
    const rows = buildFundingAttribution(TWO_DOWN_PAYMENTS);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.obligationId)).toEqual([
      "draw:downpayment:home-1",
      "draw:downpayment:home-2",
    ]);
    // Both carry the shared reporting namespace, but it never fused them into one row.
    expect(rows.every((r) => r.sourceId === "downpayment")).toBe(true);
  });
});

describe("buildFundingAttribution — source labels", () => {
  it("labels income and credit from kind, not by parsing the id", () => {
    const [row] = buildFundingAttribution([TIGHT_LINE]);
    expect(row.sources.map((s) => s.label)).toEqual(["Income", "Credit"]);
  });

  it("uses the account's friendly label when one is supplied, else the account id", () => {
    const labels = new Map([["brokerage", "Vanguard brokerage"]]);
    const rows = buildFundingAttribution(TWO_DOWN_PAYMENTS, [], { accountLabels: labels });
    expect(rows[0].sources[0].label).toBe("Vanguard brokerage");
    // No label for "savings" → falls back to the account id rather than inventing one.
    expect(rows[1].sources[0].label).toBe("savings");
  });
});

describe("buildFundingAttribution — funded state and labels", () => {
  it("surfaces the shortfall and marks a partially funded obligation", () => {
    const [row] = buildFundingAttribution([TIGHT_LINE]);
    expect(row.shortfallCents).toBe(50_000);
    expect(row.fullyFunded).toBe(false);
    expect(row.fundedCents).toBe(250_000);
  });

  it("joins the authored obligation label when the record matches one; derives it otherwise", () => {
    const obligations = [
      { id: "line:rent", label: "Rent" } as unknown as FinancialObligation,
    ];
    const [line, purchase] = buildFundingAttribution([TIGHT_LINE, TWO_DOWN_PAYMENTS[0]], obligations);
    expect(line.label).toBe("Rent");
    // The explicit draw is absent from `obligations`; its label strips the engine's `draw:` prefix,
    // keeping the reporting purpose and per-purchase disambiguator visible.
    expect(purchase.label).toBe("downpayment:home-1");
  });
});

describe("buildFundingAttribution — wired to a real projection", () => {
  it("presents every obligation of a default-plan month with a labelled source per record", () => {
    const flows = runOf(PLAN_DEFAULTS).series.months[0]?.flows;
    const rows = buildFundingAttribution(flows!.resolvedFunding, flows!.obligations);
    // One row per record — the array is never collapsed on the way to the view.
    expect(rows).toHaveLength(flows!.resolvedFunding.length);
    expect(rows.length).toBeGreaterThan(0);
    // Every obligation is fully funded (nothing stops being paid) and every source carries a
    // non-empty label resolved from its kind, never a raw id parse. The funded total reconciles
    // with the sources that paid it.
    for (const row of rows) {
      expect(row.fullyFunded).toBe(true);
      expect(row.sources.length).toBeGreaterThan(0);
      expect(row.sources.every((s) => s.label.length > 0)).toBe(true);
      expect(row.sources.reduce((sum, s) => sum + s.amountCents, 0)).toBe(row.fundedCents);
    }
    // The opening month runs primarily on wages, so income is present somewhere.
    expect(rows.some((r) => r.sources.some((s) => s.kind === "income"))).toBe(true);
    // The join surfaces the authored line label, not the raw id.
    const rent = rows.find((r) => r.obligationId === "line:line-4");
    expect(rent?.label).not.toBe("line:line-4");
  });
});

describe("buildFundingAttribution — withdrawal breakdown", () => {
  it("carries the account withdrawal breakdown through only where the resolver produced one", () => {
    const rows = buildFundingAttribution(TWO_DOWN_PAYMENTS);
    // Appreciated brokerage: gross withdrawn exceeds net delivered, with the gain and tax retained.
    const appreciated = rows[0].sources[0];
    expect(appreciated.withdrawal).toEqual({
      grossWithdrawnCents: 8_000_000,
      principalCents: 5_000_000,
      realizedGainCents: 3_000_000,
      taxCents: 2_000_000,
      netDeliveredCents: 6_000_000,
    });
    expect(appreciated.withdrawal!.grossWithdrawnCents).toBeGreaterThan(appreciated.amountCents);
    expect(appreciated.amountCents).toBe(appreciated.withdrawal!.netDeliveredCents);
    // The cash savings draw passed no withdrawal resolver, so it carries no breakdown.
    expect(rows[1].sources[0].withdrawal).toBeUndefined();
  });
});

/**
 * Whose money paid, in a household that has more than one person's.
 *
 * With two people there are two of every kind of account, so a row reading "Cash savings $900" is
 * the same sentence whether a partner covered their own share, the household drew on its shared
 * pot, or one partner quietly paid the other's bill. The last of those is the household's most
 * consequential funding fact and it was completely invisible — and it is not recoverable from the
 * amounts, because an assisted payment and a self-funded one look identical once the owner is
 * dropped from both.
 */
describe("buildFundingAttribution — whose money paid", () => {
  const NAMING = {
    accountLabels: new Map([
      ["savings", "Alex’s cash savings"],
      ["savings-p2", "Blake’s cash savings"],
    ]),
    accountOwners: new Map([
      ["savings", "p1"],
      ["savings-p2", "p2"],
    ]),
    personNames: new Map([
      ["p1", "Alex"],
      ["p2", "Blake"],
    ]),
  };

  /** One person-owned obligation — Blake's car loan — paid from `from`. */
  const carLoanPaidFrom = (from: string): ResolvedFunding[] => [
    {
      obligationId: "debt:loan-1",
      sourceId: "loan-1",
      month: 12,
      requestedCents: 40_000,
      fundedCents: 40_000,
      shortfallCents: 0,
      sources: [{ kind: "account", sourceId: from, amountCents: 40_000 }],
    },
  ];

  const CAR_LOAN = [
    { id: "debt:loan-1", label: "Auto loan payment", ownerId: "p2" },
  ] as unknown as FinancialObligation[];

  it("names the owner of the account the money came from", () => {
    const rows = buildFundingAttribution(carLoanPaidFrom("savings-p2"), CAR_LOAN, NAMING);
    expect(rows[0].sources[0].label).toBe("Blake’s cash savings");
  });

  it("says nothing extra when a person covers their own obligation", () => {
    const rows = buildFundingAttribution(carLoanPaidFrom("savings-p2"), CAR_LOAN, NAMING);
    expect(rows[0].sources[0].onBehalfOf).toBeUndefined();
  });

  it("names who is being helped when the money came from the other partner", () => {
    // Blake's own savings ran dry, so Alex's covered the rest — help, not a shared pot.
    const rows = buildFundingAttribution(carLoanPaidFrom("savings"), CAR_LOAN, NAMING);
    expect(rows[0].sources[0].label).toBe("Alex’s cash savings");
    expect(rows[0].sources[0].onBehalfOf).toBe("Blake");
  });

  it("shows the handover within one obligation, own money first then the partner's", () => {
    const rows = buildFundingAttribution(
      [
        {
          ...carLoanPaidFrom("savings-p2")[0],
          sources: [
            { kind: "account", sourceId: "savings-p2", amountCents: 10_000 },
            { kind: "account", sourceId: "savings", amountCents: 30_000 },
          ],
        },
      ],
      CAR_LOAN,
      NAMING,
    );
    expect(rows[0].sources.map((s) => s.onBehalfOf)).toEqual([undefined, "Blake"]);
  });

  it("calls nothing assistance when the obligation is the household's own", () => {
    // A shared credit card belongs to everyone, so no account can be paying it for somebody else.
    const shared = [
      { id: "debt:card", label: "Credit card payment", ownerId: "household" },
    ] as unknown as FinancialObligation[];
    const rows = buildFundingAttribution(
      [{ ...carLoanPaidFrom("savings")[0], obligationId: "debt:card", sourceId: "card" }],
      shared,
      NAMING,
    );
    expect(rows[0].sources[0].onBehalfOf).toBeUndefined();
  });

  it("leaves income and credit alone — neither has an owner to compare", () => {
    const rows = buildFundingAttribution(
      [
        {
          ...carLoanPaidFrom("savings")[0],
          sources: [
            { kind: "income", sourceId: "income", amountCents: 20_000 },
            { kind: "credit", sourceId: "credit", amountCents: 20_000 },
          ],
        },
      ],
      CAR_LOAN,
      NAMING,
    );
    expect(rows[0].sources.map((s) => s.onBehalfOf)).toEqual([undefined, undefined]);
    expect(rows[0].sources.map((s) => s.label)).toEqual(["Income", "Credit"]);
  });

  it("reads exactly as it always did for a household of one", () => {
    // Nothing to disambiguate, so nothing is added: no possessive, and no assistance to report.
    const solo = [
      { id: "debt:loan-1", label: "Auto loan payment", ownerId: "p1" },
    ] as unknown as FinancialObligation[];
    const rows = buildFundingAttribution(carLoanPaidFrom("savings"), solo, {
      accountLabels: new Map([["savings", "Cash savings"]]),
      accountOwners: new Map([["savings", "p1"]]),
      personNames: new Map([["p1", "Alex"]]),
    });
    expect(rows[0].sources[0].label).toBe("Cash savings");
    expect(rows[0].sources[0].onBehalfOf).toBeUndefined();
  });
});
