/**
 * @vitest-environment jsdom
 *
 * The tax chart's hover readout. Recharts owns the hover and needs a real layout width jsdom
 * lacks, so the readout is driven directly with the payload Recharts would hand it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dollarsToCents } from "@finley/engine";
import { TaxChart, TaxTooltipContent } from "./taxChart";
import type { TaxMonthRow } from "./taxesByMonth";

afterEach(cleanup);

describe("TaxTooltipContent — the hover readout", () => {
  // Only the fields the readout reads; Recharts' own payload type carries plumbing a test has
  // no way to construct meaningfully.
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const props = (payload: unknown[]) =>
    ({ active: true, label: 12, payload }) as unknown as Parameters<typeof TaxTooltipContent>[0];

  it("leaves out the bands charging nothing this month", () => {
    // Every band sits in every row — zero-filled so a once-a-year band still draws — so without
    // this a two-earner plan hovers as nine lines of which one carries money.
    render(
      <TaxTooltipContent
        {...props([
          entry("income:job-a", dollarsToCents(900)),
          entry("fica:job-a", dollarsToCents(350)),
          entry("draw:brokerage", 0),
          entry("draw:pretax", 0),
        ])}
      />,
    );
    // Recharts splits each row into name/value spans, so read the rows whole.
    const rows = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/income:job-a.*\$900/);
    expect(rows.join(" ")).not.toMatch(/brokerage|pretax/);
  });

  it("totals only what it shows — and the zeroes it dropped were worth nothing anyway", () => {
    render(
      <TaxTooltipContent
        {...props([
          entry("income:job-a", dollarsToCents(900)),
          entry("fica:job-a", dollarsToCents(350)),
          entry("draw:brokerage", 0),
        ])}
      />,
    );
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,250/);
  });

  it("draws no Total for a single paying band, which would just repeat the row above", () => {
    render(
      <TaxTooltipContent {...props([entry("income:job-a", dollarsToCents(900)), entry("fica:job-a", 0)])} />,
    );
    expect(screen.queryByText("Total taxes paid")).toBeNull();
  });

  it("draws nothing in a month that charged no tax at all", () => {
    const { container } = render(<TaxTooltipContent {...props([entry("income:job-a", 0)])} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws nothing when nothing is hovered", () => {
    const { container } = render(<TaxTooltipContent {...props([])} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});

/**
 * The two sections below the bands. Both are explanation: neither is ever a band height, and the
 * bolded total goes on agreeing with the tax the month actually paid.
 */
describe("TaxTooltipContent — a filing month's readout", () => {
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const row = (over: Partial<TaxMonthRow>): TaxMonthRow => ({
    month: 15,
    taxCents: 0,
    centsBySource: {},
    settlementCents: 0,
    settlementPaidCents: 0,
    refundCents: 0,
    settlementBySourceCents: {},
    settlementBySourcePersonCents: {},
    settlementByPersonCents: {},
    settlementByOwnerCents: {},
    refundByOwnerCents: {},
    ...over,
  });
  const hover = (payload: unknown[], r: TaxMonthRow) => ({
    active: true,
    label: 16,
    payload,
    rowsByAxisX: new Map([[16, r]]),
    sourceLabels: { "job:job-1": "Main job", "job:job-2": "Second job", "interest:savings": "Savings" },
  }) as unknown as Parameters<typeof TaxTooltipContent>[0];

  it("shows the settlement's signed attribution as diagnostics, netting to the band", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", 157249), entry("Second job", 18463), entry("Tax settlement", 7126)],
          row({
            taxCents: 182838,
            settlementCents: 7126,
            settlementPaidCents: 7126,
            settlementBySourceCents: {
              "job:job-1": -340911,
              "job:job-2": 343439,
              "interest:savings": 4598,
            },
          }),
        )}
      />,
    );
    const diagnostic = screen.getByTestId("settlement-attribution").textContent!;
    expect(diagnostic).toMatch(/Main job.*-\$3,409/);
    expect(diagnostic).toMatch(/Second job.*\$3,434/);
    expect(diagnostic).toMatch(/Savings.*\$46/);
    expect(diagnostic).toMatch(/Net.*\$71/);
  });

  it("totals the tax actually paid — the diagnostic rows add nothing to it", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", 157249), entry("Second job", 18463), entry("Tax settlement", 7126)],
          row({
            taxCents: 182838,
            settlementCents: 7126,
            settlementPaidCents: 7126,
            settlementBySourceCents: { "job:job-1": -340911, "job:job-2": 343439, "interest:savings": 4598 },
          }),
        )}
      />,
    );
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,828/);
  });

  it("names a refund as money back, and points at the chart it lands on", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", dollarsToCents(1100)), entry("Main job — FICA", dollarsToCents(400))],
          row({ taxCents: dollarsToCents(1500), settlementCents: dollarsToCents(-3000), refundCents: dollarsToCents(3000) }),
        )}
      />,
    );
    expect(screen.getByText("Tax refund").parentElement?.textContent).toMatch(/\$3,000/);
    expect(screen.getByText(/cash-flow chart/)).toBeTruthy();
    // The withholding stands: the refund did not net against it.
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,500/);
  });

  it("still speaks for a refund-only month, which has no band to hover", () => {
    render(
      <TaxTooltipContent
        {...hover([entry("Main job", 0)], row({ settlementCents: dollarsToCents(-3000), refundCents: dollarsToCents(3000) }))}
      />,
    );
    expect(screen.getByText("Tax refund").parentElement?.textContent).toMatch(/\$3,000/);
    expect(screen.queryByText("Total taxes paid")).toBeNull();
  });

  it("adds neither section to an ordinary month", () => {
    render(
      <TaxTooltipContent
        {...hover([entry("Main job", dollarsToCents(1100))], row({ taxCents: dollarsToCents(1100) }))}
      />,
    );
    expect(screen.queryByTestId("settlement-attribution")).toBeNull();
    expect(screen.queryByText("Tax refund")).toBeNull();
  });
});

