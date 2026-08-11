/**
 * @vitest-environment node
 *
 * One-Time Spend authoring form. Rendered through the server renderer — these assert on markup,
 * not interaction; the arithmetic (`fundingLookup`) is unit-tested in the engine. These pin two
 * things the app layer owns:
 *  - the funding-source picker reads the SAME projected, sequence-aware balances a second spend
 *    would actually draw against — a prior spend already authored in the same plan leaves the
 *    account it drained showing $0, not its original balance;
 *  - `Add event` / `Save changes` is disabled while the selected sources cannot fully cover the
 *    amount, and re-enables once they can.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents, Projection, type Ledger, type Plan } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { stateOf, readerOf } from "../../testing/projectionHarness";
import { OneTimeSpendForm } from "./oneTimeSpendForm";

const noop = () => {};

/** The plan's own "Cash savings" account id, resolved off the pool rather than hardcoded. */
function savingsId(plan: Plan, ledger?: Ledger): string {
  const source = readerOf(plan, ledger)
    .funding()
    .sourcesAt(0, "expense")
    .find((s) => s.label === "Cash savings");
  if (source === undefined) throw new Error("expected a Cash savings account in the fixture plan");
  return source.id;
}

/** A ledger carrying one already-authored One-Time Spend, for the "sequential spend" fixtures. */
function ledgerWithPriorSpend(plan: Plan, amountDollars: number, month = 0): Ledger {
  const p = Projection.fromState(stateOf(plan), usJurisdiction);
  p.spendOnce({
    month,
    label: "Earlier spend",
    amountCents: dollarsToCents(amountDollars),
    fundingSourceIds: [savingsId(plan)],
  });
  return p.ledger;
}

function renderAdd(plan: Plan, ledger?: Ledger, month = 0) {
  return renderToStaticMarkup(
    <OneTimeSpendForm
      defaultMonth={month}
      horizonMonths={660}
      onAdd={noop}
      funding={readerOf(plan, ledger).funding()}
    />,
  );
}

describe("OneTimeSpendForm — funding availability reflects prior spends", () => {
  it("shows a source at its original balance with no prior spend in the plan", () => {
    const html = renderAdd(PLAN_DEFAULTS);
    expect(html).toContain("Cash savings");
    expect(html).toContain("$10,000");
  });

  it("shows $0 for a source an earlier same-month spend already fully drained", () => {
    const ledger = ledgerWithPriorSpend(PLAN_DEFAULTS, 10_000, 0);
    const html = renderAdd(PLAN_DEFAULTS, ledger, 0);
    expect(html).toContain("Cash savings");
    // The row is present (still listed) but reads $0 — never the original $10,000.
    expect(html).not.toContain("$10,000");
    expect(html).toContain("$0");
  });

  it("shows the REMAINING balance after a partial prior spend, not the original", () => {
    const ledger = ledgerWithPriorSpend(PLAN_DEFAULTS, 4_000, 0);
    const html = renderAdd(PLAN_DEFAULTS, ledger, 0);
    expect(html).toContain("$6,000");
    expect(html).not.toContain("$10,000");
  });

  it("respects same-month event order for a second candidate priced after two prior spends", () => {
    const p = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    const id = savingsId(PLAN_DEFAULTS);
    p.spendOnce({ month: 0, label: "First", amountCents: dollarsToCents(4_000), fundingSourceIds: [id] });
    p.spendOnce({ month: 0, label: "Second", amountCents: dollarsToCents(5_000), fundingSourceIds: [id] });
    const html = renderAdd(PLAN_DEFAULTS, p.ledger, 0);
    // $10,000 − $4,000 − $5,000 = $1,000 left for a third spend to see.
    expect(html).toContain("$1,000");
  });
});

