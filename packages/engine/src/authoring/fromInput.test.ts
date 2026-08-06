import { describe, expect, it } from "vitest";
import { AGE_LIMITS, MAX_AGE, MAX_LIVED_AGE, Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { PRIMARY_PERSON_ID, goalFundAccountId } from "../compile/projectionBase";
import { RETIREMENT_ID } from "../plan/ids";
import { ref } from "../input/scenarioInput";
import {
  PRIMARY_PERSON_REF,
  SAVINGS_REF,
  BROKERAGE_REF,
  RETIREMENT_REF,
  WELL_KNOWN_REF_IDS,
} from "../input/scenarioRefs";
import type { ScenarioInput } from "../input/scenarioInput";

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
  birthYear: 2026 - 30,
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
    expect(p.plan.primary.jobs).toEqual([]);
    expect(p.plan.goals).toEqual([]);
    expect(p.plan.budgetLines).toEqual([]);
    expect(p.ledger.events).toEqual([]);
    // Nothing to floor past: an empty projection is the one state provably holding no id.
    expect(p.toState().nextSeq).toBe(1);
  });

  it("keeps the scalars it was given, and projects", () => {
    const p = Projection.init({ ...base, birthYear: 2026 - 41, lifeExpectancy: 85 }, nullJurisdiction);
    expect(2026 - p.plan.primary.birthYear).toBe(41);
    expect(p.plan.primary.lifeExpectancy).toBe(85);
    // A plan with no jobs and no budget still runs — it is a scenario, just an empty one.
    expect(p.run(nullJurisdiction).series.months.length).toBeGreaterThan(0);
  });

  it("is built up with the ordinary authoring methods, minting as it goes", () => {
    const p = Projection.init(base, nullJurisdiction);

    const jobId = p.addJob(PRIMARY_PERSON_ID, {
      startYear: 2026, endYear: 2060,
      salary: { startingSalaryCents: 9_000_000, currentSalaryCents: 9_000_000, realGrowthPct: 0 },
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

  it("hands back a projection rather than a result — no entries, so nothing to refuse", () => {
    // No entries means no refs to resolve and no events to gate. The type says so — no `.ok` to
    // narrow — and this pins the behaviour behind it. The one thing it still refuses is an
    // unprojectable age, and it does that by throwing rather than by widening this return type.
    const p: Projection = Projection.init(base, nullJurisdiction);
    expect(p).toBeInstanceOf(Projection);
  });

  it("refuses an age past its maximum — the horizon is simulated month by month", () => {
    expect(() => Projection.init({ ...base, lifeExpectancy: 950 }, nullJurisdiction)).toThrow(
      /lifeExpectancy 950/,
    );
    // Every age-valued scalar is bounded, each at ITS OWN ceiling rather than one shared number.
    // An age already lived stops a year below the ceiling: 120 leaves no month to project.
    expect(() =>
      Projection.init({ ...base, birthYear: 2026 - MAX_AGE }, nullJurisdiction),
    ).toThrow(/119/);
    // And the claiming age stops at the top of the legal window, well below either.
    expect(() => Projection.init({ ...base, benefitClaimingAge: 71 }, nullJurisdiction)).toThrow(/70/);
  });

  it("accepts each ceiling itself — the bound refuses what is PAST it, not what reaches it", () => {
    const p = Projection.init(
      { ...base, birthYear: 2026 - MAX_LIVED_AGE, lifeExpectancy: MAX_AGE,
        benefitClaimingAge: AGE_LIMITS.benefitClaimingAge },
      nullJurisdiction,
    );
    expect(p.plan.primary.lifeExpectancy).toBe(120);
    expect(2026 - p.plan.primary.birthYear).toBe(119);
    // One year of plan left — the reason a lived age stops one short of the ceiling.
    expect(p.run(nullJurisdiction).series.months.length).toBe(12);
  });

  it("refuses an over-large age on a later edit too, leaving the projection as it was", () => {
    const p = Projection.init(base, nullJurisdiction);
    expect(() => p.updatePlan({ lifeExpectancy: 950 })).toThrow(/950/);
    expect(p.plan.primary.lifeExpectancy).toBe(90);
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
          endYear: 2060,
          salary: { startingSalaryCents: 8_000_000, currentSalaryCents: 8_000_000, realGrowthPct: 1 },
          deferral: { deferralFraction: 0.1, fundAccountRef: RETIREMENT_REF },
        },
      ],
      goals: [
        { ref: ref("emergency"), name: "Emergency", targetCents: 1_000_000, annualReturnPct: 2,
          disposition: "retain", targetDate: "asap" },
      ],
    });

    const [job] = p.plan.primary.jobs;
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
            { startYear: 2027, endYear: 2060,
              salary: { startingSalaryCents: 6_000_000, currentSalaryCents: 6_000_000, realGrowthPct: 1 },
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

  it("refuses a document stating an age past the maximum, with a reason rather than a throw", () => {
    // A document is data, so an unprojectable age reads back like every other thing wrong with
    // one: `{ ok: false }` and a reason naming the field. Nothing is minted.
    const result = Projection.fromInput({ ...base, lifeExpectancy: 950 }, nullJurisdiction);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.reason).toMatch(/lifeExpectancy 950.*120/);
  });

  it("refuses a partner older than the maximum — a partner is a person, held to the same bound", () => {
    // Authored as a birth YEAR, so the age is read against the plan's frozen "now" (2026).
    const result = Projection.fromInput(
      { ...base, events: [{ type: "marry", month: 12, name: "Sam", birthYear: 1850 }] },
      nullJurisdiction,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.reason).toMatch(/partner/);
    expect(result.error.eventIndex).toBe(0);
  });

  it("holds a partner's claiming age to its ceiling — the only target age they carry", () => {
    const marryWith = (extra: Record<string, number>) =>
      Projection.fromInput(
        { ...base, events: [{ type: "marry", month: 12, name: "Sam", birthYear: 1994, ...extra }] },
        nullJurisdiction,
      );
    expect(marryWith({ benefitClaimingAge: 71 }).ok).toBe(false);
    expect(marryWith({ benefitClaimingAge: AGE_LIMITS.benefitClaimingAge }).ok).toBe(true);
    // A partner has no retirement age at all any more: their jobs say when they stop.
    expect(marryWith({}).ok).toBe(true);
  });

  it("refuses a job whose start or end age outruns a life", () => {
    // A job is authored in calendar years, so its ages are read against its OWNER's birth year —
    // here the primary's, `startYear − currentAge` (1996).
    const withJob = (startYear: number, endYear: number) =>
      Projection.fromInput(
        {
          ...base,
          jobs: [{
            ownerRef: PRIMARY_PERSON_REF, startYear, endYear,
            salary: { startingSalaryCents: 100_000, currentSalaryCents: 100_000, realGrowthPct: 0 },
          }],
        },
        nullJurisdiction,
      );
    expect(withJob(1996 + 200, 1996 + 201).ok).toBe(false); // starts at 200
    expect(withJob(2026, 1996 + 200).ok).toBe(false); // ends at 200
    // The ceiling itself is fine.
    expect(withJob(2026, 1996 + MAX_LIVED_AGE).ok).toBe(true);
  });

  it("takes a partner within the bound, ages and all", () => {
    const p = built({
      ...base,
      events: [
        { type: "marry", month: 12, name: "Sam", birthYear: 1994, benefitClaimingAge: 70 },
      ],
    });
    expect(p.ledger.events).toHaveLength(1);
  });
});

