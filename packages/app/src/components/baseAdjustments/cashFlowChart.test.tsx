/**
 * @vitest-environment jsdom
 *
 * The cash-flow chart component's local behaviour — the view/mode controls and the nonvisual
 * representation it exposes to assistive technology. Recharts needs a real layout width jsdom
 * lacks, so these tests read the DOM the component draws around the chart, never the SVG.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dollarsToCents, type ProjectionCashFlowIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildCashFlowChartData } from "./cashFlowChartData";
import { CashFlowChart, CashFlowTooltipContent } from "./cashFlowChart";
import { SPENDING_NEED_KEY } from "./cashFlowChartModel";

function seriesOf(
  ...perMonth: {
    sources?: ProjectionCashFlowIncomeSource[];
    obligations?: { id: string; label: string; category: string; amountCents: number }[];
    taxCents?: number;
  }[]
): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((m, i) => ({
      month: i + 1,
      flows: {
        incomeSources: m.sources ?? [],
        obligations: m.obligations ?? [],
        taxCents: m.taxCents ?? 0,
        payrollTaxCents: 0,
        taxSettlementCents: 0,
        expensesCents: 0,
        liabilityPaymentsCents: 0,
      },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

function source(
  sourceId: string,
  cashInflowCents: number,
  category: ProjectionCashFlowIncomeSource["category"],
): ProjectionCashFlowIncomeSource {
  return {
    sourceId,
    label: sourceId,
    category,
    cashInflowCents,
    netCashFlowCents: cashInflowCents,
  } as ProjectionCashFlowIncomeSource;
}

const wages = source("Software Engineer", dollarsToCents(5_000), "wages");

function renderChart(data = buildCashFlowChartData(seriesOf({ sources: [wages] }))) {
  return render(
    <CashFlowChart
      data={data}
      currentAge={40}
      selectedMonth={0}
      personNames={new Map()}
      onSelectMonth={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("CashFlowChart — accessible nonvisual representation", () => {
  it("renders a data table of sources and formatted amounts, not raw ids or cents", () => {
    renderChart();
    const table = screen.getByRole("table");
    const text = table.textContent ?? "";
    expect(text).toContain("Software Engineer");
    expect(text).toContain("$5,000"); // formatted, not "500000"
    expect(text).not.toContain("500000");
    // Spending need and total belong in the nonvisual table too.
    expect(text).toMatch(/spending need/i);
  });

  it("keeps the raw test-only JSON out of the accessibility tree", () => {
    renderChart();
    // The mirror still exists for tests, but is hidden — excluded from the a11y tree.
    const mirror = screen.getByTestId("income-first-row");
    expect(mirror).toHaveProperty("hidden", true);
    // No accessible element serialises an object literal to a screen reader.
    expect(screen.queryByRole("table")!.textContent).not.toContain("{");
  });

  it("hides the table by WRAPPING it, so it cannot stretch the page it is invisible on", () => {
    // A `<table>` sizes to its content: `width: 1px` / `height: 1px` are minimums it ignores,
    // and neither `overflow: hidden` nor the legacy `clip` stops it laying out at full size.
    // With the off-screen style on the table itself, this one — a row per interesting moment
    // in a lifetime projection — laid out ~103,000px tall and, being absolutely positioned,
    // left the document scrolling a hundred thousand pixels past the last visible thing.
    renderChart();
    const table = screen.getByTestId("income-a11y-table");
    expect(table.style.position).toBe(""); // the hiding is NOT on the table
    const wrapper = table.parentElement!;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.overflow).toBe("hidden");
    // A div honours all of these; the table inside keeps its own display and semantics.
    expect(wrapper.style.width).toBe("1px");
    expect(wrapper.style.height).toBe("1px");
    // Still reachable to a screen reader — hidden is not `display: none` or `hidden`.
    expect(screen.getByRole("table")).toBe(table);
  });

  it("scopes each moment heading to its own tbody as a rowgroup, not a colgroup", () => {
    renderChart();
    // Each moment heading spans two columns but groups the ROWS beneath it within its own
    // <tbody>, not a group of columns — `colgroup` would misdescribe it to a screen reader.
    const headings = screen.getAllByRole("rowheader", { name: /month \d+/ });
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading.getAttribute("scope")).toBe("rowgroup");
    }
  });
});

describe("CashFlowChart — the view and detail controls", () => {
  const rich = () =>
    buildCashFlowChartData(
      seriesOf({
        sources: [wages],
        taxCents: dollarsToCents(900),
        obligations: [
          { id: "line:rent", label: "Housing", category: "needs", amountCents: dollarsToCents(1_600) },
          { id: "line:fun", label: "Dining", category: "wants", amountCents: dollarsToCents(400) },
        ],
      }),
    );
  const bandLabels = () =>
    within(screen.getByRole("table")).getAllByRole("rowheader").map((el) => el.textContent);

  it("opens on what's coming in", () => {
    renderChart(rich());
    expect((screen.getByRole("radio", { name: /Coming in/i }) as HTMLInputElement).checked).toBe(true);
    expect(bandLabels()).toContain("Software Engineer");
    expect(bandLabels()).not.toContain("Housing");
  });

  it("toggles to what's going out, showing tax and spending instead of income", () => {
    renderChart(rich());
    fireEvent.click(screen.getByRole("radio", { name: /Going out/i }));
    expect(bandLabels()).toContain("Taxes");
    expect(bandLabels()).toContain("Needs");
    expect(bandLabels()).not.toContain("Software Engineer");
  });

  it("toggles to the net, which reads as a single figure and no bands", () => {
    renderChart(rich());
    fireEvent.click(screen.getByRole("radio", { name: /^Net$/i }));
    expect(bandLabels()).toContain("Net cash flow");
    expect(bandLabels()).not.toContain("Software Engineer");
    expect(bandLabels()).not.toContain("Taxes");
    // 5,000 in, 900 tax + 2,000 spending out.
    expect(screen.getByTestId("income-first-net").textContent).toBe(String(dollarsToCents(2_100)));
  });

  it("hides the detail control on the net view, which has no bands to collapse", () => {
    renderChart(rich());
    const detail = screen.getByRole("radio", { name: /Simple/i }).closest("fieldset")!;
    expect(detail.hidden).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: /^Net$/i }));
    expect(detail.hidden).toBe(true);
  });

  it("splits spending per line in Advanced, and folds it per category in Simple", () => {
    renderChart(rich());
    fireEvent.click(screen.getByRole("radio", { name: /Going out/i }));
    expect(bandLabels()).toContain("Needs");
    expect(bandLabels()).not.toContain("Housing");

    fireEvent.click(screen.getByRole("radio", { name: /Advanced/i }));
    expect(bandLabels()).toContain("Housing");
    expect(bandLabels()).toContain("Dining");
    expect(bandLabels()).not.toContain("Needs");
  });

  it("no longer offers a gross/take-home basis — the views replaced it", () => {
    renderChart(rich());
    expect(screen.queryByRole("checkbox", { name: /gross/i })).toBeNull();
  });
});

describe("CashFlowTooltipContent — the hover readout", () => {
  // Recharts owns the hover and needs a layout jsdom lacks, so the readout is driven directly
  // with the payload Recharts would hand it.
  // Only the fields the readout reads; Recharts' own payload type carries plumbing a test has
  // no way to construct meaningfully.
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const props = (payload: unknown[]) =>
    ({ active: true, label: 12, payload }) as unknown as Parameters<typeof CashFlowTooltipContent>[0];

  it("leaves out the bands paying nothing this month", () => {
    // Every band sits in every row — zero-filled so a once-a-year band still draws — so without
    // this an Advanced plan hovers as nine lines of which one carries money.
    render(
      <CashFlowTooltipContent
        {...props([
          entry("rmd:p1", dollarsToCents(80_000)),
          entry("brokerage", 0),
          entry("savings-drawdown", 0),
          entry(SPENDING_NEED_KEY, dollarsToCents(4_000)),
        ])}
      />,
    );
    // Recharts splits each row into name/value spans, so read the rows whole.
    const rows = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/rmd:p1.*\$80,000/);
    expect(rows.join(" ")).not.toMatch(/brokerage|savings-drawdown/);
  });

  it("keeps the spending need even at zero — absent, it would read as 'not shown'", () => {
    render(
      <CashFlowTooltipContent {...props([entry("brokerage", 0), entry(SPENDING_NEED_KEY, 0)])} />,
    );
    const rows = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\$0/);
    expect(rows[0]).not.toMatch(/brokerage/);
  });

  it("draws nothing when nothing is hovered", () => {
    const { container } = render(<CashFlowTooltipContent {...props([])} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
