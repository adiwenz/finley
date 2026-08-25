/**
 * The per-person funding breakdown, as arithmetic — the rules the panel renders.
 *
 * Two invariants carry the whole file. Every row adds up: a person's share is exactly what their
 * income, their own accounts, a partner's help, the card and the residue come to, so no figure can
 * quietly go missing into another. And no account is ever attributed to somebody who does not own
 * it — the fix this view exists for, stated as a property rather than as one scenario.
 */

import { describe, it, expect } from "vitest";
import { buildPersonFunding, fundingPeopleAt, isPartneredMonth } from "./personFundingView";
import { automaticFundingRecords } from "./personFundingView";
import type { FinancialObligation, ResolvedFunding } from "@finley/engine";

const naming = {
  accountLabels: new Map([
    ["alex-savings", "Alex’s cash savings"],
    ["blake-savings", "Blake’s cash savings"],
  ]),
  accountOwners: new Map([
    ["alex-savings", "alex"],
    ["blake-savings", "blake"],
  ]),
  personNames: new Map([
    ["alex", "Alex"],
    ["blake", "Blake"],
  ]),
};

/** One automatic obligation, which is all this view needs off the obligation list. */
const rent = {
  id: "line:rent",
  sourceId: "rent",
  month: 0,
  amountCents: 540_000,
  treatment: "expense",
  funding: { kind: "automatic" },
  priority: 0,
  sourceKind: "budget",
  editable: true,
  label: "Housing",
  category: "needs",
} as unknown as FinancialObligation;

/** The month's attribution record for `rent`, funded by the sources named. */
function funded(
  sources: readonly { kind: "income" | "account" | "credit"; sourceId: string; amountCents: number }[],
): ResolvedFunding[] {
  const fundedCents = sources.reduce((sum, s) => sum + s.amountCents, 0);
  return [
    {
      obligationId: rent.id,
      sourceId: rent.sourceId,
      month: 0,
      requestedCents: rent.amountCents,
      fundedCents,
      shortfallCents: rent.amountCents - fundedCents,
      sources,
    },
  ];
}

/** A 50/50 month: each owes $2,700, and `over` says what each one's income reached. */
const figures = (alexIncome: number, blakeIncome: number, netCashFlow = { alex: 0, blake: 0 }) => ({
  obligationChargedByPersonCents: { alex: 270_000, blake: 270_000 },
  obligationFundedByPersonCents: { alex: alexIncome, blake: blakeIncome },
  netCashFlowByPersonCents: { alex: netCashFlow.alex, blake: netCashFlow.blake },
});

/** Everything a row says covered its share — the sum that has to equal the share. */
const coveredCents = (row: ReturnType<typeof buildPersonFunding>["rows"][number]): number =>
  row.fromIncomeCents +
  row.fromOwnAccounts.reduce((sum, d) => sum + d.amountCents, 0) +
  row.assistance.reduce((sum, a) => sum + a.amountCents, 0) +
  row.onCreditCents +
  row.fromUnattributedCents +
  row.shortfallCents;

describe("who the month was about", () => {
  it("leaves out a member the household does not have this month", () => {
    // Every per-person map carries a key for every member the plan EVER had, zeroed while they
    // are absent — a departed partner would otherwise keep a row of zeroes forever.
    const view = fundingPeopleAt({
      obligationChargedByPersonCents: { alex: 270_000, blake: 0 },
      obligationFundedByPersonCents: { alex: 270_000, blake: 0 },
      netCashFlowByPersonCents: { alex: 100_000, blake: 0 },
    });
    expect(view).toEqual(["alex"]);
  });

  it("counts a person with no share but income of their own as here", () => {
    // A 100/0 split assigns one partner nothing. They are still in the household, and a view that
    // dropped them would report the month as a household of one.
    expect(
      isPartneredMonth({
        obligationChargedByPersonCents: { alex: 540_000, blake: 0 },
        obligationFundedByPersonCents: { alex: 400_000, blake: 0 },
        netCashFlowByPersonCents: { alex: -140_000, blake: 120_000 },
      }),
    ).toBe(true);
  });
});

