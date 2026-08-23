/**
 * @vitest-environment jsdom
 *
 * The per-account charts, full width at the bottom of the page. These moved out of the Budget
 * sidebar, where they were found by account KIND and so could only ever reach the primary's
 * three: `accounts.find(a => a.kind === "cash")` returns the primary's cash account whatever
 * else the household holds, which made a partner's balances unwatchable. The cases below pin the
 * behaviour the move exists for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PRIMARY_PERSON_ID, type PlanAccountDescriptor, type ProjectionSeries } from "@finley/engine";
import { AccountBalancesPanel } from "./accountBalancesPanel";

afterEach(cleanup);

const PRIMARY_ACCOUNTS: readonly PlanAccountDescriptor[] = [
  { id: "savings", label: "Cash savings", kind: "cash", ownerId: PRIMARY_PERSON_ID },
  { id: "retirement", label: "Retirement", kind: "retirement", ownerId: PRIMARY_PERSON_ID },
  { id: "brokerage", label: "Brokerage", kind: "brokerage", ownerId: PRIMARY_PERSON_ID },
];

/** A partner's cash account — same KIND as the primary's, which is what used to hide it. */
const PARTNER_SAVINGS: PlanAccountDescriptor = {
  id: "savings-p2",
  label: "Blake — Cash savings",
  kind: "cash",
  ownerId: "p2",
};

/** A one-month projection series whose only moving part is each account's balance. */
function mkSeries(openingCentsById: Readonly<Record<string, number>>): ProjectionSeries {
  const month = {
    month: 0,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    netWorthByPersonCents: {},
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
  } as unknown as ProjectionSeries;
}

const couple = new Map([
  [PRIMARY_PERSON_ID, "Alex"],
  ["p2", "Blake"],
]);

describe("AccountBalancesPanel", () => {
  it("charts each account against its own balance, not another of the same kind", () => {
    render(
      <AccountBalancesPanel
        accounts={PRIMARY_ACCOUNTS}
        series={mkSeries({ savings: 500000, retirement: 250000, brokerage: 100000 })}
        horizonMonths={12}
        personNames={new Map([[PRIMARY_PERSON_ID, "Alex"]])}
      />,
    );
    expect(screen.getByRole("img", { name: /Cash savings projected balance.*\$5,000/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Retirement projected balance.*\$2,500/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Brokerage projected balance.*\$1,000/i })).toBeTruthy();
  });

  it("charts a partner's account beside the primary's account of the same kind", () => {
    // The whole point of the move: two cash accounts, both drawn, each carrying its own balance.
    render(
      <AccountBalancesPanel
        accounts={[...PRIMARY_ACCOUNTS, PARTNER_SAVINGS]}
        series={mkSeries({ savings: 500000, retirement: 0, brokerage: 0, "savings-p2": 1_200_000 })}
        horizonMonths={12}
        personNames={couple}
      />,
    );
    expect(screen.getByRole("img", { name: /Cash savings projected balance.*\$5,000/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Blake — Cash savings projected balance.*\$12,000/i })).toBeTruthy();
  });

  it("drops an account that is flat zero for the whole plan", () => {
    // A chart of a line at zero says nothing, and a partner who brought no retirement account
    // should not be given an empty one to look at.
    render(
      <AccountBalancesPanel
        accounts={PRIMARY_ACCOUNTS}
        series={mkSeries({ savings: 500000, retirement: 0, brokerage: 0 })}
        horizonMonths={12}
        personNames={new Map([[PRIMARY_PERSON_ID, "Alex"]])}
      />,
    );
    expect(screen.getByRole("img", { name: /Cash savings projected balance/i })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Retirement projected balance/i })).toBeNull();
  });

  it("names the owner only once there is more than one person", () => {
    const props = {
      accounts: [...PRIMARY_ACCOUNTS, PARTNER_SAVINGS],
      series: mkSeries({ savings: 500000, retirement: 0, brokerage: 0, "savings-p2": 1_200_000 }),
      horizonMonths: 12,
    };
    const view = render(<AccountBalancesPanel {...props} personNames={couple} />);
    expect(view.getByRole("img", { name: /Cash savings projected balance.*Alex/i })).toBeTruthy();

    // A household of one has nothing to disambiguate, so the caption is noise.
    cleanup();
    render(<AccountBalancesPanel {...props} personNames={new Map([[PRIMARY_PERSON_ID, "Alex"]])} />);
    expect(screen.getByRole("img", { name: /^Cash savings projected balance/i })).toBeTruthy();
  });

  it("renders nothing at all when every account is empty", () => {
    const { container } = render(
      <AccountBalancesPanel
        accounts={PRIMARY_ACCOUNTS}
        series={mkSeries({ savings: 0, retirement: 0, brokerage: 0 })}
        horizonMonths={12}
        personNames={couple}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
