import { describe, expect, it } from "vitest";
import { Projection } from "./index";
import { nullJurisdiction } from "./jurisdiction";
import { PRIMARY_PERSON_ID, goalFundAccountId } from "./projectionBase";
import { RETIREMENT_ID } from "./ids";
import { ref } from "./scenarioInput";
import {
  PRIMARY_PERSON_REF,
  SAVINGS_REF,
  BROKERAGE_REF,
  RETIREMENT_REF,
  WELL_KNOWN_REF_IDS,
} from "./scenarioRefs";
import type { ScenarioInput } from "./scenarioInput";

/** A minimal, ref-free scenario; each test layers only the entries it exercises on top. */
const base: ScenarioInput = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 5_000_000,
  savingsReturnPct: 2,
  retirementReturnPct: 6,
  brokerageReturnPct: 5,
  sharedScheme: "proportional",
  inflationPct: 2,
  currentAge: 30,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

/** Fails the test if the build was refused — narrows the union and surfaces the reason. */
function built(input: ScenarioInput): Projection {
  const result = Projection.fromInput(input, nullJurisdiction);
  if (!result.ok) throw new Error(`expected a built projection, got: ${result.error.reason}`);
  return result.projection;
}

describe("Projection.init — the imperative half of authoring", () => {
  it("opens empty, with the counter at its start", () => {
    const p = Projection.init(base, nullJurisdiction);
    expect(p.plan.jobs).toEqual([]);
    expect(p.plan.goals).toEqual([]);
    expect(p.plan.budgetLines).toEqual([]);
    expect(p.ledger.events).toEqual([]);
    // Nothing to floor past: an empty projection is the one state provably holding no id.
    expect(p.toState().nextSeq).toBe(1);
  });

  it("keeps the scalars it was given, and projects", () => {
    const p = Projection.init({ ...base, retirementAge: 62, lifeExpectancy: 85 }, nullJurisdiction);
    expect(p.plan.retirementAge).toBe(62);
    expect(p.plan.lifeExpectancy).toBe(85);
    // A plan with no jobs and no budget still runs — it is a scenario, just an empty one.
    expect(p.run(nullJurisdiction).series.months.length).toBeGreaterThan(0);
  });

  it("is built up with the ordinary authoring methods, minting as it goes", () => {
    const p = Projection.init(base, nullJurisdiction);

    const jobId = p.addJob(PRIMARY_PERSON_ID, {
      startYear: 2026, endYear: null,
      salary: { startingSalaryCents: 9_000_000, realGrowthPct: 0 },
    });
    const goalId = p.addGoal({
      name: "Car", targetCents: 1_000_000, targetDate: 24,
      disposition: "retain", annualReturnPct: 2,
    });
    const lineId = p.addBudgetLine({
      label: "Rent", category: "needs", target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 150_000 },
    });
    const partnerId = p.marry({ month: 12, name: "Sam", birthYear: 1994 });

    // Every id off the one counter, in the shape `mint` issues, all distinct.
    const ids = [jobId, goalId, lineId, partnerId];
    expect(ids).toEqual(["job-1", "goal-2", "line-3", "person-4"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => p.run(nullJurisdiction)).not.toThrow();
  });

  it("is exactly what fromInput opens with, so the two agree on an entry-free document", () => {
    // `fromInput` IS `init` plus the entries — stated here rather than left to the reader, since
    // a drift between them would make the declarative and imperative paths mean different things.
    const viaInit = Projection.init(base, nullJurisdiction).toState();
    const viaInput = built(base).toState();
    expect(viaInput).toEqual(viaInit);
  });

  it("cannot fail, so it hands back a projection rather than a result", () => {
    // No entries means no refs to resolve and no events to gate; there is nothing to refuse.
    // The type says so — no `.ok` to narrow — and this pins the behaviour behind it.
    const p: Projection = Projection.init(base, nullJurisdiction);
    expect(p).toBeInstanceOf(Projection);
  });
});

