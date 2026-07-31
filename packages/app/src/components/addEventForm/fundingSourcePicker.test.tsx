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
import { dollarsToCents, type BuyHomeInput, type Plan, type Projection } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { setJobMonthlyIncome } from "../../testing/planFixtures";
import { HomePurchaseForm } from "./homePurchaseForm";
import { readerOf, runOf } from "../../testing/projectionHarness";

afterEach(cleanup);

// Employee FICA (added on this branch) charges 7.65% off every wage, and the default plan's
// single $5,000/mo job now saves almost nothing: its goal funds and cash all sit at ~$0 through
// working life, so `PLAN_DEFAULTS` no longer builds the multi-account pool this picker exists to
// choose among. These tests therefore each drive a MINIMAL variant of the default plan — the same
// plan with ONE lever moved, its monthly salary — tuned so the projection genuinely accumulates
// (and, for the drain tests, decumulates). Two variants, because no single salary does both: a
// plan rich enough to build a working-year pool never fully spends down in retirement. Every
// balance asserted below is read straight off the projection, never invented.
const JOB_ID = PLAN_DEFAULTS.jobs[0].id;

/** The form for `plan` at `month`, wired to the engine exactly as the app wires it. */
function renderForm(plan: Plan, month: number) {
  // The form writes through the facade; the stub captures the `buyHome` input the thunk builds.
  const buyHome = vi.fn();
  const onAdd = (write: (p: Projection) => void) => write({ buyHome } as unknown as Projection);
  render(
    <HomePurchaseForm
      defaultMonth={month}
      horizonMonths={660}
      onAdd={onAdd}
      result={runOf(plan)}
      // The facade funding read — the SAME pool/§4.5 answer the app wires and the engine gates on.
      funding={readerOf(plan).funding()}
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

// The working-year pool: a $6,500/mo salary funds the goals partway through accumulation. At
// month 48 all three liquid accounts hold something — the brokerage home fund ($44,669, the
// largest, appreciated so selling it is TAXED), the cash emergency fund ($15,327), and cash
// savings ($12,268). The home fund has NOT yet reached the $60,000 target, so on its own it
// nets only ~$43,925 after capital-gains tax and cannot cover the down payment; the three
// accounts clear the $60,000 only together.
const POOL_PLAN = setJobMonthlyIncome(PLAN_DEFAULTS, JOB_ID, dollarsToCents(6500));
const MONTH = 48;

// A goal's derived fund-account id, read off the facade's account descriptors by the goal's
// name — never a literal, and never the internal `goalFundAccountId`. Ids are minted from the
// input shape, which the salary lever does not touch, so they match across every variant.
const DESCRIPTORS = readerOf(POOL_PLAN).accountDescriptors();
const fundAccountFor = (goalName: string) =>
  DESCRIPTORS.find((d) => d.kind === "goal" && d.label === goalName)!.id;
const EMERGENCY_FUND = fundAccountFor("Emergency fund");
const HOME_FUND = fundAccountFor("Home down payment");

describe("down-payment source picker", () => {
  it("records the accounts in the ORDER they were picked, not display order", () => {
    const { buyHome } = renderForm(POOL_PLAN, MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default pick
    // Pick bottom-up: drain order is CLICK order, so cash savings comes first even though
    // the emergency fund is listed above it.
    fireEvent.click(box(/Cash savings/));
    fireEvent.click(box(/Emergency fund/));
    addEvent();

    expect(submittedPurchase(buyHome).downPaymentSourceIds).toEqual(["savings", EMERGENCY_FUND]);
  });

  it("defaults to the largest single account, so the form works untouched", () => {
    const { buyHome } = renderForm(POOL_PLAN, MONTH);
    addEvent();
    // Whatever holds the most at that month — the engine orders the pool, not the form.
    expect(submittedPurchase(buyHome).downPaymentSourceIds).toEqual([HOME_FUND]);
  });

  it("asks for at least one account when everything is deselected", () => {
    renderForm(POOL_PLAN, MONTH);
    fireEvent.click(box(/Home down payment/)); // the default pick, off again
    expect(screen.getByText(/choose at least one account/i)).toBeDefined();
  });

  it("updates the coverage line as accounts are added to the selection", () => {
    renderForm(POOL_PLAN, MONTH);
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
    renderForm(POOL_PLAN, MONTH);
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
// The retirement drain: a $5,500/mo salary builds a pool that then fully decumulates — enough to
// fund the goals and carry six figures of cash into retirement, but not so much the plan never
// spends down. Months 360 → 420: cash savings holds $149,981 at 360 and is drained to exactly $0
// by 420 (retirement decumulation), while the home fund ($21,467) and emergency fund ($20,641)
// still hold money — so a drained account is distinguishable from an empty plan. By month 480 all
// three funding accounts are spent to $0.
const DRAIN_PLAN = setJobMonthlyIncome(PLAN_DEFAULTS, JOB_ID, dollarsToCents(5500));
const FUNDED_MONTH = 360;
const DRAINED_MONTH = 420;

describe("down-payment source picker — an account that empties at a later month", () => {
  it("keeps the drained account listed at $0, greyed out and unpickable", () => {
    renderForm(DRAIN_PLAN, FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/)); // pick it while it still holds $149,981
    expect(box(/Cash savings/).getAttribute("aria-label")).toMatch(/\$149,981 available/);

    setMonth(DRAINED_MONTH);

    const savings = box(/Cash savings/);
    expect(savings).toBeDefined();
    expect((savings as HTMLInputElement).disabled).toBe(true);
    expect(row(/Cash savings/).textContent).toContain("$0");
  });

  it("deselects it, and does not pick a replacement in its place", () => {
    renderForm(DRAIN_PLAN, FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/)); // selection: the default home fund, then savings
    setMonth(DRAINED_MONTH);

    expect((box(/Cash savings/) as HTMLInputElement).checked).toBe(false);
    expect((box(/Home down payment/) as HTMLInputElement).checked).toBe(true);
    expect((box(/Emergency fund/) as HTMLInputElement).checked).toBe(false);
  });

  it("drops it from the draft, so returning to the funded month does not resurrect it", () => {
    renderForm(DRAIN_PLAN, FUNDED_MONTH);
    fireEvent.click(box(/Cash savings/));
    setMonth(DRAINED_MONTH);
    setMonth(FUNDED_MONTH);

    expect((box(/Cash savings/) as HTMLInputElement).disabled).toBe(false);
    expect((box(/Cash savings/) as HTMLInputElement).checked).toBe(false);
  });

  it("stops counting it in the coverage line", () => {
    renderForm(DRAIN_PLAN, FUNDED_MONTH);
    fireEvent.click(box(/Home down payment/)); // drop the default, leaving savings alone to pay
    fireEvent.click(box(/Cash savings/));
    // $149,981 of cash covers the $60,000 down payment outright, untaxed.
    expect(screen.getByText(/covers the \$60,000 needed/i)).toBeDefined();

    setMonth(DRAINED_MONTH);

    expect(screen.queryByText(/covers the \$60,000 needed/i)).toBeNull();
    expect(screen.getByText(/choose at least one account/i)).toBeDefined();
  });

  it("leaves it off the submitted event", () => {
    const { buyHome } = renderForm(DRAIN_PLAN, FUNDED_MONTH);
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
    renderForm(DRAIN_PLAN, 480);
    for (const name of [/Cash savings/, /Emergency fund/, /Home down payment/]) {
      expect((box(name) as HTMLInputElement).disabled).toBe(true);
      expect((box(name) as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.getByText(/no account holds anything at that month/i)).toBeDefined();
  });
});