/**
 * A partner's life expectancy is authorable from a DOCUMENT, not only from the imperative
 * `marry()`/`startPartnered()` calls. Without the entry field a document could state every other
 * thing about a partner and never their expectancy, so a scenario round-tripped through
 * `ScenarioInput` silently fell back to the household's — and the horizon it produced was not the
 * horizon the same household authored imperatively.
 *
 * Observed through the run's month count, which IS the horizon: `base` puts the primary at age 30
 * in 2026 with an expectancy of 90, so alone they reach 2086 — 720 months. A partner born 2006
 * reaches the same age 90 in 2096, and their own stated age wherever they state one.
 */
describe("Projection.fromInput — a partner's life expectancy, and the horizon it sets", () => {
  const PRIMARY_HORIZON = (90 - 30) * 12;
  const monthsOf = (input: ScenarioInput) => built(input).run(nullJurisdiction).series.months.length;
  /** The partner entry under test, as both an event and an anchor — the two ways one is authored. */
  const withPartner = (partner: Record<string, unknown>): readonly ScenarioInput[] => [
    { ...base, events: [{ type: "marry", month: 12, name: "Sam", birthYear: 2006, ...partner }] },
    {
      ...base,
      events: [
        { type: "startPartnered", partneredForMonths: 24, name: "Sam", birthYear: 2006, ...partner },
      ],
    },
  ] as readonly ScenarioInput[];

  it("carries a stated expectancy onto the partner's own Person record", () => {
    const p = built(withPartner({ lifeExpectancy: 100 })[0]!);
    const event = p.ledger.events[0];
    if (event?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
    expect(event.person.lifeExpectancy).toBe(100);
  });

  it("leaves the field ABSENT when the document omits it — inherit-on-read, not frozen", () => {
    // The fallback is the household's live value resolved at the sim boundary, so an omitted
    // expectancy must not be materialized onto the Person at build time.
    const p = built(withPartner({})[0]!);
    const event = p.ledger.events[0];
    if (event?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
    expect(event.person.lifeExpectancy).toBeUndefined();
  });

  it.each(withPartner({ lifeExpectancy: 100 }))(
    "runs to a partner's DISTINCT stated expectancy — the longest-lived member sets the horizon",
    (input) => {
      // Sam states 100 and is born 2006, reaching it in 2106: (2106 - 2026) * 12 = 960 months,
      // well past both the primary's 720 and the 840 an inherited 90 would have given.
      expect(monthsOf(input)).toBe((2006 + 100 - 2026) * 12);
    },
  );

  it.each(withPartner({}))(
    "falls back to the household's expectancy when the document states none",
    (input) => {
      // Unchanged behavior: Sam inherits age 90 and reaches it in 2096 → 840 months. Still past
      // the primary's 720, because a younger member reaches the same age later.
      expect(monthsOf(input)).toBe((2006 + 90 - 2026) * 12);
    },
  );

  it.each(withPartner({ lifeExpectancy: 70 }))(
    "does not SHRINK the horizon below the primary's when the partner dies first",
    (input) => {
      // Sam states 70 and reaches it in 2076 — a decade before the primary's 2086. The horizon is
      // the max across members, so the primary still sets it.
      expect(monthsOf(input)).toBe(PRIMARY_HORIZON);
    },
  );

  it("agrees with the same household authored imperatively", () => {
    // The point of the whole change: a document and the authoring calls it routes through must
    // produce one horizon, or a saved scenario means something different from the one authored.
    const imperative = Projection.init(base, nullJurisdiction);
    imperative.marry({ month: 12, name: "Sam", birthYear: 2006, lifeExpectancy: 100 });
    expect(monthsOf(withPartner({ lifeExpectancy: 100 })[0]!)).toBe(
      imperative.run(nullJurisdiction).series.months.length,
    );
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
      { ref: ref("REF-dayJob"), startYear: 2026, endYear: 2060,
        salary: { startingSalaryCents: 9_000_000, currentSalaryCents: 9_000_000, realGrowthPct: 0 } },
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
        jobs: [{ startYear: 2027, endYear: 2060,
          salary: { startingSalaryCents: 5_000_000, currentSalaryCents: 5_000_000, realGrowthPct: 0 } }] },
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
   * aliases rather than something this helper is hiding. A purchase's mortgage is its own
   * `LoanEvent` whose id is parent-suffixed off the property (`home-N-mortgage`), counted here
   * like any other event id.
   */
  function allIds(p: Projection): string[] {
    const ids = [
      ...p.plan.primary.jobs.map((j) => j.id),
      ...p.plan.goals.map((g) => g.id),
      ...p.plan.budgetLines.map((l) => l.id),
    ];
    for (const e of p.ledger.events) {
      ids.push(e.id);
      if (e.type === "RelationshipEvent") ids.push(...e.person.jobs.map((j) => j.id));
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
      endYear: 2060,
      salary: { startingSalaryCents: 1_000_000, currentSalaryCents: 1_000_000, realGrowthPct: 0 },
    });
    p.addGoal({ name: "Later", targetCents: 100_000, annualReturnPct: 1,
      disposition: "retain", targetDate: "asap" });
    p.addBudgetLine({ label: "Gym", category: "wants", target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 5_000 } });
    p.takeLoan({ month: 48, ownerId: PRIMARY_PERSON_ID, openingBalanceCents: 500_000,
      apr: 0.07, kind: "studentLoan", termMonths: 60 });

    const after = allIds(p);
    expect(new Set(after).size).toBe(after.length);
    // Everything the build issued is still there, untouched by the later mints.
    for (const id of before) expect(after).toContain(id);
  });

  it("names the continuation job by ref, since a document holds no ids", () => {
    // The one plan field that points INTO a collection, so it is authored the way every other
    // pointer in a document is. Applied after the jobs are bound, which is what lets it name a
    // job declared anywhere in the list rather than only one already applied.
    const twoJobs = [
      { ref: ref("early"), startYear: 2026, endYear: 2050,
        salary: { startingSalaryCents: 1, currentSalaryCents: 1, realGrowthPct: 0 } },
      { ref: ref("late"), startYear: 2050, endYear: 2060,
        salary: { startingSalaryCents: 1, currentSalaryCents: 1, realGrowthPct: 0 } },
    ];
    const p = built({ ...base, jobs: twoJobs, continuationJobRef: ref("early") });
    expect(p.plan.primary.continuationJobId).toBe(p.plan.primary.jobs[0].id);

    // `null` states None outright; omitting it leaves the choice unmade, which the engine
    // resolves on read. The two must not collapse into each other.
    expect(
      built({ ...base, jobs: twoJobs, continuationJobRef: null }).plan.primary.continuationJobId,
    ).toBeNull();
    expect(
      built({ ...base, jobs: twoJobs }).plan.primary.continuationJobId,
    ).toBeUndefined();
  });

  it("refuses a continuation job naming a ref no job declares", () => {
    // Reported as a refusal like any other bad ref, rather than thrown as an internal error:
    // it is a fact about the document, and the document's author is the one who can fix it.
    const result = Projection.fromInput(
      { ...base, jobs: [{ ref: ref("only"), startYear: 2026, endYear: 2060,
        salary: { startingSalaryCents: 1, currentSalaryCents: 1, realGrowthPct: 0 } }],
        continuationJobRef: ref("typo") },
      nullJurisdiction,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/typo/);
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