describe("OneTimeSpendForm — Add is blocked until the selection fully covers the amount", () => {
  it("disables Add event by default — no source is selected yet", () => {
    const html = renderAdd(PLAN_DEFAULTS);
    const button = html.match(/<button[^>]*>Add event<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain("disabled");
  });

  it("disables Save changes while the selected source cannot fully cover the amount, and states the shortfall", () => {
    const ledger = ledgerWithPriorSpend(PLAN_DEFAULTS, 4_000, 0); // Cash savings now holds $6,000
    const id = savingsId(PLAN_DEFAULTS, ledger);
    const html = renderToStaticMarkup(
      <OneTimeSpendForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={noop}
        funding={readerOf(PLAN_DEFAULTS, ledger).funding()}
        edit={{
          event: {
            id: "spend-x",
            type: "OneTimeSpendEvent",
            month: 0,
            sequenceNumber: 0,
            label: "Too much",
            amountCents: dollarsToCents(9_000), // only $6,000 remains
            fundingSourceIds: [id],
          },
          onRevise: noop,
        }}
      />,
    );
    const button = html.match(/<button[^>]*>Save changes<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain("disabled");
    expect(html).toContain("short");
    expect(html).toContain("$3,000");
  });

  it("enables Save changes once the selected source fully covers the amount", () => {
    const ledger = ledgerWithPriorSpend(PLAN_DEFAULTS, 4_000, 0); // Cash savings now holds $6,000
    const id = savingsId(PLAN_DEFAULTS, ledger);
    const html = renderToStaticMarkup(
      <OneTimeSpendForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={noop}
        funding={readerOf(PLAN_DEFAULTS, ledger).funding()}
        edit={{
          event: {
            id: "spend-x",
            type: "OneTimeSpendEvent",
            month: 0,
            sequenceNumber: 0,
            label: "Fits",
            amountCents: dollarsToCents(6_000), // exactly what remains
            fundingSourceIds: [id],
          },
          onRevise: noop,
        }}
      />,
    );
    const button = html.match(/<button[^>]*>Save changes<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });
});

describe("OneTimeSpendForm — editing an existing spend does not count its own draw against itself", () => {
  it("an existing $10k spend funded from $10k cash shows the full $10k available, and saving it unchanged is allowed", () => {
    const p = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    const id = savingsId(PLAN_DEFAULTS);
    const spendId = p.spendOnce({
      month: 0,
      label: "Existing spend",
      amountCents: dollarsToCents(10_000),
      fundingSourceIds: [id],
    });
    const html = renderToStaticMarkup(
      <OneTimeSpendForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={noop}
        funding={readerOf(PLAN_DEFAULTS, p.ledger).funding(spendId)}
        edit={{
          event: {
            id: spendId,
            type: "OneTimeSpendEvent",
            month: 0,
            sequenceNumber: 0,
            label: "Existing spend",
            amountCents: dollarsToCents(10_000),
            fundingSourceIds: [id],
          },
          onRevise: noop,
        }}
      />,
    );
    // Never $0 — the spend's own $10k draw must not count against its own picker.
    expect(html).toContain("$10,000");
    const button = html.match(/<button[^>]*>Save changes<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });

  it("raising that same spend's amount past what's actually available disables Save", () => {
    const p = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    const id = savingsId(PLAN_DEFAULTS);
    const spendId = p.spendOnce({
      month: 0,
      label: "Existing spend",
      amountCents: dollarsToCents(10_000),
      fundingSourceIds: [id],
    });
    const html = renderToStaticMarkup(
      <OneTimeSpendForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={noop}
        funding={readerOf(PLAN_DEFAULTS, p.ledger).funding(spendId)}
        edit={{
          event: {
            id: spendId,
            type: "OneTimeSpendEvent",
            month: 0,
            sequenceNumber: 0,
            label: "Existing spend",
            amountCents: dollarsToCents(11_000), // above the $10k cash actually holds
            fundingSourceIds: [id],
          },
          onRevise: noop,
        }}
      />,
    );
    const button = html.match(/<button[^>]*>Save changes<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain("disabled");
  });
});
