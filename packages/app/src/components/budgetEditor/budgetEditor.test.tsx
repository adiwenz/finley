/**
 * @vitest-environment jsdom
 *
 * BudgetEditor tests only the editor contract: which controls exist, their bounds, and which
 * PlanPatch each interaction sends. Engine validation and the consequences of those patches are
 * tested in @finley/engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AGE_LIMITS,
  MAX_AGE,
  MAX_LIVED_AGE,
  PRIMARY_PERSON_ID,
  type Household,
  type Plan,
  type PlanAccountDescriptor,
  type ProjectionSeries,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { enterNumber } from "../../testing/numberField";
import { BudgetEditor } from "./budgetEditor";

afterEach(cleanup);

const ACCOUNTS: readonly PlanAccountDescriptor[] = [
  { id: "savings", label: "Cash savings", kind: "cash" },
  { id: "retirement", label: "Retirement", kind: "retirement" },
  { id: "brokerage", label: "Brokerage", kind: "brokerage" },
];

/** A one-member household whose three standing accounts belong to the primary. */
function mkHousehold(memberCount = 1): Household {
  return {
    memberships: Array.from({ length: memberCount }, (_, i) => ({
      person: { ...PLAN_DEFAULTS.primary, id: i === 0 ? PRIMARY_PERSON_ID : `p${i + 1}` } as any,
      startMonth: 0,
      endMonth: null,
    })),
    children: [],
    series: [],
    liabilities: [],
    properties: [],
    accounts: [
      { id: "savings", owners: [PRIMARY_PERSON_ID], balanceCents: 0, retirement: false },
      { id: "retirement", owners: [PRIMARY_PERSON_ID], balanceCents: 0, retirement: true },
      { id: "brokerage", owners: [PRIMARY_PERSON_ID], balanceCents: 0, retirement: false },
    ],
    accountTransfers: [],
    fundingDraws: [],
  };
}

/** A one-month projection series whose only moving part is each standing account's balance. */
function mkSeries(openingCentsById: Readonly<Record<string, number>>): ProjectionSeries {
  const month = {
    month: 0,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    accountBalancesCents: openingCentsById,
    accountBasisCents: {},
    liabilityBalancesCents: {},
    liabilityPaymentRecords: {},
    propertyValuesCents: {},
    isInsolvent: false,
    uncoveredCents: 0,
  };
  return {
    opening: month,
    months: [month],
    status: "ran-to-horizon",
    simulatedThroughMonth: 0,
    obligationOutcomes: {},
  };
}

function renderEditor(
  budget: Plan = PLAN_DEFAULTS,
  series: ProjectionSeries = mkSeries({ savings: 500000, retirement: 250000, brokerage: 100000 }),
  household: Household = mkHousehold(),
) {
  const updatePlan = vi.fn();
  const transact = vi.fn((write: any) => write({ updatePlan }));
  render(
    <BudgetEditor
      budget={budget}
      transact={transact as any}
      accounts={ACCOUNTS}
      series={series}
      household={household}
      personNames={new Map([[PRIMARY_PERSON_ID, "You"], ["p2", "Partner"]])}
      horizonMonths={12}
    />,
  );
  return { transact, updatePlan };
}

