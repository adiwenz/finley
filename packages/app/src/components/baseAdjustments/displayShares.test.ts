/**
 * Whole dollars that add up.
 *
 * The engine's split is exact to the cent; the bug was never in the split but in printing it.
 * Round each person's share on its own and $6,641 of shared spending becomes $3,321 and $3,321 —
 * a dollar the reader can see appear the moment they toggle from Combined to a person, and cannot
 * account for. These pin that the displayed parts sum to the displayed whole, at every split the
 * product allows, without a cent of the underlying allocation moving.
 */

import { describe, expect, it } from "vitest";
import { Projection, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById, presetState } from "../../presets";
import { apportionDisplayCents, toDisplayCents } from "./displayShares";
import { buildCashFlowChartData } from "./cashFlowChartData";
import { NET_KEY, SPENDING_NEED_KEY, buildCashFlowChartModel } from "./cashFlowChartModel";

/** The engine's own cumulative-rounded split, so the parts are exact and sum to the total. */
function splitCents(totalCents: number, percents: readonly number[]): number[] {
  let taken = 0;
  let cumulativePercent = 0;
  return percents.map((p, i) => {
    cumulativePercent += p;
    const upto = i === percents.length - 1 ? totalCents : Math.round((totalCents * cumulativePercent) / 100);
    const share = upto - taken;
    taken = upto;
    return share;
  });
}

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

describe("apportionDisplayCents", () => {
  it("prints whole dollars", () => {
    for (const c of apportionDisplayCents(664_100, [332_050, 332_050])) expect(c % 100).toBe(0);
  });

  it("holds the reported case: $6,641 split evenly is $3,321 and $3,320", () => {
    // Not two $3,321s. One of them absorbs the odd dollar, and which one is decided by the
    // remainder rather than by which view the reader happened to open.
    const shares = apportionDisplayCents(664_050, [332_025, 332_025]);
    expect(sum(shares)).toBe(664_100);
    expect(shares).toEqual([332_100, 332_000]);
  });

  it("holds the other reported case: $6,078 as $4,254 and $1,823", () => {
    const total = 607_800 + 37;
    const parts = splitCents(total, [70, 30]);
    const shares = apportionDisplayCents(total, parts);
    expect(sum(shares)).toBe(toDisplayCents(total));
  });

  it("sums to the rounded total at every split the product allows", () => {
    const splits = [
      [50, 50],
      [70, 30],
      [65, 35],
      [0, 100],
      [100, 0],
    ];
    // Odd dollars, odd cents, and the halves that decide a rounding rule.
    const totals = [664_100, 664_150, 664_099, 607_837, 1, 99, 50, 150, 0];
    for (const percents of splits) {
      for (const total of totals) {
        const shares = apportionDisplayCents(total, splitCents(total, percents));
        expect(sum(shares)).toBe(toDisplayCents(total));
        for (const c of shares) expect(c % 100).toBe(0);
      }
    }
  });

  it("keeps an extreme split extreme — nobody is handed a dollar they do not owe", () => {
    expect(apportionDisplayCents(664_137, [0, 664_137])).toEqual([0, 664_100]);
    expect(apportionDisplayCents(664_137, [664_137, 0])).toEqual([664_100, 0]);
  });

  it("handles a negative total, which the net view has every month it draws one", () => {
    const parts = [-332_025, -332_025];
    const shares = apportionDisplayCents(-664_050, parts);
    expect(sum(shares)).toBe(toDisplayCents(-664_050));
  });

  it("handles one share negative and the other positive", () => {
    const shares = apportionDisplayCents(100_037, [-50_013, 150_050]);
    expect(sum(shares)).toBe(toDisplayCents(100_037));
  });

  it("breaks a tie the same way every time, by position", () => {
    // Two identical remainders and one dollar to place. Deterministic, and explainable without
    // knowing anything about the people: the earlier share takes it.
    expect(apportionDisplayCents(100_050, [50_025, 50_025])).toEqual([50_100, 50_000]);
    expect(apportionDisplayCents(100_050, [50_025, 50_025])).toEqual(
      apportionDisplayCents(100_050, [50_025, 50_025]),
    );
  });

  it("leaves shares that are not a partition of the total to round on their own", () => {
    // A household figure carrying something charged to nobody. Scaling the people up to close
    // that gap would put money on them that the engine never charged them.
    expect(apportionDisplayCents(900_000, [100_050, 100_050])).toEqual([100_100, 100_100]);
  });

  it("reports nothing for nobody", () => {
    expect(apportionDisplayCents(664_100, [])).toEqual([]);
  });

  it("changes no cents of the engine's own split", () => {
    // The whole point of the seam: the parts going in are untouched by the dollars coming out.
    const parts = splitCents(664_137, [65, 35]);
    const before = [...parts];
    apportionDisplayCents(664_137, parts);
    expect(parts).toEqual(before);
    expect(sum(before)).toBe(664_137);
  });
});

/**
 * The same promise where the reader meets it: the figures the chart's rows carry, which the
 * table, the tooltip and the a11y moments all read from the same place.
 */