/**
 * Whose settlement the diagnostic explains. The band it sits under is already one person's when a
 * person's cut is showing, so this section has to be theirs too — the household's sources under
 * Alex's name are not extra context, they are a different filer's arithmetic and a total Alex
 * never owed.
 *
 * Modelled on the real April this was found in: two members drawing a benefit, an RMD and savings
 * interest apiece, whose household attribution reads as six lines totalling a figure neither of
 * them settled.
 */
describe("TaxTooltipContent — whose settlement is being explained", () => {
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;

  const ALEX = { "rmd:p1": 282867, "interest:savings": 168393, "benefit:p1": 686012 };
  const CASEY = { "benefit:person-11": 134304, "rmd:person-11": 91043, "interest:savings-person-11": 573 };
  const ALEX_TOTAL = 1137272;
  const CASEY_TOTAL = 225920;

  const APRIL: TaxMonthRow = {
    month: 531,
    taxCents: 1363192,
    centsBySource: { "tax-settlement": 1363192 },
    settlementCents: ALEX_TOTAL + CASEY_TOTAL,
    settlementPaidCents: ALEX_TOTAL + CASEY_TOTAL,
    refundCents: 0,
    settlementBySourceCents: { ...ALEX, ...CASEY },
    settlementBySourcePersonCents: { p1: ALEX, "person-11": CASEY },
    settlementByPersonCents: { p1: ALEX_TOTAL, "person-11": CASEY_TOTAL },
    settlementByOwnerCents: { "tax-settlement:p1": ALEX_TOTAL, "tax-settlement:person-11": CASEY_TOTAL },
    refundByOwnerCents: {},
  };

  const LABELS = {
    "rmd:p1": "Required distribution · Alex",
    "interest:savings": "Cash savings · Alex",
    "benefit:p1": "Government benefit · Alex",
    "rmd:person-11": "Required distribution · Casey",
    "interest:savings-person-11": "Casey — Cash savings",
    "benefit:person-11": "Government benefit · Casey",
    "rmd:person-8": "Required distribution · Blake",
  };

  const hover = (row: TaxMonthRow, ownerId?: string) =>
    ({
      active: true,
      label: 532,
      payload: [entry("Tax settlement", row.settlementByOwnerCents[`tax-settlement:${ownerId}`] ?? row.settlementPaidCents)],
      rowsByAxisX: new Map([[532, row]]),
      sourceLabels: LABELS,
      ...(ownerId === undefined ? {} : { ownerId }),
    }) as unknown as Parameters<typeof TaxTooltipContent>[0];

  const diagnostic = () => screen.getByTestId("settlement-attribution").textContent!;

  it("lists every member's sources and the household's total in the combined view", () => {
    render(<TaxTooltipContent {...hover(APRIL)} />);
    const text = diagnostic();
    expect(text).toMatch(/Required distribution · Alex.*\$2,829/);
    expect(text).toMatch(/Government benefit · Alex.*\$6,860/);
    expect(text).toMatch(/Government benefit · Casey.*\$1,343/);
    expect(text).toMatch(/Required distribution · Casey.*\$910/);
    expect(text).toMatch(/Net.*\$13,632/);
  });

  it("shows Alex only Alex's sources, totalling what Alex owed", () => {
    render(<TaxTooltipContent {...hover(APRIL, "p1")} />);
    const text = diagnostic();
    expect(text).toMatch(/Required distribution · Alex.*\$2,829/);
    expect(text).toMatch(/Cash savings · Alex.*\$1,684/);
    expect(text).toMatch(/Government benefit · Alex.*\$6,860/);
    expect(text).not.toMatch(/Casey/);
    expect(text).not.toMatch(/Blake/);
    expect(text).toMatch(/Net.*\$11,373/);
    expect(text).not.toMatch(/13,632/);
  });

  it("shows Casey only Casey's sources, totalling what Casey owed", () => {
    render(<TaxTooltipContent {...hover(APRIL, "person-11")} />);
    const text = diagnostic();
    expect(text).toMatch(/Government benefit · Casey.*\$1,343/);
    expect(text).toMatch(/Required distribution · Casey.*\$910/);
    expect(text).toMatch(/Casey — Cash savings.*\$6/);
    expect(text).not.toMatch(/Alex/);
    expect(text).not.toMatch(/Blake/);
    expect(text).toMatch(/Net.*\$2,259/);
  });

  it("ties each person's Net to the band their own cut draws", () => {
    for (const [ownerId, band] of Object.entries(APRIL.settlementByOwnerCents)) {
      const personId = ownerId.slice("tax-settlement:".length);
      const { unmount } = render(<TaxTooltipContent {...hover(APRIL, personId)} />);
      const lines = screen.getByTestId("settlement-attribution").textContent!;
      const net = Number(lines.match(/Net\$([\d,]+)/)?.[1]?.replace(/,/g, ""));
      expect(net).toBe(Math.round(band / 100));
      unmount();
    }
  });

  it("keeps the two members' totals adding up to the household's", () => {
    expect(ALEX_TOTAL + CASEY_TOTAL).toBe(APRIL.settlementCents);
  });

  it("gives a refunded member their own refund while the other is shown their own bill", () => {
    // Separate single filers: the household nets to −$1,000, and neither person owes or is owed
    // that. Substituting it would tell Alex they were refunded and Casey they broke even.
    const row: TaxMonthRow = {
      ...APRIL,
      settlementCents: -100000,
      settlementPaidCents: 200000,
      refundCents: 300000,
      settlementBySourceCents: { "rmd:p1": 200000, "benefit:person-11": -300000 },
      settlementBySourcePersonCents: { p1: { "rmd:p1": 200000 }, "person-11": { "benefit:person-11": -300000 } },
      settlementByPersonCents: { p1: 200000, "person-11": -300000 },
      settlementByOwnerCents: { "tax-settlement:p1": 200000 },
      refundByOwnerCents: { "person-11": 300000 },
    };

    const alex = render(<TaxTooltipContent {...hover(row, "p1")} />);
    expect(diagnostic()).toMatch(/Net.*\$2,000/);
    expect(screen.queryByText("Tax refund")).toBeNull();
    alex.unmount();

    render(<TaxTooltipContent {...hover(row, "person-11")} />);
    expect(diagnostic()).toMatch(/Net.*-\$3,000/);
    expect(screen.getByText("Tax refund").parentElement?.textContent).toMatch(/\$3,000/);
  });

  it("says nothing about a person who settled nothing this month", () => {
    // Blake left the household years before this April. The row still carries the members who did
    // settle, and asking it about Blake must produce silence rather than the household's figures.
    render(<TaxTooltipContent {...hover(APRIL, "person-8")} />);
    expect(screen.queryByTestId("settlement-attribution")).toBeNull();
  });
});

