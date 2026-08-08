/**
 * @vitest-environment jsdom
 *
 * **`payChangeEditor.tsx` — the pay-change form the Base + Adjustments panel discloses.**
 *
 * Its own component and its own contract, so its own file: which earners' jobs it offers (every
 * one, not just the primary person's), which plane it writes each answer to, and the single
 * nullable draft it holds so two jobs can never be half-edited at once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import {
  PRIMARY_PERSON_ID,
  Projection,
  dollarsToCents,
  type Job,
  type Ledger,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { useTestProjection } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { BaseAdjustmentsPanel } from "./baseAdjustmentsPanel";

afterEach(cleanup);

/** The event-free ledger in the public serialized shape — the app authors a timeline through
 * `Projection`, never by seeding the engine's internal `emptyLedger`. */
const NO_EVENTS: Ledger = { events: [], nextSequenceNumber: 0 };

const incomeReadonlyDollars = (): number =>
  Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));

const openOneOff = () =>
  fireEvent.click(screen.getByRole("button", { name: /Change pay at this month/i }));
const setOneOffKind = (value: string) =>
  fireEvent.change(screen.getByLabelText("Pay change kind"), { target: { value } });
const setOneOffAmount = (dollars: number) =>
  enterNumber(screen.getByRole("spinbutton", { name: /Amount/ }), dollars);
const applyOneOff = () => fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

/**
 * Stands in for `App`: holds the one `ProjectionState` the panel writes through, and runs the
 * app's ONE projection (plan *and* ledger) that every surface is fed from.
 */
function Harness({ initial, ledger: initialLedger = NO_EVENTS }: { initial: Plan; ledger?: Ledger }) {
  const { state, transact } = useTestProjection(initial, initialLedger);
  const plan = state.scenario.plan;
  const ledger = state.scenario.ledger;
  const projection = Projection.fromState(state, usJurisdiction);
  const { series, household } = projection.run(usJurisdiction);
  const personNames = new Map<string, string>([
    [PRIMARY_PERSON_ID, plan.primary.name],
    ...ledger.events.flatMap((e) =>
      e.type === "RelationshipEvent" ? ([[e.person.id, e.person.name]] as [string, string][]) : [],
    ),
  ]);
  return (
    <>
      <BaseAdjustmentsPanel
        plan={plan}
        transact={transact}
        series={series}
        personNames={personNames}
        household={household}
        ledger={ledger}
        projection={projection}
        plannedWorkStopAge={65}
      />
      <output data-testid="primary-jobs">{JSON.stringify(plan.primary.jobs)}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
    </>
  );
}

const renderPanel = (plan: Plan, ledger?: Ledger) =>
  render(<Harness initial={plan} ledger={ledger} />);

function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}

const jobsOn = (testId: "primary-jobs" | "partner-jobs"): readonly Job[] =>
  JSON.parse(screen.getByTestId(testId).textContent || "[]") as Job[];

const partnerWithJobLedger = (monthlyDollars: number): Ledger => ({
  events: [
    {
      id: "r1",
      sequenceNumber: 0,
      type: "RelationshipEvent",
      month: 0,
      person: {
        id: "p-1",
        name: "Sam",
        birthYear: START_YEAR - 40,
        lifeExpectancy: 85,
        benefitClaimingAge: 67,
        jobs: [
          {
            id: "p-1-job-1",
            name: "Sam's job",
            ownerId: "p-1",
            startYear: START_YEAR,
            endYear: START_YEAR - 40 + 65,
            salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
          },
        ],
      },
    },
  ],
  nextSequenceNumber: 1,
});

