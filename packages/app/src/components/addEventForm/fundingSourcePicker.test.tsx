/**
 * @vitest-environment jsdom
 *
 * The ordered funding-source picker: the ORDER accounts are checked in is the drain order the
 * event records, and the coverage line tracks the selection live.
 *
 * Driven through the real home-purchase form, not the picker in isolation, so these pin the
 * whole path: pick accounts → the form states what they cover → submit records exactly that
 * ordered list on the event the engine will gate.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  emptyLedger,
  createProjectionBase,
  fundingLookup,
  goalFundAccountId,
  type BuyHomeInput,
  type Projection,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { HomePurchaseForm } from "./homePurchaseForm";
import { runOf } from "../../testing/projectionHarness";

afterEach(cleanup);

/** The form at `month`, wired to the engine exactly as the app wires it. */
function renderForm(month: number) {
  // The form writes through the facade; the stub captures the `buyHome` input the thunk builds.
  const buyHome = vi.fn();
  const onAdd = (write: (p: Projection) => void) => write({ buyHome } as unknown as Projection);
  const base = createProjectionBase(PLAN_DEFAULTS, {
    jurisdiction: usJurisdiction,
    startYear: START_YEAR,
  });
  render(
    <HomePurchaseForm
      defaultMonth={month}
      horizonMonths={660}
      onAdd={onAdd}
      result={runOf(PLAN_DEFAULTS)}
      funding={fundingLookup(emptyLedger, base, usJurisdiction)}
    />,
  );
  return { buyHome };
}

function submittedPurchase(buyHome: ReturnType<typeof vi.fn>): BuyHomeInput {
  return buyHome.mock.calls[0][0] as BuyHomeInput;
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name });
const addEvent = () => fireEvent.click(screen.getByRole("button", { name: /add event/i }));
/** The "When" picker is the form's only select. */
const setMonth = (month: number) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value: String(month) } });
const row = (name: RegExp) => box(name).closest("label")!;

// Month 120 of the default plan: all three liquid accounts hold something — the brokerage
// home fund (~$46.9k, the largest, appreciated so selling it is TAXED), the cash emergency
// fund (~$16.1k), and cash savings (~$11.0k). Together they clear the $60,000 down payment;
// the home fund alone does not.
const MONTH = 120;

/** A default goal's derived fund-account id, keyed by the goal's minted id — never a literal. */
const fundAccountFor = (goalName: string) =>
  goalFundAccountId(PLAN_DEFAULTS.goals.find((g) => g.name === goalName)!);
const EMERGENCY_FUND = fundAccountFor("Emergency fund");
const HOME_FUND = fundAccountFor("Home down payment");