/**
 * The Combined / per-person toggle. Tax is attributed per SOURCE, and most sources carry the
 * owner the engine assigned them, so a two-earner household can be asked whose tax it is
 * looking at. Three bands cannot be: the April settlement belongs to no source at all, the
 * shared liquid-buffer drawdown is household money, and a source the engine keyed by bare tax
 * category has nobody to name. Those stay in the combined view and in nobody's cut — a person's
 * total must never include tax that was not attributed to them.
 */
describe("TaxChart — whose tax", () => {
  const ALEX_TAX = dollarsToCents(900);
  const BLAKE_TAX = dollarsToCents(600);
  const SETTLEMENT = dollarsToCents(200);

  const bands = [
    { id: "job-a", label: "Software engineer", category: "wages", kind: "incomeTax" as const, ownerId: "p1" },
    { id: "job-b", label: "Teacher", category: "wages", kind: "incomeTax" as const, ownerId: "p2" },
    // No owner: last year's bill arriving, which belongs to no income source.
    { id: "tax-settlement", label: "Tax settlement", category: "tax-settlement", kind: "settlement" as const },
  ];

  const row = (month: number, centsBySource: Record<string, number>) => ({
    month,
    taxCents: Object.values(centsBySource).reduce((a, b) => a + b, 0),
    centsBySource,
    settlementCents: centsBySource["tax-settlement"] ?? 0,
    settlementPaidCents: centsBySource["tax-settlement"] ?? 0,
    refundCents: 0,
    settlementBySourceCents: {},
    settlementBySourcePersonCents: {},
    settlementByPersonCents: {},
    settlementByOwnerCents: {},
    refundByOwnerCents: {},
  });

  const data = {
    rows: [
      row(0, { "job-a": ALEX_TAX, "job-b": BLAKE_TAX }),
      row(1, { "job-a": ALEX_TAX, "job-b": BLAKE_TAX, "tax-settlement": SETTLEMENT }),
    ],
    sources: bands,
    settlementBands: [],
    hasSourceBreakdown: true,
    sourceLabels: {},
    totalCents: ALEX_TAX * 2 + BLAKE_TAX * 2 + SETTLEMENT,
    peakMonthlyCents: ALEX_TAX + BLAKE_TAX + SETTLEMENT,
    peakMonth: 1,
    hasAnyTax: true,
    owners: ["p1", "p2"],
  };

  const couple = new Map([
    ["p1", "Alex"],
    ["p2", "Blake"],
  ]);

  const renderChart = (personNames?: ReadonlyMap<string, string>) =>
    render(
      <TaxChart data={data} selectedMonth={0} onSelectMonth={() => {}} personNames={personNames} />,
    );

  const drawnBands = (): string[] =>
    JSON.parse(screen.getByTestId("tax-bands").textContent ?? "[]") as string[];
  const cut = (name: string) => screen.getByRole("button", { name });

  it("opens combined, showing every band including the ones nobody owns", () => {
    renderChart(couple);
    expect(drawnBands()).toEqual(["Software engineer", "Teacher", "Tax settlement"]);
    expect(cut("Combined").getAttribute("aria-pressed")).toBe("true");
  });

  it("cuts to one person's bands, leaving the other's and the household's out", () => {
    renderChart(couple);
    fireEvent.click(cut("Blake"));
    expect(drawnBands()).toEqual(["Teacher"]);
  });

  it("totals a person's own tax, not their share of the household's", () => {
    renderChart(couple);
    // Combined is everything, settlement included.
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/\$3,200 in tax over the plan/);

    // Blake's is Blake's two months of withholding — $1,200 — and NOT a slice of $3,200. The
    // settlement is the reason a proportional share would be wrong: it is real tax the household
    // paid that belongs to neither person's cut.
    fireEvent.click(cut("Blake"));
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/Blake's \$1,200 in tax over the plan/);
  });

  it("gives a person their own peak month, not the household's", () => {
    renderChart(couple);
    // The household peaks in month 1, when the settlement lands on top of both withholdings.
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/peaking around \$1,700\/mo/);

    // Alex pays the same every month, so their peak is their own flat figure — a household peak
    // driven by the other partner or by a settlement is not theirs.
    fireEvent.click(cut("Alex"));
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/peaking around \$900\/mo/);
  });

  it("offers no cut at all to a household of one", () => {
    // Nobody to compare against, so the control is noise.
    renderChart(new Map([["p1", "Alex"]]));
    expect(screen.queryByRole("group", { name: "Whose tax" })).toBeNull();
    expect(drawnBands()).toEqual(["Software engineer", "Teacher", "Tax settlement"]);
  });

  it("names an owner on the combined view when two bands would otherwise read alike", () => {
    // The engine labels a benefit the same for whoever claims it, so two claimants are one
    // legend entry repeated. Under a person's own button the name is already stated, so it is
    // added on the combined view only.
    const benefit = (owner: string) => ({
      id: `benefit:${owner}`,
      label: "Government benefit",
      category: "governmentRetirementBenefit",
      kind: "incomeTax" as const,
      ownerId: owner,
    });
    const benefits = {
      ...data,
      sources: [benefit("p1"), benefit("p2")],
      rows: [row(0, { "benefit:p1": dollarsToCents(100), "benefit:p2": dollarsToCents(80) })],
    };
    render(
      <TaxChart data={benefits} selectedMonth={0} onSelectMonth={() => {}} personNames={couple} />,
    );
    expect(drawnBands()).toEqual(["Government benefit · Alex", "Government benefit · Blake"]);

    fireEvent.click(cut("Blake"));
    expect(drawnBands()).toEqual(["Government benefit"]);
  });
});