const spin = (name: RegExp | string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/** The keyboard equivalent of a chart click. */
const selectMonth = (month: number) =>
  enterNumber(spin("Month"), month);




describe("PayChangeEditor — every earner's jobs, not just the primary person's", () => {
  // A partner's jobs ride the RelationshipEvent they joined with, not `Plan.jobs`. The control
  // once listed only the plan's jobs, so a partner's pay change had nowhere to land.
  const pickJob = (id: string) =>
    fireEvent.change(screen.getByLabelText("Job"), { target: { value: id } });

  /** Alex ($5,000/mo on the plan) and Sam ($3,000/mo on their own event). */
  const withPartner = () => renderPanel(PLAN_DEFAULTS, partnerWithJobLedger(3000));

  it("offers both members' jobs, each named by its owner", () => {
    withPartner();
    openOneOff();
    const options = Array.from(
      (screen.getByLabelText("Job") as HTMLSelectElement).options,
      (o) => o.text,
    );
    // Owner-qualified, so two jobs carrying the same title are still told apart.
    expect(options).toEqual(["Alex · Job 1", "Sam · Sam's job"]);
  });

  it("gives a partner's job a permanent raise, written back to their event", () => {
    withPartner();
    selectMonth(6);
    expect(incomeReadonlyDollars()).toBe(8000); // 5,000 + 3,000 while both work

    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setOngoing");
    setOneOffAmount(4500);
    applyOneOff();

    // It landed on the partner's job — on the LEDGER plane, not the plan.
    expect(jobsOn("partner-jobs")[0].payChanges).toEqual([
      { id: expect.any(String), month: 6, kind: "setTo", cents: dollarsToCents(4500) },
    ]);
    expect(jobsOn("primary-jobs")[0].payChanges).toBeUndefined();
    expect(incomeReadonlyDollars()).toBe(9500); // 5,000 + 4,500
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Sam/); // names whose job
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(9500); // PERSISTS — month 12 would also carry CPI
    selectMonth(5);
    expect(incomeReadonlyDollars()).toBe(8000); // before the raise, old pay
    // The list states what is authored AT the selected month, so it is empty on a month with
    // nothing on it — it is a reading of the plan, not a record of the last thing applied.
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
  });

  it("lists every adjustment standing at the month, instead of only the last applied", () => {
    // The bug: the echo was a `note` remembering the last apply, so a second adjustment
    // REPLACED the first on screen while both were stored — and it survived a change being
    // removed elsewhere. It is a reading of the plan now.
    renderPanel(PLAN_DEFAULTS, partnerWithJobLedger(3000));
    selectMonth(6);

    openOneOff();
    setOneOffAmount(2000); // bonus on Alex's job
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/bonus of \$2,000/i);

    openOneOff();
    pickJob("p-1-job-1");
    setOneOffAmount(1000); // a second bonus, on Sam's job, at the SAME month
    applyOneOff();

    const listed = screen.getByTestId("pay-change-route").textContent ?? "";
    expect(listed).toMatch(/bonus of \$2,000/i); // the first one is still named
    expect(listed).toMatch(/bonus of \$1,000/i); // and so is the second
    expect(screen.getAllByRole("listitem").filter((li) => /bonus of/i.test(li.textContent ?? "")))
      .toHaveLength(2);
  });

  it("lists two bonuses on the SAME job in the same month as two entries", () => {
    // The sharpest form of the collision: same job, same month, same scope — which the old
    // `${jobId}:${scope}` key made indistinguishable, so React kept one row and the second
    // bonus overwrote the first's text.
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);

    openOneOff();
    setOneOffAmount(2000);
    applyOneOff();

    openOneOff();
    setOneOffAmount(1500);
    applyOneOff();

    const listed = screen.getByTestId("pay-change-route").textContent ?? "";
    expect(listed).toMatch(/bonus of \$2,000/i);
    expect(listed).toMatch(/bonus of \$1,500/i);
    expect(
      screen.getAllByRole("listitem").filter((li) => /bonus of/i.test(li.textContent ?? "")),
    ).toHaveLength(2);
  });

  it("keeps both stored on the job, and pays their sum", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);

    openOneOff();
    setOneOffAmount(2000);
    applyOneOff();
    openOneOff();
    setOneOffAmount(1500);
    applyOneOff();

    // Two authored facts with distinct ids, neither collapsed into the other.
    const overrides = jobsOn("primary-jobs")[0].incomeOverrides ?? [];
    expect(overrides).toHaveLength(2);
    expect(new Set(overrides.map((o) => o.id)).size).toBe(2);
    expect(overrides.map((o) => o.cents)).toEqual([dollarsToCents(2000), dollarsToCents(1500)]);
    // $5,000 standing pay for the month + both bonuses — what the projection actually pays.
    expect(incomeReadonlyDollars()).toBe(5000 + 2000 + 1500);
  });

  it("shows a permanent change and a one-off at the same month side by side", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);

    openOneOff();
    setOneOffKind("setOngoing");
    setOneOffAmount(6000);
    applyOneOff();

    openOneOff();
    setOneOffKind("addBonus");
    setOneOffAmount(500);
    applyOneOff();

    const listed = screen.getByTestId("pay-change-route").textContent ?? "";
    // Both stored on the same job at the same month, and both scopes named.
    expect(listed).toMatch(/pay set to \$6,000.*onward \(ongoing\)/is);
    expect(listed).toMatch(/bonus of \$500.*at month 6/is);
  });

  /**
   * The regression this pins: a permanent raise and a missed paycheck authored at the SAME
   * month. The raise sets the salary state, the override changes only that month's payment, and
   * both must stay separately visible here — the surface where both are authored.
   */
  it("names a same-month raise and missed paycheck as two entries, and pays $0", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(10);

    openOneOff();
    setOneOffKind("setOngoing");
    setOneOffAmount(6000);
    applyOneOff();

    openOneOff();
    setOneOffKind("setTo"); // "set pay this month" — 0 is a missed paycheck
    setOneOffAmount(0);
    applyOneOff();

    const listed = screen.getByTestId("pay-change-route").textContent ?? "";
    expect(listed).toMatch(/pay set to \$6,000.*onward \(ongoing\)/is);
    expect(listed).toMatch(/pay set to \$0.*at month 10/is);
    expect(screen.getAllByRole("listitem").filter((li) => /at month 10|onward/.test(li.textContent ?? "")))
      .toHaveLength(2);

    // What the projection pays for the month — the miss wins the month, not the raise.
    expect(incomeReadonlyDollars()).toBe(0);
  });

  it("pays the raised salary from the month after the missed one", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(10);
    openOneOff();
    setOneOffKind("setOngoing");
    setOneOffAmount(6000);
    applyOneOff();
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(0);
    applyOneOff();

    // The $0 month left no mark on the salary: an override settles nothing beyond its month.
    selectMonth(11);
    expect(incomeReadonlyDollars()).toBe(6000);
    selectMonth(9);
    expect(incomeReadonlyDollars()).toBe(5000);
  });

  it("keeps both stored on the job, each with its own identity", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(10);
    openOneOff();
    setOneOffKind("setOngoing");
    setOneOffAmount(6000);
    applyOneOff();
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(0);
    applyOneOff();

    const job = jobsOn("primary-jobs")[0];
    // Two different collections, two different kinds of fact — neither collapsed into the other.
    expect(job.payChanges).toEqual([
      { id: expect.any(String), month: 10, kind: "setTo", cents: dollarsToCents(6000) },
    ]);
    expect(job.incomeOverrides).toEqual([
      { id: expect.any(String), month: 10, kind: "setTo", cents: 0 },
    ]);
    expect(job.payChanges![0].id).not.toBe(job.incomeOverrides![0].id);
  });

  it("defers a month-0 raise to month 1 while a month-0 miss lands on month 0", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(0);

    openOneOff();
    setOneOffKind("setOngoing");
    setOneOffAmount(6000);
    applyOneOff();
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(0);
    applyOneOff();

    // Month 0 is the stated current salary's, so the raise cannot displace it — but the
    // one-month adjustment is NOT deferred, and month 0 pays nothing.
    expect(incomeReadonlyDollars()).toBe(0);
    selectMonth(1);
    expect(incomeReadonlyDollars()).toBe(6000);
  });

  it("stops naming an adjustment once it is removed from the plan", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);
    openOneOff();
    setOneOffAmount(2000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route")).toBeTruthy();

    // Removing it anywhere removes it here: the echo was outliving its own change before.
    selectMonth(7);
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
    selectMonth(6);
    expect(screen.getByTestId("pay-change-route")).toBeTruthy();
  });

  it("gives a partner's job a one-month bonus, then a missed paycheck", () => {
    withPartner();
    selectMonth(6);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffAmount(2000); // default kind: bonus on top
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(10_000); // 5,000 + 3,000 + 2,000, that month only
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(8000); // and only that month

    // A missed paycheck on the partner's job zeroes THEIR wages, leaving the primary's.
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setTo");
    setOneOffAmount(0);
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(5000);

    // Both overrides are on the partner's job, and the earlier one survived the later.
    expect(jobsOn("partner-jobs")[0].incomeOverrides).toEqual([
      { id: expect.any(String), month: 6, kind: "addBonus", cents: dollarsToCents(2000) },
      { id: expect.any(String), month: 7, kind: "setTo", cents: 0 },
    ]);
  });

  it("cuts a partner's ongoing pay, and corrects a single month of it", () => {
    // The remaining two kinds on a partner's job: a permanent CUT (a pay change can go down —
    // hence "pay change", not "raise") and a one-month correction to a non-zero figure.
    withPartner();
    selectMonth(6);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("changeOngoing");
    setOneOffAmount(-800);
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(7200); // 5,000 + (3,000 − 800), ongoing

    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setTo");
    setOneOffAmount(1000); // this month they were paid $1,000, cut and all
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(6000); // 5,000 + 1,000, this month only
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(7200); // the cut still stands; the correction does not

    const job = jobsOn("partner-jobs")[0];
    expect(job.payChanges).toEqual([{ id: expect.any(String), month: 6, kind: "changeBy", cents: -dollarsToCents(800) }]);
    expect(job.incomeOverrides).toEqual([{ id: expect.any(String), month: 6, kind: "setTo", cents: dollarsToCents(1000) }]);
  });

  it("changes only the job it was applied to, and nothing else about it", () => {
    withPartner();
    const partnerBefore = jobsOn("partner-jobs")[0];
    selectMonth(6);
    openOneOff();
    setOneOffKind("changeOngoing"); // defaults to the FIRST job — the primary person's
    setOneOffAmount(1000);
    applyOneOff();

    // The primary's job took the change; the partner's is untouched, byte for byte.
    expect(jobsOn("primary-jobs")[0].payChanges).toEqual([
      { id: expect.any(String), month: 6, kind: "changeBy", cents: dollarsToCents(1000) },
    ]);
    expect(jobsOn("partner-jobs")[0]).toEqual(partnerBefore);
  });

  it("preserves the rest of a partner's job — name, span, salary, deferral, other adjustments", () => {
    withPartner();
    selectMonth(3);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffAmount(500);
    applyOneOff();

    selectMonth(9);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setOngoing");
    setOneOffAmount(3500);
    applyOneOff();

    const job = jobsOn("partner-jobs")[0];
    expect(job.id).toBe("p-1-job-1");
    expect(job.name).toBe("Sam's job");
    expect(job.ownerId).toBe("p-1");
    expect(job.startYear).toBe(START_YEAR);
    expect(job.endYear).toBe(START_YEAR - 40 + 65);
    expect(job.salary).toEqual({ startingSalaryCents: dollarsToCents(36_000), currentSalaryCents: dollarsToCents(36_000), realGrowthPct: 0 });
    // The bonus from the first adjustment survived the second, which is a different kind.
    expect(job.incomeOverrides).toEqual([{ id: expect.any(String), month: 3, kind: "addBonus", cents: dollarsToCents(500) }]);
    expect(job.payChanges).toEqual([{ id: expect.any(String), month: 9, kind: "setTo", cents: dollarsToCents(3500) }]);
  });
});