describe("Projection.fromInput", () => {
  it("mints ids for the plan plane and resolves every account ref", () => {
    const p = built({
      ...base,
      jobs: [
        {
          ref: ref("primaryJob"),
          ownerRef: PRIMARY_PERSON_REF,
          startYear: 2026,
          endYear: null,
          salary: { startingSalaryCents: 8_000_000, realGrowthPct: 1 },
          deferral: { deferralFraction: 0.1, fundAccountRef: RETIREMENT_REF },
        },
      ],
      goals: [
        { ref: ref("emergency"), name: "Emergency", targetCents: 1_000_000, annualReturnPct: 2,
          disposition: "retain", targetDate: "asap" },
      ],
    });

    const [job] = p.plan.jobs;
    expect(job.id).toMatch(/^job-\d+$/);
    expect(job.ownerId).toBe(PRIMARY_PERSON_ID);
    // The account ref resolved to a real, well-known account id — no ref survived the build.
    expect(job.deferral?.fundAccountId).toBe(RETIREMENT_ID);

    const [goal] = p.plan.goals;
    expect(goal.id).toMatch(/^goal-\d+$/);
  });

  it("binds a declared goal ref to its derived fund account, not the goal id", () => {
    const p = built({
      ...base,
      goals: [
        { ref: ref("REF-house"), name: "House", targetCents: 5_000_000, annualReturnPct: 3,
          disposition: "retain", targetDate: "asap" },
      ],
      budgetLines: [
        { label: "House fund", category: "savings", amountSource: { kind: "fillToLimit" },
          target: { kind: "account", accountRef: ref("REF-house"), taxTreatment: "postTax" } },
      ],
    });
    const [goal] = p.plan.goals;
    const [line] = p.plan.budgetLines;
    // The contribution routes into the goal's fund account, not the goal id — the derivation
    // task 2's resolution model promises.
    expect(line.target).toEqual({
      kind: "account",
      accountId: goalFundAccountId(goal),
      taxTreatment: "postTax",
    });
  });

  it("applies events in month order regardless of array position", () => {
    // The payoff is authored FIRST but dated LAST; only a build that sorts by month before
    // applying can resolve its liability, which the loan two array-slots later creates.
    const p = built({
      ...base,
      events: [
        { type: "payOffDebt", month: 60, liabilityRef: ref("student"), accountRef: SAVINGS_REF,
          amountCents: 500_000 },
        { type: "takeLoan", ref: ref("student"), month: 0, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
      ],
    });
    // Both events landed, the loan minted before the payoff spent from it.
    const months = p.ledger.events.map((e) => e.month).sort((a, b) => a - b);
    expect(months).toEqual([0, 60]);
  });

  it("mints every id off one counter and lets a partner's nested jobs draw from it", () => {
    const p = built({
      ...base,
      events: [
        { type: "marry", ref: ref("sam"), month: 12, name: "Sam", birthYear: 1994,
          jobs: [
            { startYear: 2027, endYear: null,
              salary: { startingSalaryCents: 6_000_000, realGrowthPct: 1 },
              deferral: { deferralFraction: 0.05, fundAccountRef: RETIREMENT_REF } },
          ] },
        { type: "buyHome", month: 36, ownerRef: PRIMARY_PERSON_REF, purchasePriceCents: 40_000_000,
          downPaymentCents: 4_000_000, downPaymentSourceRefs: [SAVINGS_REF, BROKERAGE_REF],
          mortgageApr: 0.06, mortgageTermMonths: 360 },
      ],
    });
    // A run over the built scenario proves the minted ids wire up end to end.
    expect(() => p.run(nullJurisdiction)).not.toThrow();
    const partner = p.ledger.events.find((e) => e.type === "RelationshipEvent");
    if (partner?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
    const [nested] = partner.person.jobs;
    expect(nested.id).toMatch(/^job-\d+$/);
    // Ownership is implicit and belongs to the partner this very entry created — which is why a
    // nested job takes no `ownerRef` (`PartnerJobEntry`): there is no one else it could name.
    expect(nested.ownerId).toBe(partner.person.id);
    expect(nested.ownerId).not.toBe(PRIMARY_PERSON_ID);
  });

  it("refuses a refusal addEvent raises, naming the offending event and keeping nothing", () => {
    const result = Projection.fromInput(
      {
        ...base,
        events: [
          { type: "marry", ref: ref("sam"), month: 12, name: "Sam", birthYear: 1994 },
          { type: "separate", month: 24, partnerRef: ref("sam") },
          { type: "separate", month: 36, partnerRef: ref("sam") },
        ],
      },
      nullJurisdiction,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    // The second separation is index 2 in `events`; a partial projection never escapes.
    expect(result.error.eventIndex).toBe(2);
    expect(result.error.reason).toContain("already separated");
  });

  it("passes a bad ref graph straight through as a refusal", () => {
    const result = Projection.fromInput(
      {
        ...base,
        events: [
          { type: "payOffDebt", month: 12, liabilityRef: ref("student"), accountRef: SAVINGS_REF,
            amountCents: 500_000 },
          { type: "takeLoan", ref: ref("student"), month: 60, ownerRef: PRIMARY_PERSON_REF,
            openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
        ],
      },
      nullJurisdiction,
    );
    // The payoff at month 12 forward-references a loan at month 60 — refused by ref resolution
    // before anything is minted.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe("student");
    expect(result.error.eventIndex).toBe(0);
  });
});

/**
 * A document names no ids, so identity has exactly one source: the counter behind
 * `Projection`'s authoring methods. These pin that the input cannot smuggle a name past it and
 * that what it issues collides with nothing — not with the ids the engine already holds, not
 * with each other, and not with what the next authored write will mint.
 */
describe("Projection.fromInput — the engine allocates every id", () => {
  /**
   * The names {@link populated} uses. Deliberately unlike any label, person name or liability
   * kind in the document, so searching the built state for one cannot match by coincidence.
   */
  const AUTHORED_REFS = [
    "REF-dayJob",
    "REF-emergency",
    "REF-rent",
    "REF-food",
    "REF-student",
    "REF-sam",
    "REF-house",
  ];

  /** A scenario exercising every entry kind that names something durable. */
  const populated: ScenarioInput = {
    ...base,
    jobs: [
      { ref: ref("REF-dayJob"), startYear: 2026, endYear: null,
        salary: { startingSalaryCents: 9_000_000, realGrowthPct: 0 } },
    ],
    goals: [
      { ref: ref("REF-emergency"), name: "Emergency", targetCents: 1_000_000, annualReturnPct: 2,
        disposition: "retain", targetDate: "asap" },
    ],
    budgetLines: [
      { ref: ref("REF-rent"), label: "Rent", category: "needs", target: { kind: "expense" },
        amountSource: { kind: "literal", monthlyCents: 150_000 } },
      { ref: ref("REF-food"), label: "Food", category: "needs", target: { kind: "expense" },
        amountSource: { kind: "literal", monthlyCents: 60_000 } },
    ],
    events: [
      { type: "takeLoan", ref: ref("REF-student"), month: 0, ownerRef: PRIMARY_PERSON_REF,
        openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
      { type: "marry", ref: ref("REF-sam"), month: 12, name: "Sam", birthYear: 1994,
        jobs: [{ startYear: 2027, endYear: null,
          salary: { startingSalaryCents: 5_000_000, realGrowthPct: 0 } }] },
      { type: "haveChild", month: 24, name: "Kid", annualCostCents: 1_200_000 },
      { type: "buyHome", ref: ref("REF-house"), month: 36, ownerRef: PRIMARY_PERSON_REF,
        purchasePriceCents: 30_000_000, downPaymentCents: 2_000_000,
        downPaymentSourceRefs: [SAVINGS_REF], mortgageApr: 0.06, mortgageTermMonths: 360 },
    ],
  };

  /**
   * Every durable id the built scenario holds — one entry per thing NAMED, so a genuine
   * collision shows up as a duplicate.
   *
   * An event and the entity it creates deliberately share one id (`takeLoan` mints the loan's
   * event and liability as a single name, `haveChild` the event and the child, and so on), so
   * those aliases are counted once here; `sharesIdWithItsEntity` below pins that they really are
   * aliases rather than something this helper is hiding. A mortgage is the one derived id — the
   * author never names it — so it counts separately.
   */
  function allIds(p: Projection): string[] {
    const ids = [
      ...p.plan.jobs.map((j) => j.id),
      ...p.plan.goals.map((g) => g.id),
      ...p.plan.budgetLines.map((l) => l.id),
    ];
    for (const e of p.ledger.events) {
      ids.push(e.id);
      if (e.type === "RelationshipEvent") ids.push(...e.person.jobs.map((j) => j.id));
      if (e.type === "HomePurchaseEvent") ids.push(e.mortgageLiabilityId);
    }
    return ids;
  }

  /** The event↔entity aliases {@link allIds} folds together, stated rather than assumed. */
  function sharesIdWithItsEntity(p: Projection): void {
    for (const e of p.ledger.events) {
      if (e.type === "RelationshipEvent") expect(e.person.id).toBe(e.id);
      if (e.type === "ChildEvent") expect(e.childId).toBe(e.id);
      if (e.type === "LoanEvent") expect(e.liabilityId).toBe(e.id);
      if (e.type === "HomePurchaseEvent") expect(e.propertyId).toBe(e.id);
    }
  }

  it("issues every id off the counter, in the shape the allocator mints", () => {
    const p = built(populated);
    // `<kind>-<n>`, the one shape `mint` produces. A mortgage is parent-suffixed off its
    // property, so it is the single derived exception.
    for (const id of allIds(p)) {
      expect(id).toMatch(/^[a-z]+-\d+(-mortgage)?$/);
    }
    // No ref leaked through as an id: the names the document used are gone.
    for (const name of AUTHORED_REFS) expect(allIds(p)).not.toContain(name);
  });

  it("persists no ref anywhere in the built state, as an id or otherwise", () => {
    // Stronger than the id check above: a ref is input-local scaffolding, so it must not survive
    // into `Plan` or `Ledger` in ANY field — not a label, not a name, not a dangling pointer.
    // Searching the whole serialized state is the only way to state that without enumerating
    // fields, and the REF- prefix makes a hit unambiguous.
    const serialized = JSON.stringify(built(populated).toJSON());
    for (const name of AUTHORED_REFS) expect(serialized).not.toContain(name);
  });

  it("issues each id once, and never one the engine already holds", () => {
    const p = built(populated);
    sharesIdWithItsEntity(p);
    const ids = allIds(p);
    expect(new Set(ids).size).toBe(ids.length);
    // The standing accounts, the primary person and the synthetic card exist before any entry
    // applies; minting onto one would give two things a single id.
    for (const reserved of WELL_KNOWN_REF_IDS) expect(ids).not.toContain(reserved);
  });

  it("leaves the counter clear of what it issued, so later writes cannot collide", () => {
    const p = built(populated);
    const before = allIds(p);

    // Keep authoring through the same handle: `fromInput` advanced the counter as it minted, so
    // these draw from where it left off rather than re-issuing a live id.
    p.addJob(PRIMARY_PERSON_ID, {
      startYear: 2030,
      endYear: null,
      salary: { startingSalaryCents: 1_000_000, realGrowthPct: 0 },
    });
    p.addGoal({ name: "Later", targetCents: 100_000, annualReturnPct: 1,
      disposition: "retain", targetDate: "asap" });
    p.addBudgetLine({ label: "Gym", category: "wants", target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 5_000 } });
    p.takeLoan({ month: 48, ownerId: PRIMARY_PERSON_ID, openingBalanceCents: 500_000,
      apr: 0.07, kind: "auto", termMonths: 60 });

    const after = allIds(p);
    expect(new Set(after).size).toBe(after.length);
    // Everything the build issued is still there, untouched by the later mints.
    for (const id of before) expect(after).toContain(id);
  });

  it("round-trips through fromState, which is where ids that already exist belong", () => {
    // The division of labour: `fromInput` authors and mints; `fromState` (fed by `toJSON`)
    // restores state whose ids were issued earlier and floors the counter past them. A round
    // trip changes no id.
    const p = built(populated);
    const restored = Projection.fromState(
      JSON.parse(JSON.stringify(p.toJSON())),
      nullJurisdiction,
    );
    expect(allIds(restored)).toEqual(allIds(p));

    // And the restored handle keeps minting clear of them.
    restored.addBudgetLine({ label: "Books", category: "wants", target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 2_000 } });
    const ids = allIds(restored);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