/**
 * The April settlement in a person's cut. The balance was always attributed — the diagnostic
 * tooltip has named the sources all along — but it was drawn as one household band, so a
 * person's cut left their own April bill out entirely and the two people's totals fell short
 * of the household's.
 */
describe("TaxChart — whose April settlement", () => {
  const couple = new Map([
    ["p1", "Alex"],
    ["p2", "Blake"],
  ]);

  const withSettlement = {
    rows: [
      {
        month: 15,
        taxCents: dollarsToCents(1_000),
        centsBySource: {
          "job-a": dollarsToCents(600),
          "tax-settlement": dollarsToCents(400),
          "tax-settlement:p1": dollarsToCents(300),
          "tax-settlement:p2": dollarsToCents(100),
        },
        settlementCents: dollarsToCents(400),
        settlementPaidCents: dollarsToCents(400),
        refundCents: 0,
        settlementBySourceCents: {},
        settlementBySourcePersonCents: {},
        settlementByPersonCents: { p1: dollarsToCents(300), p2: dollarsToCents(100) },
        settlementByOwnerCents: {
          "tax-settlement:p1": dollarsToCents(300),
          "tax-settlement:p2": dollarsToCents(100),
        },
        refundByOwnerCents: {},
      },
    ],
    sources: [
      { id: "job-a", label: "Software engineer", category: "wages", kind: "incomeTax" as const, ownerId: "p1" },
      { id: "tax-settlement", label: "Tax settlement", category: "tax-settlement", kind: "settlement" as const },
    ],
    settlementBands: [
      { id: "tax-settlement:p1", label: "Tax settlement", category: "tax-settlement", kind: "settlement" as const, ownerId: "p1" },
      { id: "tax-settlement:p2", label: "Tax settlement", category: "tax-settlement", kind: "settlement" as const, ownerId: "p2" },
    ],
    hasSourceBreakdown: true,
    sourceLabels: {},
    totalCents: dollarsToCents(1_000),
    peakMonthlyCents: dollarsToCents(1_000),
    peakMonth: 15,
    hasAnyTax: true,
    owners: ["p1", "p2"],
  };

  const renderChart = () =>
    render(
      <TaxChart data={withSettlement} selectedMonth={0} onSelectMonth={() => {}} personNames={couple} />,
    );

  const drawnBands = (): string[] =>
    JSON.parse(screen.getByTestId("tax-bands").textContent ?? "[]") as string[];
  const cut = (name: string) => screen.getByRole("button", { name });

  it("draws the household's whole balance as one band on the combined view", () => {
    renderChart();
    expect(drawnBands()).toEqual(["Software engineer", "Tax settlement"]);
  });

  it("gives a person their own slice of the April bill", () => {
    renderChart();
    fireEvent.click(cut("Blake"));
    // Blake earns no wages here, so their whole tax IS their share of the settlement.
    expect(drawnBands()).toEqual(["Tax settlement"]);
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/Blake's \$100 in tax/);
  });

  it("never draws the household band and a person's slice together", () => {
    // Both at once would draw the same April money twice.
    renderChart();
    fireEvent.click(cut("Alex"));
    expect(drawnBands()).toEqual(["Software engineer", "Tax settlement"]);
    expect(screen.getByTestId("tax-summary").textContent).toMatch(/Alex's \$900 in tax/);
  });

  it("adds the two people's totals back up to the household's", () => {
    // The whole point: $101,279 of a real household's lifetime tax used to belong to nobody
    // because every April bill sat outside both people's cuts.
    renderChart();
    fireEvent.click(cut("Alex"));
    const alex = screen.getByTestId("tax-summary").textContent ?? "";
    fireEvent.click(cut("Blake"));
    const blake = screen.getByTestId("tax-summary").textContent ?? "";
    fireEvent.click(cut("Combined"));
    const combined = screen.getByTestId("tax-summary").textContent ?? "";
    expect(alex).toMatch(/\$900 in tax/);
    expect(blake).toMatch(/\$100 in tax/);
    expect(combined).toMatch(/\$1,000 in tax/);
  });
});
