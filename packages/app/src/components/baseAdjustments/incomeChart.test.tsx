/**
 * @vitest-environment jsdom
 *
 * The income chart component's local behaviour — the mode/basis controls and the nonvisual
 * representation it exposes to assistive technology. Recharts needs a real layout width jsdom
 * lacks, so these tests read the DOM the component draws around the chart, never the SVG.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dollarsToCents, type ProjectionIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData } from "./incomeChartData";
import { IncomeChart, IncomeTooltipContent } from "./incomeChart";
import { SPENDING_NEED_KEY } from "./incomeChartModel";

function seriesOf(...perMonth: ProjectionIncomeSource[][]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((incomeSources, i) => ({ month: i + 1, flows: { incomeSources } })),
  ];
  return { months } as unknown as ProjectionSeries;
}

function source(
  sourceId: string,
  cashInflowCents: number,
  category: ProjectionIncomeSource["category"],
): ProjectionIncomeSource {
  return {
    sourceId,
    label: sourceId,
    category,
    cashInflowCents,
    netCashFlowCents: cashInflowCents,
  } as ProjectionIncomeSource;
}

const wages = source("Software Engineer", dollarsToCents(5_000), "wages");

function renderChart(data = buildIncomeChartData(seriesOf([wages]))) {
  return render(
    <IncomeChart
      data={data}
      currentAge={40}
      selectedMonth={0}
      personNames={new Map()}
      onSelectMonth={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("IncomeChart — accessible nonvisual representation", () => {
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

describe("IncomeChart — mode and basis controls", () => {
  it("switches from Simple to Advanced and back through an explicit mode control", () => {
    const data = buildIncomeChartData(
      seriesOf([source("acct:a", dollarsToCents(1_000), "savingsDrawdown")]),
    );
    renderChart(data);
    const bandLabels = () =>
      within(screen.getByRole("table")).getAllByRole("rowheader").map((el) => el.textContent);
    const simple = screen.getByRole("radio", { name: /Simple/i }) as HTMLInputElement;
    const advanced = screen.getByRole("radio", { name: /Advanced/i }) as HTMLInputElement;

    // The active mode is exposed through the radio's checked state, not a checkbox.
    expect(simple.checked).toBe(true);
    expect(advanced.checked).toBe(false);
    expect(bandLabels()).toContain("Living off savings");

    fireEvent.click(advanced);
    expect(advanced.checked).toBe(true);
    expect(bandLabels()).not.toContain("Living off savings");
    expect(bandLabels()).toContain("acct:a");

    fireEvent.click(simple);
    expect(simple.checked).toBe(true);
    expect(bandLabels()).toContain("Living off savings");
  });

  it("still toggles gross vs take-home separately from the mode", () => {
    renderChart();
    // The basis toggle stays a checkbox — it is not part of the Simple/Advanced mode.
    expect(screen.getByRole("checkbox", { name: /Show gross cash flows/i })).toBeDefined();
  });
});

describe("IncomeTooltipContent — the hover readout", () => {
  // Recharts owns the hover and needs a layout jsdom lacks, so the readout is driven directly
  // with the payload Recharts would hand it.
  // Only the fields the readout reads; Recharts' own payload type carries plumbing a test has
  // no way to construct meaningfully.
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const props = (payload: unknown[]) =>
    ({ active: true, label: 12, payload }) as unknown as Parameters<typeof IncomeTooltipContent>[0];

  it("leaves out the bands paying nothing this month", () => {
    // Every band sits in every row — zero-filled so a once-a-year band still draws — so without
    // this an Advanced plan hovers as nine lines of which one carries money.
    render(
      <IncomeTooltipContent
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
      <IncomeTooltipContent {...props([entry("brokerage", 0), entry(SPENDING_NEED_KEY, 0)])} />,
    );
    const rows = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\$0/);
    expect(rows[0]).not.toMatch(/brokerage/);
  });

  it("draws nothing when nothing is hovered", () => {
    const { container } = render(<IncomeTooltipContent {...props([])} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
