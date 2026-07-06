import type { ProjectionSeries } from "@finley/engine";

/**
 * Placeholder net-worth area chart (issue #1 acceptance: render the engine's
 * projection series into a chart). Draws the nominal and real net-worth curves
 * from the {@link ProjectionSeries} contract. Deliberately minimal SVG — the
 * real charting/design work is Slice 11; this only proves the engine → app wire.
 */
const WIDTH = 720;
const HEIGHT = 320;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

const INK = "#1f3a2e"; // ledger ink green
const AMBER = "#b5761f";

function centsToDollarLabel(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function renderNetWorthChart(series: ProjectionSeries): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Projected net worth over time (nominal and real)");

  const months = series.months;
  const lastMonth = months[months.length - 1]?.month ?? 0;
  const values = months.flatMap((m) => [m.netWorthNominalCents, m.netWorthRealCents]);
  const maxV = Math.max(0, ...values);
  const minV = Math.min(0, ...values);

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (month: number) =>
    PAD.left + (lastMonth === 0 ? 0 : (month / lastMonth) * plotW);
  const y = (cents: number) =>
    PAD.top + (maxV === minV ? plotH : ((maxV - cents) / (maxV - minV)) * plotH);

  const line = (key: "netWorthNominalCents" | "netWorthRealCents") =>
    months.map((m) => `${x(m.month)},${y(m[key])}`).join(" ");

  const baseY = y(0);

  // zero baseline
  const axis = document.createElementNS(svg.namespaceURI, "line");
  axis.setAttribute("x1", String(PAD.left));
  axis.setAttribute("x2", String(WIDTH - PAD.right));
  axis.setAttribute("y1", String(baseY));
  axis.setAttribute("y2", String(baseY));
  axis.setAttribute("stroke", "#c9bfa5");
  axis.setAttribute("stroke-width", "1");
  svg.appendChild(axis);

  // nominal area
  const nominalArea = document.createElementNS(svg.namespaceURI, "polygon");
  nominalArea.setAttribute(
    "points",
    `${PAD.left},${baseY} ${line("netWorthNominalCents")} ${x(lastMonth)},${baseY}`,
  );
  nominalArea.setAttribute("fill", INK);
  nominalArea.setAttribute("fill-opacity", "0.12");
  svg.appendChild(nominalArea);

  // nominal + real lines
  for (const [key, color] of [
    ["netWorthNominalCents", INK],
    ["netWorthRealCents", AMBER],
  ] as const) {
    const poly = document.createElementNS(svg.namespaceURI, "polyline");
    poly.setAttribute("points", line(key));
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", color);
    poly.setAttribute("stroke-width", "2");
    svg.appendChild(poly);
  }

  // y-axis labels (max / zero)
  for (const cents of [maxV, 0]) {
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", String(PAD.left - 8));
    label.setAttribute("y", String(y(cents) + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", "#6b6552");
    label.textContent = centsToDollarLabel(cents);
    svg.appendChild(label);
  }

  return svg;
}
