/**
 * @vitest-environment node
 *
 * Render coverage for the net-worth breakdown chart via the server renderer (this repo's
 * jsdom is unavailable). Recharts needs a real width, so the SVG does not lay out here;
 * these pin the wiring around it — heading, summary, hidden band mirror, and the view
 * toggle appearing only when there is more than one view to offer.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SYNTHETIC_CARD_ID, type ProjectionSeries } from "@finley/engine";
import { NetWorthBreakdownChart, tooltipTotals } from "./netWorthBreakdownChart";
import {
  buildNetWorthBreakdown,
  peakNetWorthOf,
  type BreakdownMeta,
  type BreakdownBand,
} from "./netWorthBreakdown";

interface MonthSpec {
  readonly accounts?: Readonly<Record<string, number>>;
  readonly properties?: Readonly<Record<string, number>>;
  readonly liabilities?: Readonly<Record<string, number>>;
}

function mkMonth(m: MonthSpec, month: number) {
  return {
    month,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    netWorthByPersonCents: {},
    accountBalancesCents: m.accounts ?? {},
    // Inert here: the breakdown charts balances, never the embedded gain.
    accountBasisCents: {},
    liabilityBalancesCents: m.liabilities ?? {},
    liabilityPaymentRecords: {},
    propertyValuesCents: m.properties ?? {},
    isInsolvent: false,
    uncoveredCents: 0,
  };
}

function series(months: readonly MonthSpec[]): ProjectionSeries {
  const built = months.map(mkMonth);
  return {
    opening: mkMonth({}, 0),
    months: built,
    status: "ran-to-horizon",
    simulatedThroughMonth: built.length - 1,
    obligationOutcomes: {},
  };
}

const META: BreakdownMeta = {
  accounts: [
    { id: "savings", label: "Cash savings" },
    { id: "goal-emg", label: "Emergency fund" },
  ],
  liabilityLabels: { "mortgage-1": "Mortgage" },
};

describe("NetWorthBreakdownChart", () => {
  it("renders the heading, summary, and the stacked account bands", () => {
    const data = buildNetWorthBreakdown(
      series([{ accounts: { savings: 100000, "goal-emg": 50000 } }]),
      META,
    );
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    expect(html).toContain("Net worth breakdown");
    expect(html).toContain("net worth"); // summary line
    // Hidden band mirror carries the labels currently stacked.
    expect(html).toContain("Cash savings");
    expect(html).toContain("Emergency fund");
  });

  it("offers no view toggle when there is only the accounts view", () => {
    const data = buildNetWorthBreakdown(series([{ accounts: { savings: 100000 } }]), META);
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    // Accounts-only plan → single view → no segmented control.
    expect(html).not.toContain('aria-label="Breakdown view"');
  });

  it("offers the Accounts/Assets/Net worth toggle once there is property and debt", () => {
    const data = buildNetWorthBreakdown(
      series([
        {
          accounts: { savings: 100000 },
          properties: { "home-1": 400000 },
          liabilities: { "mortgage-1": 300000 },
        },
      ]),
      META,
    );
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    expect(html).toContain('aria-label="Breakdown view"');
    expect(html).toContain("Accounts");
    expect(html).toContain("Assets");
    expect(html).toContain("Net worth");
    // Defaults to Accounts: only account bands are stacked, and its button is pressed.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Cash savings");
    expect(html).not.toContain("Mortgage"); // liability band hidden in the default Accounts view
  });
});

describe("tooltipTotals", () => {
  const bands: readonly BreakdownBand[] = [
    { id: "savings", label: "Cash savings", kind: "account" },
    { id: "home-1", label: "Home", kind: "property" },
    { id: "loan-student", label: "Student loan", kind: "liability" },
  ];

  it("splits assets from liabilities and nets them (liabilities arrive signed negative)", () => {
    const totals = tooltipTotals(
      [
        { dataKey: "savings", value: 100000 },
        { dataKey: "home-1", value: 40000 },
        { dataKey: "loan-student", value: -30000 }, // networth view negates the owed balance
      ],
      bands,
    );
    expect(totals.assetsCents).toBe(140000);
    expect(totals.liabilitiesCents).toBe(-30000);
    expect(totals.netWorthCents).toBe(110000);
    expect(totals.hasLiabilities).toBe(true);
  });

  it("reports no liabilities when only asset bands are in view", () => {
    const totals = tooltipTotals(
      [
        { dataKey: "savings", value: 100000 },
        { dataKey: "home-1", value: 40000 },
      ],
      bands,
    );
    expect(totals.assetsCents).toBe(140000);
    expect(totals.liabilitiesCents).toBe(0);
    expect(totals.netWorthCents).toBe(140000);
    expect(totals.hasLiabilities).toBe(false);
  });
});

/**
 * The owner cut. A household with two earners can ask whose balance sheet it is looking at —
 * the whole reason accounts carry an owner rather than being pooled.
 */
