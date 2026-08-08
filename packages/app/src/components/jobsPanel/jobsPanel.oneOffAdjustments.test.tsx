/**
 * @vitest-environment jsdom
 *
 * **A bonus and a missed paycheck — pay that moves for exactly one month.**
 *
 * Separate from a raise in every way that matters to this panel: it rides the chart as a
 * one-month spike rather than a step, it stacks (two bonuses in a month are two adjustments, not
 * a replacement), and removing one must leave both its siblings and any permanent change dated
 * the same month standing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  dollarsToCents,
  type Plan,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import {
  Harness,
  authored,
  headline,
  timeline,
} from "./jobsPanel.testUtils";

afterEach(cleanup);


describe("JobsPanel — one-month adjustments show on the job", () => {
  /**
   * A bonus used to be COUNTED in the row's subtitle and shown nowhere else on the panel: not on
   * the chart, not in the list, not removable from here. The projection paid it and the graphs
   * below drew it, so the one surface that authors a job's pay was the one surface that denied
   * a part of it existed.
   *
   * It rides the pay series as a ONE-MONTH spike: the month genuinely pays more, and the width
   * is what keeps it from reading as a raise immediately reversed.
   */
  const BONUS = { id: "adjustment-10", month: 12, kind: "addBonus", cents: dollarsToCents(4000) } as const;
  const withBonus: Plan = {
    ...PLAN_DEFAULTS,
    primary: {
      ...PLAN_DEFAULTS.primary,
      jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({ ...j, incomeOverrides: [BONUS] })),
    },
  };
  /** What the chart marks: `[month, cents]` per one-off, off the hidden data mirror. */
  const oneOffMarks = (): [number, number][] =>
    JSON.parse(screen.getByTestId("pay-chart-one-offs").textContent || "[]");

  it("marks the bonus month on the chart, at what that month actually pays", () => {
    render(<Harness initial={withBonus} />);
    // $5,000 standing pay grown a year at 3% CPI ($5,150), plus the $4,000 bonus.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 4000)]]);
  });

  it("leaves the pay staircase alone — a bonus is not a raise", () => {
    render(<Harness initial={withBonus} />);
    // The seam is the staircase's one authored discontinuity; a bonus must not create another.
    expect(Number(screen.getByTestId("pay-chart-seam").textContent)).toBe(0);
    expect(headline("Job 1")).toBe("$5,000/mo");
  });

  it("lists it in the pay history, in date order among the permanent changes", () => {
    const withBoth: Plan = {
      ...withBonus,
      primary: {
        ...withBonus.primary,
        jobs: withBonus.primary.jobs.map((j) => ({
          ...j,
          payChanges: [{ id: "adjustment-11", month: 24, kind: "setTo", cents: dollarsToCents(7000) }],
        })),
      },
    };
    render(<Harness initial={withBoth} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    const bonusAt = rows.findIndex((t) => /Bonus \$4,000/.test(t));
    const raiseAt = rows.findIndex((t) => /Pay set to \$7,000/.test(t));
    expect(bonusAt).toBeGreaterThanOrEqual(0);
    // Month 12 before month 24 — one list in date order, not two lists.
    expect(bonusAt).toBeLessThan(raiseAt);
    // Quoted as what THAT month pays, and said to be one month only.
    expect(rows[bonusAt]).toMatch(/this month only/i);
    expect(rows[bonusAt]).toMatch(/\$9,150 this month/);
  });

  it("removes it from the job, without touching the permanent changes", () => {
    const withBoth: Plan = {
      ...withBonus,
      primary: {
        ...withBonus.primary,
        jobs: withBonus.primary.jobs.map((j) => ({
          ...j,
          payChanges: [{ id: "adjustment-12", month: 24, kind: "setTo", cents: dollarsToCents(7000) }],
        })),
      },
    };
    render(<Harness initial={withBoth} />);
    fireEvent.click(
      // Named by what it is, so stacked siblings sharing a month are separately clickable.
      screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i }),
    );
    expect(authored().plan.primary.jobs[0].incomeOverrides).toBeUndefined();
    expect(authored().plan.primary.jobs[0].payChanges).toHaveLength(1);
    expect(oneOffMarks()).toEqual([]);
  });

  it("stacks two bonuses in one month instead of the second replacing the first", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);

    // Both listed, each on its own row, and the chart marks the month at the FULL stack:
    // $5,150 grown pay + $4,000 + $1,000.
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(rows.filter((t) => /Bonus \$4,000/.test(t))).toHaveLength(1);
    expect(rows.filter((t) => /Bonus \$1,000/.test(t))).toHaveLength(1);
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 4000 + 1000)]]);
  });

  it("quotes each stacked row at the running total, not all of them at the same figure", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    // The fold, shown: $9,150 after the first, $10,150 after the second.
    expect(rows.find((t) => /Bonus \$4,000/.test(t))).toMatch(/\$9,150 this month/);
    expect(rows.find((t) => /Bonus \$1,000/.test(t))).toMatch(/\$10,150 this month/);
  });

  it("removes one of a month's stacked adjustments and leaves its sibling standing", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i }));

    // By id: the month keeps the other one. Removing by month would have taken both.
    expect(authored().plan.primary.jobs[0].incomeOverrides?.map((o) => o.id)).toEqual(["a2"]);
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 1000)]]);
  });

  it("gives two adjustments in one month distinct React identity", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "setTo", cents: dollarsToCents(2000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    // Two rows and two separately-addressable Remove buttons — the shape a shared key
    // (`jobId:scope`, or the month) collapsed into one.
    expect(screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Remove Pay this month \$2,000 at age 36 on Job 1/i }),
    ).toBeTruthy();
    // A setTo authored after a bonus discards it — the engine's ordering, shown.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(2000)]]);
  });

  it("stacks a bonus on top of a permanent raise dated the same month", () => {
    const both: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        payChanges: [{ id: "p1", month: 12, kind: "setTo", cents: dollarsToCents(7000) }],
        incomeOverrides: [{ id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) }],
        })),
      },
    };
    render(<Harness initial={both} />);
    // The raise sets the month's pay and the bonus adds to THAT, not to the old salary.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(11000)]]);
  });

  /**
   * A raise and a missed paycheck dated the same month. The engine's rule is that the pay
   * change sets the salary state and the override then changes only that month's payment, so
   * the job's own surfaces have to show both facts rather than one cancelling the other.
   */
  const raiseAndMissed: Plan = {
    ...PLAN_DEFAULTS,
    primary: {
      ...PLAN_DEFAULTS.primary,
      jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
      ...j,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "setTo", cents: 0 }],
      })),
    },
  };

  it("marks the missed month at $0 on the chart, though the raise is in force there", () => {
    render(<Harness initial={raiseAndMissed} />);
    // The chart folds the override over the RAISED salary — and $6,000 set to $0 is $0.
    expect(oneOffMarks()).toEqual([[10, 0]]);
  });

  it("lists the raise and the missed paycheck as two rows, not one", () => {
    render(<Harness initial={raiseAndMissed} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");

    // The raise quotes the salary it establishes; the missed month quotes what it pays.
    expect(rows.find((t) => /Pay set to \$6,000/.test(t))).toMatch(/\$6,000\/mo/);
    expect(rows.find((t) => /Missed paycheck/.test(t))).toMatch(/\$0 this month/);
  });

  it("removes the missed paycheck without touching the raise, and vice versa", () => {
    const { unmount } = render(<Harness initial={raiseAndMissed} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Remove Missed paycheck this month at age 35 on Job 1/i }),
    );
    expect(authored().plan.primary.jobs[0].incomeOverrides).toBeUndefined();
    expect(authored().plan.primary.jobs[0].payChanges?.map((c) => c.id)).toEqual(["p1"]);
    unmount();

    // The other direction: dropping the raise leaves the missed month standing.
    render(<Harness initial={raiseAndMissed} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age 35 on Job 1/i }));
    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
    expect(authored().plan.primary.jobs[0].incomeOverrides?.map((o) => o.id)).toEqual(["a1"]);
  });

  it("keeps a month-0 raise deferred while the month-0 miss lands on month 0", () => {
    const atNow: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        payChanges: [{ id: "p1", month: 0, kind: "setTo", cents: dollarsToCents(6000) }],
        incomeOverrides: [{ id: "a1", month: 0, kind: "setTo", cents: 0 }],
        })),
      },
    };
    render(<Harness initial={atNow} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");

    // The raise says it starts next month and quotes the month it starts; the miss is now.
    expect(rows.find((t) => /Pay set to \$6,000/.test(t))).toMatch(/from next month/i);
    expect(rows.find((t) => /Missed paycheck/.test(t))).toMatch(/\$0 this month/);
    expect(oneOffMarks()).toEqual([[0, 0]]);
    // The headline is still the stated current salary — a deferred raise has not moved it.
    expect(headline("Job 1")).toBe("$5,000/mo now");
  });

  it("describes a missed paycheck as one, not as a $0 bonus", () => {
    const missed: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [{ id: "adjustment-13", month: 12, kind: "setTo", cents: 0 }],
        })),
      },
    };
    render(<Harness initial={missed} />);
    expect(timeline("Job 1").getByText(/Missed paycheck this month/i)).toBeTruthy();
    expect(oneOffMarks()).toEqual([[12, 0]]);
  });
});