describe("PayChangeEditor — draft state (single nullable draft)", () => {
  const kindSelect = () => screen.getByLabelText("Pay change kind") as HTMLSelectElement;
  const amountValue = () => Number(spin(/Amount/).value);
  const cancel = () => fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

  it("opens with a clean default draft — a bonus of $0, no job pre-picked", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    expect(kindSelect().value).toBe("addBonus");
    expect(amountValue()).toBe(0);
  });

  it("discards unsaved values on cancel", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(9000);
    cancel();
    expect(screen.queryByLabelText("Pay change kind")).toBeNull();
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
  });

  it("reopens clean after a cancel — the discarded draft does not leak back", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(9000);
    cancel();
    openOneOff();
    expect(kindSelect().value).toBe("addBonus"); // not the cancelled "setTo"
    expect(amountValue()).toBe(0); // not the cancelled 9000
  });

  it("defaults to the first job with several jobs, unless another is picked", () => {
    const twoJobs: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: [...PLAN_DEFAULTS.primary.jobs, { ...PLAN_DEFAULTS.primary.jobs[0], id: "job-2" }],
      },
    };
    renderPanel(twoJobs);
    selectMonth(6);

    openOneOff();
    expect(screen.getByLabelText("Job")).toBeTruthy();
    setOneOffAmount(2000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Job 1/); // defaulted

    openOneOff();
    fireEvent.change(screen.getByLabelText("Job"), { target: { value: "job-2" } });
    setOneOffAmount(1000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Job 2/); // honoured
  });
});