describe("NetWorthBreakdownChart — whose net worth", () => {
  const twoOwners = () =>
    buildNetWorthBreakdown(
      series([
        { accounts: { savings: 10_000, "savings-p2": 4_000 }, liabilities: { "loan-1": 2_000 } },
        { accounts: { savings: 12_000, "savings-p2": 5_000 }, liabilities: { "loan-1": 1_500 } },
      ]),
      {
        accounts: [
          { id: "savings", label: "Cash savings", ownerId: "p1" },
          { id: "savings-p2", label: "Blake — Cash savings", ownerId: "p2" },
        ],
        liabilityLabels: { "loan-1": "Auto loan" },
        ownerById: { "loan-1": "p2" },
      },
    );

  const names = new Map([
    ["p1", "Alex"],
    ["p2", "Blake"],
  ]);

  it("reports both owners once each holds a drawn band", () => {
    expect(twoOwners().owners).toEqual(["p1", "p2"]);
  });

  it("offers no owner toggle for a household of one", () => {
    const html = renderToStaticMarkup(
      <NetWorthBreakdownChart data={twoOwners()} personNames={new Map([["p1", "Alex"]])} />,
    );
    // p2 cannot be named, so there is nobody to compare against and no cut to offer.
    expect(html).not.toContain("Whose net worth");
  });

  it("offers Combined plus one cut per named person", () => {
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={twoOwners()} personNames={names} />);
    expect(html).toContain("Whose net worth");
    expect(html).toContain("Combined");
    expect(html).toContain("Alex");
    expect(html).toContain("Blake");
  });

  it("shows every band in the combined view, and one person's alone in theirs", () => {
    const data = twoOwners();
    // Combined is the default, so the bands mirror hold both people's accounts.
    const combined = renderToStaticMarkup(<NetWorthBreakdownChart data={data} personNames={names} />);
    expect(combined).toContain("Cash savings");
    expect(combined).toContain("Blake \u2014 Cash savings");
  });

  it("keeps an unattributed band out of every person's cut", () => {
    // The engine's synthetic last-resort card is owned by the household, not by a person; a cut
    // that charged it to Alex or Blake would show debt neither of them owes.
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 10_000, "savings-p2": 4_000 }, liabilities: { [SYNTHETIC_CARD_ID]: 900 } },
      ]),
      {
        accounts: [
          { id: "savings", label: "Cash savings", ownerId: "p1" },
          { id: "savings-p2", label: "Blake — Cash savings", ownerId: "p2" },
        ],
        liabilityLabels: { [SYNTHETIC_CARD_ID]: "Credit card" },
      },
    );
    expect(data.owners).toEqual(["p1", "p2"]);
    expect(data.bands.find((b) => b.id === SYNTHETIC_CARD_ID)?.ownerId).toBeUndefined();
  });
});


/**
 * The headline figure under a person's cut. The summary used to read `peakNetWorthCents` — the
 * HOUSEHOLD's high-water mark — whichever cut was showing, so selecting a partner printed a
 * number their own chart never comes near, with the axis and the sentence disagreeing on the
 * same screen.
 */
describe("peakNetWorthOf — whose high-water mark", () => {
  const data = buildNetWorthBreakdown(
    series([
      { accounts: { savings: 10_000, "savings-p2": 4_000 }, liabilities: { "loan-1": 2_000 } },
      // Alex peaks here; Blake keeps climbing afterwards, so the two peaks fall in different
      // months and neither is the household's.
      { accounts: { savings: 30_000, "savings-p2": 5_000 }, liabilities: { "loan-1": 1_500 } },
      { accounts: { savings: 12_000, "savings-p2": 9_000 }, liabilities: { "loan-1": 1_000 } },
    ]),
    {
      accounts: [
        { id: "savings", label: "Cash savings", ownerId: "p1" },
        { id: "savings-p2", label: "Blake — Cash savings", ownerId: "p2" },
      ],
      liabilityLabels: { "loan-1": "Auto loan" },
      ownerById: { "loan-1": "p2" },
    },
  );
  const owned = (ownerId: string) => data.bands.filter((b) => b.ownerId === ownerId);

  it("gives each person their own peak, in their own month", () => {
    // Alex: $30,000, no debt. Blake: $9,000 of savings less the $1,000 still owed on the loan.
    expect(peakNetWorthOf(data, owned("p1"))).toBe(30_000);
    expect(peakNetWorthOf(data, owned("p2"))).toBe(8_000);
  });

  it("never reports the household's figure for one person", () => {
    // The household peaks at $33,500 in month 1 — a number neither partner reaches alone.
    expect(data.peakNetWorthCents).toBe(33_500);
    expect(peakNetWorthOf(data, owned("p1"))).not.toBe(data.peakNetWorthCents);
    expect(peakNetWorthOf(data, owned("p2"))).not.toBe(data.peakNetWorthCents);
  });

  it("counts a person's debt against them, not just their assets", () => {
    // Blake's loan is Blake's: $9,000 of savings is not an $9,000 peak.
    expect(peakNetWorthOf(data, owned("p2"))).toBeLessThan(9_000);
  });

  it("agrees with the household figure when handed every band", () => {
    expect(peakNetWorthOf(data, data.bands)).toBe(data.peakNetWorthCents);
  });
});