describe("the chart's own rows reconcile between Combined and each person", () => {
  const dataFor = (id: string) =>
    buildCashFlowChartData(
      Projection.fromState(presetState(presetById(id)), usJurisdiction).run(usJurisdiction).series,
    );

  const reconciles = (id: string) => {
    const data = dataFor(id);
    const combined = buildCashFlowChartModel(data, { view: "inflows" });
    const perPerson = data.netOwners.map((pid) =>
      buildCashFlowChartModel(data, { view: "inflows", ownerId: pid }),
    );
    const combinedNet = buildCashFlowChartModel(data, { view: "net" });
    const perPersonNet = data.netOwners.map((pid) =>
      buildCashFlowChartModel(data, { view: "net", ownerId: pid }),
    );
    let checked = 0;
    for (const [i, row] of combined.rows.entries()) {
      // Only where the engine's own figures partition the household's. They usually do, and where
      // they do not — a month whose obligations went unfunded, an estate settling — the parts are
      // not a split of the whole and no display rule may pretend otherwise.
      const exactNeed = sum(data.netOwners.map((pid) => data.rows[i]!.spendingNeedCentsByPerson[pid] ?? 0));
      if (Math.abs(exactNeed - data.rows[i]!.spendingNeedCents) < 100) {
        expect(sum(perPerson.map((m) => m.rows[i]![SPENDING_NEED_KEY]!))).toBe(
          toDisplayCents(row[SPENDING_NEED_KEY]!),
        );
        checked++;
      }
      const exactNet = sum(data.netOwners.map((pid) => data.rows[i]!.netCentsByPerson[pid] ?? 0));
      if (Math.abs(exactNet - data.rows[i]!.netCents) < 100) {
        expect(sum(perPersonNet.map((m) => m.rows[i]![NET_KEY]!))).toBe(
          toDisplayCents(combinedNet.rows[i]![NET_KEY]!),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(data.rows.length);
  };

  it("reconciles an even split, month by month, for the whole horizon", () => {
    reconciles("partner-even-split");
  });

  it("reconciles an authored 70/30", () => {
    reconciles("partner-uneven-split");
  });

  it("reconciles across a sequential household's partner transitions", () => {
    // Three people, only ever two at once, and a month where one leaves and the shares move.
    reconciles("partner-sequential");
  });

  it("leaves a month the parts do not partition alone, rather than forcing it", () => {
    // The chart's documented treatment of withdrawals means the per-person figures are not always
    // a split of the household's — a month can fund obligations from accounts the household line
    // never counted. Where that happens the shares each round on their own, which is a visible
    // dollar of disagreement and still the honest answer: closing it would move money onto
    // somebody the engine never charged.
    const data = dataFor("partner-sequential");
    const odd = data.rows.filter(
      (r) =>
        Math.abs(sum(data.netOwners.map((pid) => r.netCentsByPerson[pid] ?? 0)) - r.netCents) >= 100,
    );
    expect(odd.length).toBeGreaterThan(0);
    for (const row of odd) {
      const i = data.rows.indexOf(row);
      for (const pid of data.netOwners) {
        const model = buildCashFlowChartModel(data, { view: "net", ownerId: pid });
        expect(model.rows[i]![NET_KEY]).toBe(toDisplayCents(row.netCentsByPerson[pid] ?? 0));
      }
    }
  });

  it("still charges a person the engine reported nothing for with nothing", () => {
    const data = dataFor("partner-sequential");
    const nobody = buildCashFlowChartModel(data, { view: "inflows", ownerId: "nobody" });
    expect(nobody.rows.every((r) => r[SPENDING_NEED_KEY] === 0)).toBe(true);
  });

  it("leaves the household's own figures exactly as the engine stated them", () => {
    // The adjustment is the person's, never the household's — a combined row is still the
    // engine's cents, so nothing rounds twice on the way to the reader.
    const data = dataFor("partner-uneven-split");
    const combined = buildCashFlowChartModel(data, { view: "inflows" });
    for (const [i, row] of data.rows.entries()) {
      expect(combined.rows[i]![SPENDING_NEED_KEY]).toBe(row.spendingNeedCents);
    }
  });

  it("keeps a person's displayed share inside a dollar of their exact one", () => {
    // Reconciling must not be an excuse to move real money around: the dollar the apportionment
    // places lands on the share whose remainder earned it, never anywhere further.
    const data = dataFor("partner-uneven-split");
    for (const pid of data.netOwners) {
      const model = buildCashFlowChartModel(data, { view: "inflows", ownerId: pid });
      for (const [i, row] of data.rows.entries()) {
        const exact = row.spendingNeedCentsByPerson[pid] ?? 0;
        expect(Math.abs(model.rows[i]![SPENDING_NEED_KEY]! - exact)).toBeLessThan(100);
      }
    }
  });
});

describe("toDisplayCents", () => {
  it("rounds half away from zero, the way the dollar formatter does", () => {
    expect(toDisplayCents(150)).toBe(200);
    expect(toDisplayCents(-150)).toBe(-200);
    expect(toDisplayCents(dollarsToCents(12) + 49)).toBe(dollarsToCents(12));
  });
});
