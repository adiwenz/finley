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

/** A partner's three, same KINDS as the primary's — which is what used to hide them. */
const PARTNER_ACCOUNTS: readonly PlanAccountDescriptor[] = [
  { id: "savings-p2", label: "Blake — Cash savings", kind: "cash", ownerId: "p2" },
  { id: "retirement-p2", label: "Blake — Retirement account", kind: "retirement", ownerId: "p2" },
  { id: "brokerage-p2", label: "Blake — Brokerage", kind: "brokerage", ownerId: "p2" },
];
const PARTNER_SAVINGS = PARTNER_ACCOUNTS[0]!;

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

  it("draws every account the household holds, including one flat at zero", () => {
    // An empty retirement account is a fact worth seeing, and a person whose three charts became
    // two would read as though they held something the others do not.
    render(
      <AccountBalancesPanel
        accounts={PRIMARY_ACCOUNTS}
        series={mkSeries({ savings: 500000, retirement: 0, brokerage: 0 })}
        horizonMonths={12}
        personNames={new Map([[PRIMARY_PERSON_ID, "Alex"]])}
      />,
    );
    expect(screen.getAllByRole("img", { name: /projected balance/i })).toHaveLength(3);
  });

  it("gives each person their own group of three standing accounts", () => {
    render(
      <AccountBalancesPanel
        accounts={[...PRIMARY_ACCOUNTS, ...PARTNER_ACCOUNTS]}
        series={mkSeries({ savings: 500000, "savings-p2": 1_200_000 })}
        horizonMonths={12}
        personNames={couple}
      />,
    );
    // Six charts, and a heading per person so a reader can tell whose three are whose.
    expect(screen.getAllByRole("img", { name: /projected balance/i })).toHaveLength(6);
    expect(screen.getByRole("heading", { name: "Alex" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Blake" })).toBeTruthy();
  });

  it("does not repeat the owner's name in a caption under their own heading", () => {
    render(
      <AccountBalancesPanel
        accounts={[...PRIMARY_ACCOUNTS, ...PARTNER_ACCOUNTS]}
        series={mkSeries({ "savings-p2": 1_200_000 })}
        horizonMonths={12}
        personNames={couple}
      />,
    );
    // The partner's account label is minted "Blake — Cash savings"; under a "Blake" heading the
    // prefix only says it twice. Both people's captions then read the same way.
    expect(screen.getAllByText("Cash savings")).toHaveLength(2);
    expect(screen.queryByText("Blake — Cash savings")).toBeNull();
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

  it("renders nothing when the household holds no accounts at all", () => {
    // The empty case is having no accounts, not holding accounts with nothing in them.
    const { container } = render(
      <AccountBalancesPanel
        accounts={[]}
        series={mkSeries({})}
        horizonMonths={12}
        personNames={couple}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