describe("BudgetEditor", () => {
  it("renders the standing plan controls and no duplicate health or retirement-age controls", () => {
    renderEditor();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText(/General inflation/i)).toBeTruthy();
    expect(screen.getByLabelText(/Current age/i)).toBeTruthy();
    expect(screen.getByLabelText(/Life expectancy/i)).toBeTruthy();
    expect(screen.getByLabelText(/Social Security claiming age/i)).toBeTruthy();
    expect(screen.getByLabelText(/Cash opening balance/i)).toBeTruthy();
    expect(screen.getByLabelText(/Retirement opening balance/i)).toBeTruthy();
    expect(screen.getByLabelText(/Brokerage opening balance/i)).toBeTruthy();
    expect(screen.queryByLabelText(/health/i)).toBeNull();
    expect(screen.queryByLabelText(/Retirement age/i)).toBeNull();
  });

  it("publishes the UI bounds from the engine constants", () => {
    renderEditor();
    const currentAge = screen.getByLabelText(/Current age/i) as HTMLInputElement;
    const expectancy = screen.getByLabelText(/Life expectancy/i) as HTMLInputElement;
    const claiming = screen.getByLabelText(/Social Security claiming age/i) as HTMLInputElement;

    expect(Number(currentAge.max)).toBe(
      Math.min(MAX_LIVED_AGE, PLAN_DEFAULTS.primary.lifeExpectancy - 1),
    );
    expect(Number(expectancy.min)).toBe(START_YEAR - PLAN_DEFAULTS.primary.birthYear + 1);
    expect(Number(expectancy.max)).toBe(MAX_AGE);
    expect(Number(claiming.min)).toBe(62);
    expect(Number(claiming.max)).toBe(AGE_LIMITS.benefitClaimingAge);
  });

  it("chains current-age max to one year below a shorter life expectancy", () => {
    renderEditor({
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: 70 },
    });
    expect((screen.getByLabelText(/Current age/i) as HTMLInputElement).max).toBe("69");
  });

  it("offers both surplus destinations and defaults an unset value to savings", () => {
    renderEditor({ ...PLAN_DEFAULTS, surplusCashTo: undefined });
    const select = screen.getByLabelText(/Surplus cash goes to/i) as HTMLSelectElement;
    expect(select.value).toBe("savings");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["savings", "brokerage"]);
  });

  it("routes a name edit through updatePlan", () => {
    const { updatePlan } = renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam" } });
    expect(updatePlan).toHaveBeenLastCalledWith({ name: "Sam" });
  });

  it("converts current age to birth year before updating the plan", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Current age/i), 45);
    expect(updatePlan).toHaveBeenLastCalledWith({ birthYear: START_YEAR - 45 });
  });

  it("routes life expectancy and claiming age as their plan fields", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Life expectancy/i), 95);
    expect(updatePlan).toHaveBeenLastCalledWith({ lifeExpectancy: 95 });

    enterNumber(screen.getByLabelText(/Social Security claiming age/i), 70);
    expect(updatePlan).toHaveBeenLastCalledWith({ benefitClaimingAge: 70 });
  });

  it("routes the surplus destination through updatePlan", () => {
    const { updatePlan } = renderEditor({ ...PLAN_DEFAULTS, surplusCashTo: undefined });
    fireEvent.change(screen.getByLabelText(/Surplus cash goes to/i), {
      target: { value: "brokerage" },
    });
    expect(updatePlan).toHaveBeenLastCalledWith({ surplusCashTo: "brokerage" });
  });

  it("routes each account's opening balance through updatePlan independently", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Cash opening balance/i), 12000);
    expect(updatePlan).toHaveBeenLastCalledWith({ openingBalanceCents: 1200000 });

    enterNumber(screen.getByLabelText(/Retirement opening balance/i), 50000);
    expect(updatePlan).toHaveBeenLastCalledWith({ retirementOpeningBalanceCents: 5000000 });

    enterNumber(screen.getByLabelText(/Brokerage opening balance/i), 15000);
    expect(updatePlan).toHaveBeenLastCalledWith({ brokerageOpeningBalanceCents: 1500000 });
  });

  it("keeps return-rate controls in Advanced", () => {
    renderEditor();
    const advanced = screen.getByText("Advanced").closest("details")!;
    expect(advanced.querySelectorAll('input[type="number"]').length).toBe(3);
    expect(screen.getByLabelText(/Savings return/i)).toBeTruthy();
    expect(screen.getByLabelText(/Retirement return/i)).toBeTruthy();
    expect(screen.getByLabelText(/Brokerage return/i)).toBeTruthy();
  });

  it("labels Social Security as an estimate rather than advice", () => {
    renderEditor();
    expect(screen.getByText(/Social Security figures are an estimate, not advice/i)).toBeTruthy();
  });

  it("renders a balance chart for each standing account, wired to its own account's series", () => {
    // Each chart's accessible name carries its own summary balance — checking these are
    // distinct and correct confirms the right account id reached the right chart, without
    // re-asserting the point-by-point series shape (that's `accountBalanceSeries.test.ts`'s job).
    renderEditor(
      PLAN_DEFAULTS,
      mkSeries({ savings: 500000, retirement: 250000, brokerage: 100000 }),
    );
    expect(screen.getByRole("img", { name: /Cash savings projected balance.*\$5,000/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Retirement projected balance.*\$2,500/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Brokerage projected balance.*\$1,000/i })).toBeTruthy();
  });

  it("updates a chart's visible balance immediately when the underlying series changes", () => {
    const series1 = mkSeries({ savings: 100000, retirement: 0, brokerage: 0 });
    const series2 = mkSeries({ savings: 999000, retirement: 0, brokerage: 0 });
    const props = {
      budget: PLAN_DEFAULTS,
      transact: vi.fn() as any,
      accounts: ACCOUNTS,
      household: mkHousehold(),
      personNames: new Map([[PRIMARY_PERSON_ID, "You"]]),
      horizonMonths: 12,
    };
    const view = render(<BudgetEditor {...props} series={series1} />);
    expect(view.getByRole("img", { name: /Cash savings projected balance.*\$1,000/i })).toBeTruthy();
    view.rerender(<BudgetEditor {...props} series={series2} />);
    expect(view.getByRole("img", { name: /Cash savings projected balance.*\$9,990/i })).toBeTruthy();
  });

  it("omits the owner label from the accessible name when the household has one member", () => {
    renderEditor(PLAN_DEFAULTS, undefined, mkHousehold(1));
    // The chart's aria-label carries only the account label and summary — no "You" suffix —
    // since a single-member household has nothing to disambiguate.
    expect(screen.getByRole("img", { name: /^Cash savings projected balance/i })).toBeTruthy();
  });
});