describe("down-payment source picker", () => {
  it("records the accounts in the ORDER they were picked, not display order", () => {
    const { buyHome } = renderForm(MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default pick
    // Pick bottom-up: drain order is CLICK order, so cash savings comes first even though
    // the emergency fund is listed above it.
    fireEvent.click(box(/Cash savings/));
    fireEvent.click(box(/Emergency fund/));
    addEvent();

    expect(submittedPurchase(buyHome).downPaymentSourceIds).toEqual(["savings", EMERGENCY_FUND]);
  });

  it("defaults to the largest single account, so the form works untouched", () => {
    const { buyHome } = renderForm(MONTH);
    addEvent();
    // Whatever holds the most at that month — the engine orders the pool, not the form.
    expect(submittedPurchase(buyHome).downPaymentSourceIds).toEqual([HOME_FUND]);
  });

  it("asks for at least one account when everything is deselected", () => {
    renderForm(MONTH);
    fireEvent.click(box(/Home down payment/)); // the default pick, off again
    expect(screen.getByText(/choose at least one account/i)).toBeDefined();
  });

  it("updates the coverage line as accounts are added to the selection", () => {
    renderForm(MONTH);
    expect(screen.getByText(/short of the/i).textContent).toMatch(
      /\$[\d,]+ short of the \$60,000 needed/,
    );
    fireEvent.click(box(/Emergency fund/));
    fireEvent.click(box(/Cash savings/));
    expect(screen.getByText(/covers the \$60,000 needed/i)).toBeDefined();
  });

  it("names the capital-gains tax that selling the investment account costs", () => {
    // The home fund is a taxable brokerage: part of what it holds goes to tax, not the
    // house. That wedge is why balance and "available" differ, and what §4.5 gates on.
    renderForm(MONTH);
    fireEvent.click(box(/Emergency fund/));
    fireEvent.click(box(/Cash savings/));
    expect(screen.getByText(/capital-gains tax/i).textContent).toMatch(
      /after \$[\d,]+ of capital-gains tax/,
    );
  });
});

// A selected account that empties under a month change.
//
// Listing only accounts that hold something makes a drained pick's row DISAPPEAR while its id
// stays in the draft: nothing looks selected, yet the coverage line and submitted event still
// count it. So an emptied account stays listed at $0 — greyed, disabled — and is dropped from
// the selection; what is on screen is what the event carries.
//
// Default plan, months 360 → 420: cash savings holds ~$160,632 at 360 (a flow-month higher
// than before now that month 0 is processed) and is drained to exactly $0 by 420 (retirement
// decumulation), while the home and emergency funds still hold money — so a drained account is
// distinguishable from an empty plan.
const FUNDED_MONTH = 360;
const DRAINED_MONTH = 420;

describe("down-payment source picker — an account that empties at a later month", () => {
  it("keeps the drained account listed at $0, greyed out and unpickable", () => {
    renderForm(FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/)); // pick it while it still holds ~$160,632
    expect(box(/Cash savings/).getAttribute("aria-label")).toMatch(/\$160,632 available/);

    setMonth(DRAINED_MONTH);

    const savings = box(/Cash savings/);
    expect(savings).toBeDefined();
    expect((savings as HTMLInputElement).disabled).toBe(true);
    expect(row(/Cash savings/).textContent).toContain("$0");
  });

  it("deselects it, and does not pick a replacement in its place", () => {
    renderForm(FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/)); // selection: the default home fund, then savings
    setMonth(DRAINED_MONTH);

    expect((box(/Cash savings/) as HTMLInputElement).checked).toBe(false);
    expect((box(/Home down payment/) as HTMLInputElement).checked).toBe(true);
    expect((box(/Emergency fund/) as HTMLInputElement).checked).toBe(false);
  });

  it("drops it from the draft, so returning to the funded month does not resurrect it", () => {
    renderForm(FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/));
    setMonth(DRAINED_MONTH);
    setMonth(FUNDED_MONTH);

    expect((box(/Cash savings/) as HTMLInputElement).disabled).toBe(false);
    expect((box(/Cash savings/) as HTMLInputElement).checked).toBe(false);
  });

  it("stops counting it in the coverage line", () => {
    renderForm(FUNDED_MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default, leaving savings alone to pay
    fireEvent.click(box(/Cash savings/));
    // $160,244.24 of cash covers the $60,000 down payment outright, untaxed.
    expect(screen.getByText(/covers the \$60,000 needed/i)).toBeDefined();

    setMonth(DRAINED_MONTH);

    expect(screen.queryByText(/covers the \$60,000 needed/i)).toBeNull();
    expect(screen.getByText(/choose at least one account/i)).toBeDefined();
  });

  it("leaves it off the submitted event", () => {
    const { buyHome } = renderForm(FUNDED_MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default
    fireEvent.click(box(/Cash savings/));
    setMonth(DRAINED_MONTH);
    fireEvent.click(box(/Emergency fund/)); // a fresh, valid pick at the new month
    addEvent();

    // The drained id must not ride along to the engine, where it would be silently worth $0
    // against the §4.5 gate.
    expect(submittedPurchase(buyHome).downPaymentSourceIds).toEqual([EMERGENCY_FUND]);
  });

  it("lists every account at $0 when none of them holds anything, and picks no default", () => {
    // Month 480: all three funding accounts are spent to zero. Hiding empty accounts would
    // render this as "no accounts at all" — a different situation.
    renderForm(480);
    for (const name of [/Cash savings/, /Emergency fund/, /Home down payment/]) {
      expect((box(name) as HTMLInputElement).disabled).toBe(true);
      expect((box(name) as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.getByText(/no account holds anything at that month/i)).toBeDefined();
  });
});
