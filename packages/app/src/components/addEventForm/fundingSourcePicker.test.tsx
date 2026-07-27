/**
 * @vitest-environment jsdom
 *
 * The ordered funding-source picker (#156) — the interaction the static render can't show:
 * that the ORDER the user checks accounts in is the drain order the event records, and that
 * the coverage line tracks the selection live.
 *
 * Driven through the real home-purchase form (not the picker in isolation) so these pin the
 * whole path a user takes: pick accounts → the form states what they cover → submit records
 * exactly that ordered list on the event the engine will gate.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  emptyLedger,
  interpretLedger,
  replayLedger,
  createProjectionBase,
  fundingLookup,
  nullJurisdiction,
  type NewLifeEvent,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { HomePurchaseForm } from "./homePurchaseForm";

afterEach(cleanup);

/** The form at `month`, wired to the engine exactly as the app wires it. */
function renderForm(month: number) {
  const onAdd = vi.fn();
  const base = createProjectionBase(PLAN_DEFAULTS, {
    jurisdiction: usJurisdiction,
    startYear: START_YEAR,
  });
  render(
    <HomePurchaseForm
      defaultMonth={month}
      nextId={0}
      horizonMonths={660}
      onAdd={onAdd}
      household={interpretLedger(emptyLedger, base)}
      series={replayLedger(emptyLedger, base, nullJurisdiction)}
      funding={fundingLookup(emptyLedger, base, usJurisdiction)}
    />,
  );
  return { onAdd };
}

/** The purchase the form submitted, narrowed off the event union (no cast needed). */
function submittedPurchase(onAdd: ReturnType<typeof vi.fn>) {
  const event: NewLifeEvent = onAdd.mock.calls[0][0];
  if (event.type !== "HomePurchaseEvent") throw new Error(`submitted a ${event.type}`);
  return event;
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name });
const addEvent = () => fireEvent.click(screen.getByRole("button", { name: /add event/i }));

// Month 120 of the default plan: all three liquid accounts hold something — the brokerage
// home fund (~$46.9k, the largest, and appreciated so selling it is TAXED), the cash
// emergency fund (~$16.1k), and cash savings (~$11.0k). Together they clear the $60,000
// down payment; the home fund alone does not.
const MONTH = 120;

describe("down-payment source picker", () => {
  it("records the accounts in the ORDER they were picked, not display order", () => {
    const { onAdd } = renderForm(MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default pick
    // Pick bottom-up: the drain order is the CLICK order, so cash savings must come first
    // even though the emergency fund is listed above it.
    fireEvent.click(box(/Cash savings/));
    fireEvent.click(box(/Emergency fund/));
    addEvent();

    expect(submittedPurchase(onAdd).downPaymentSourceIds).toEqual(["savings", "goal-emergency"]);
  });

  it("defaults to the largest single account, so the form works untouched", () => {
    const { onAdd } = renderForm(MONTH);
    addEvent();
    // Whatever holds the most at that month — the engine orders the pool, not the form.
    expect(submittedPurchase(onAdd).downPaymentSourceIds).toEqual(["goal-home"]);
  });

  it("asks for at least one account when everything is deselected", () => {
    renderForm(MONTH);
    fireEvent.click(box(/Home down payment/)); // the default pick, off again
    expect(screen.getByText(/choose at least one account/i)).toBeDefined();
  });

  it("updates the coverage line as accounts are added to the selection", () => {
    renderForm(MONTH);
    // The largest account alone falls short of the $60,000 down payment…
    expect(screen.getByText(/short of the/i).textContent).toMatch(
      /\$[\d,]+ short of the \$60,000 needed/,
    );
    // …and adding the household's other liquid money covers it.
    fireEvent.click(box(/Emergency fund/));
    fireEvent.click(box(/Cash savings/));
    expect(screen.getByText(/covers the \$60,000 needed/i)).toBeDefined();
  });

  it("names the capital-gains tax that selling the investment account costs", () => {
    // The home fund is a taxable brokerage: part of what it holds goes to tax, not to the
    // house. The line says so with the amount — the whole reason a balance and an
    // "available" can differ, and exactly the wedge the §4.5 gate blocks on.
    renderForm(MONTH);
    fireEvent.click(box(/Emergency fund/));
    fireEvent.click(box(/Cash savings/));
    expect(screen.getByText(/capital-gains tax/i).textContent).toMatch(
      /after \$[\d,]+ of capital-gains tax/,
    );
  });
});