describe("what covered each person's share", () => {
  it("attributes a draw to the account's own owner, never to the other partner", () => {
    // Alex's pay covers Alex's share; Blake is $590 short and Blake's savings close it.
    const view = buildPersonFunding(
      figures(270_000, 211_000),
      funded([
        { kind: "income", sourceId: "income", amountCents: 481_000 },
        { kind: "account", sourceId: "blake-savings", amountCents: 59_000 },
      ]),
      [rent],
      naming,
    );
    const [alex, blake] = view.rows;

    expect(alex!.fromOwnAccounts).toEqual([]);
    expect(alex!.assistance).toEqual([]);
    expect(blake!.fromOwnAccounts).toEqual([
      { accountId: "blake-savings", label: "Blake’s cash savings", amountCents: 59_000 },
    ]);
    expect(blake!.assistance).toEqual([]);
    for (const row of view.rows) expect(coveredCents(row)).toBe(row.shareCents);
  });

  it("calls the other partner's money assistance once the short one's accounts are empty", () => {
    // Blake is $590 short with only $200 of their own left, so $390 of Alex's covers the rest.
    // Blake is still charged the full $2,700 — the split does not move because somebody helped.
    const view = buildPersonFunding(
      figures(270_000, 211_000),
      funded([
        { kind: "income", sourceId: "income", amountCents: 481_000 },
        { kind: "account", sourceId: "blake-savings", amountCents: 20_000 },
        { kind: "account", sourceId: "alex-savings", amountCents: 39_000 },
      ]),
      [rent],
      naming,
    );
    const blake = view.rows.find((r) => r.personId === "blake")!;

    expect(blake.shareCents).toBe(270_000);
    expect(blake.fromOwnAccounts).toEqual([
      { accountId: "blake-savings", label: "Blake’s cash savings", amountCents: 20_000 },
    ]);
    expect(blake.assistance).toEqual([{ fromPersonId: "alex", fromName: "Alex", amountCents: 39_000 }]);
    // And the helper's own row is not charged for it: they covered their own share from income
    // and lent the rest, which is a different fact from owing more.
    const alex = view.rows.find((r) => r.personId === "alex")!;
    expect(alex.shareCents).toBe(270_000);
    expect(alex.fromIncomeCents).toBe(270_000);
    for (const row of view.rows) expect(coveredCents(row)).toBe(row.shareCents);
  });

  it("divides the card across the shares still open, and keeps what nothing reached as a shortfall", () => {
    // No accounts at all: $1,000 of the $4,400 gap goes on credit and the remaining $3,400 is not
    // covered by anything. Reporting that as income would say money arrived that never did.
    const view = buildPersonFunding(
      figures(50_000, 50_000),
      funded([
        { kind: "income", sourceId: "income", amountCents: 100_000 },
        { kind: "credit", sourceId: "credit", amountCents: 100_000 },
      ]),
      [rent],
      naming,
    );

    expect(view.rows.map((r) => r.onCreditCents)).toEqual([50_000, 50_000]);
    expect(view.rows.map((r) => r.shortfallCents)).toEqual([170_000, 170_000]);
    for (const row of view.rows) expect(coveredCents(row)).toBe(row.shareCents);
  });

  it("ignores a draw the user funded explicitly — those named their own accounts", () => {
    // A one-time spend is authored funding, not a reading of a pool, and it is charged to nobody's
    // share. Folding it in here would inflate whoever happens to own the account it named.
    const explicit = {
      obligationId: "draw:downpayment:home-1",
      sourceId: "downpayment",
      month: 0,
      requestedCents: 500_000,
      fundedCents: 500_000,
      shortfallCents: 0,
      sources: [{ kind: "account" as const, sourceId: "alex-savings", amountCents: 500_000 }],
    };
    const records = [
      ...funded([
        { kind: "income", sourceId: "income", amountCents: 481_000 },
        { kind: "account", sourceId: "blake-savings", amountCents: 59_000 },
      ]),
      explicit,
    ];

    expect(automaticFundingRecords(records, [rent]).map((r) => r.obligationId)).toEqual([rent.id]);
    const view = buildPersonFunding(figures(270_000, 211_000), records, [rent], naming);
    const alex = view.rows.find((r) => r.personId === "alex")!;
    expect(alex.fromOwnAccounts).toEqual([]);
    for (const row of view.rows) expect(coveredCents(row)).toBe(row.shareCents);
  });

  it("places money from an account it cannot name an owner for without guessing at one", () => {
    // Not expected — the panel only ever sees accounts the roster carries — but the failure mode
    // matters: dropping the draw would report $590 the month genuinely spent as uncovered, and
    // attributing it would put a name on money this view cannot place.
    const view = buildPersonFunding(
      figures(270_000, 211_000),
      funded([
        { kind: "income", sourceId: "income", amountCents: 481_000 },
        { kind: "account", sourceId: "orphan-account", amountCents: 59_000 },
      ]),
      [rent],
      naming,
    );
    const blake = view.rows.find((r) => r.personId === "blake")!;
    expect(blake.fromUnattributedCents).toBe(59_000);
    expect(blake.shortfallCents).toBe(0);
    expect(blake.fromOwnAccounts).toEqual([]);
    expect(blake.assistance).toEqual([]);
    for (const row of view.rows) expect(coveredCents(row)).toBe(row.shareCents);
  });

  it("reports what the month left each person, without spending it on anything", () => {
    // A surplus is not a funding source; it is what funding did not consume, and it sits outside
    // the arithmetic above so a row that adds up keeps adding up.
    const view = buildPersonFunding(
      figures(270_000, 211_000, { alex: 130_000, blake: -59_000 }),
      funded([
        { kind: "income", sourceId: "income", amountCents: 481_000 },
        { kind: "account", sourceId: "blake-savings", amountCents: 59_000 },
      ]),
      [rent],
      naming,
    );
    expect(view.rows.find((r) => r.personId === "alex")!.leftOverCents).toBe(130_000);
    expect(view.rows.find((r) => r.personId === "blake")!.leftOverCents).toBe(-59_000);
    expect(view.totalCents).toBe(540_000);
  });
});
