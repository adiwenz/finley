/**
 * @vitest-environment node
 *
 * **The QA script, executed — the other panels.** `scenarios.test.tsx` covers exactly one join
 * between engine and UI: the retirement panel's answer sentence. Every other surface that makes a
 * claim to a household has its own seam tested but not that join, so an engine that scores
 * correctly and a panel that renders correctly can still combine into a false claim with every
 * test green.
 *
 * These author a household through the public `Projection` API — replace a job, marry, reorder a
 * goal — solve it against the real US jurisdiction, render the REAL panel, and assert the
 * SENTENCE or FIGURE that constitutes each panel's claim:
 *
 *  - the **goals panel** — each goal's projection-scored status ("Funded" / "N% on track"),
 *  - the **net-worth breakdown** — the peak figure and composition it states above its bands,
 *  - the **base adjustments** panel — the monthly income it reads out for the selected month.
 *
 * Numbers are pinned as the formatted strings a user reads, never the cents underneath: "$70,000
 * of pay funds the emergency reserve but leaves the down payment 48% on track" is either what a
 * household is told or it is not, and a `toContain("48")` cannot tell that from a home fund at
 * 148%.
 */

import { describe, it, expect } from "vitest";
import { alexAlone, alexAndSam, jobAt, goalClaim, netWorthSummary, budgetIncome } from "./testing/scenarioBuilders";

/** The two goals a fresh plan opens with; read back by name so no test assumes a minted id. */
const EMERGENCY = "Emergency fund";
const HOME = "Home down payment";

/** Replace the primary's one job with a flat-salaried one, in place, and hand the handle back. */
function earning(annualDollars: number) {
  const p = alexAlone();
  p.replaceJob(p.plan.primary.jobs[0]!.id, jobAt(18, 65, annualDollars));
  return p;
}

describe("goals panel — what each goal is scored as", () => {
  it("tells a household on the default pay that both reserves are behind", () => {
    // The starting plan spends past its $5k/mo pay, so nothing reaches a fund: both goals sit at
    // zero, both flagged behind, each still stating its own target, date and disposition.
    const p = alexAlone();
    expect(goalClaim(p, EMERGENCY)).toEqual([
      "0% on track",
      "In progress · Behind pace",
      "$15,000 by Year 2 (2028)",
      "At target: Kept as a reserve",
    ]);
    expect(goalClaim(p, HOME)).toEqual([
      "0% on track",
      "In progress · Behind pace",
      "$60,000 by Year 5 (2031)",
      "At target: Kept as a reserve",
    ]);
  });

  it("funds the higher-priority goal first, then reports the lower one behind", () => {
    // $70k of pay leaves a surplus that fills the emergency reserve to target — latched Funded,
    // so the on-track percentage drops for a badge — while the down payment, funded second, only
    // reaches 48%. The waterfall's priority order is the household's claim end to end.
    const p = earning(70_000);
    expect(goalClaim(p, EMERGENCY)).toEqual([
      "Funded",
      "$15,000 by Year 2 (2028)",
      "At target: Kept as a reserve",
    ]);
    expect(goalClaim(p, HOME)).toEqual([
      "48% on track",
      "In progress · Behind pace",
      "$60,000 by Year 5 (2031)",
      "At target: Kept as a reserve",
    ]);
  });

  it("moves the money when the list is reordered — the other goal's number drops", () => {
    // The same $70k, but the down payment is promoted above the reserve. It now draws the surplus
    // first and reaches 81%; the reserve, funded second off what's left, falls to zero. The
    // tradeoff a shared priority list exists to show.
    const p = earning(70_000);
    p.reorderGoal(p.plan.goals.find((g) => g.name === HOME)!.id, "up");
    expect(goalClaim(p, HOME).slice(0, 1)).toEqual(["81% on track"]);
    expect(goalClaim(p, EMERGENCY).slice(0, 1)).toEqual(["0% on track"]);
  });
});

describe("net-worth breakdown — the sentence above the bands", () => {
  it("tells a household living on credit that its net worth includes debt", () => {
    // The default plan's spending outruns its pay, so the engine's last-resort borrowing charts
    // as debt and the composition names it — the household is not shown a debt-free picture.
    expect(netWorthSummary(alexAlone())).toBe(
      "Peaks around $10,281 net worth, across 1 account, and debt.",
    );
  });

  it("a surplus household's breakdown names its accounts and no debt", () => {
    // $200k of pay funds every goal and never borrows, so the sentence loses "debt" and gains the
    // fund accounts the surplus opens — three in all, peaking in the millions.
    expect(netWorthSummary(earning(200_000))).toBe(
      "Peaks around $8,133,554 net worth, across 3 accounts.",
    );
  });
});

describe("base adjustments — the pay it reads out for the month", () => {
  it("states one earner's monthly pay", () => {
    expect(budgetIncome(alexAlone())).toBe("$5,000/mo");
  });

  it("sums both earners' pay for a two-income household", () => {
    // Alex's $5k/mo plus Sam's job at the same pay: the read-out is the household total, so a
    // second earner is a figure the panel visibly carries, not a name it merely mentions.
    expect(budgetIncome(alexAndSam().projection)).toBe("$10,000/mo");
  });
});
