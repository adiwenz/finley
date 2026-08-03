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
import { IncomeChart } from "./incomeChart";

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
