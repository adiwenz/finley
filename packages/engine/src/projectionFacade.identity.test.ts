/**
 * The `Projection` root's identity spine: deterministic id minting, the counter that floors ids
 * it did not mint and starts clear of the plan it is given, timeline restoration, the declared
 * serialized format version, and the round trips that must preserve every id.
 */
import { describe, it, expect } from "vitest";
import { Projection, CURRENT_FORMAT_VERSION, UnsupportedVersionError, type ProjectionState } from "./index";
import { validateLedger } from "./ledger/validateLedger";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { nullJurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import { withLedger } from "./scenario";
import { emptyLedger, type Ledger } from "./ledger/ledger";
import { type LifeEvent } from "./ledger/eventTypes";
import { type PersonId } from "./job";
import { P1, freshProjection, JOB_END_YEAR, plainJob, partnerEvent, expenseLine, carGoalInput } from "./testing/projectionFacadeFixtures";

describe("Projection root — creating writes mint deterministic ids", () => {
  it("mints a monotonic sequence id and returns it", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    expect(jobId).toBe("job-1");
  });

  it("shares ONE counter across kinds, so ids never collide", () => {
    const p = freshProjection();
    expect(p.addJob(P1, plainJob)).toBe("job-1");
    expect(p.addBudgetLine(expenseLine)).toBe("line-2");
    expect(p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
    })).toBe("goal-3");
    expect(p.takeLoan({ month: 6, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(20000), apr: 5, termMonths: 60 })).toBe("loan-4");
  });

  describe("only asset-free loans can be originated", () => {
    // A `LoanEvent` books a liability and nothing else. That is right for a card (the balance IS
    // money already spent) and a student loan (the asset is an education), and wrong for a car or
    // a house, where booking the debt alone drops net worth by the whole loan and delivers
    // nothing. The type excludes both; these cover input that never met the compiler.
    const originate = (kind: string) => () =>
      freshProjection().takeLoan({
        month: 6,
        ownerId: P1,
        // Cast: the point is precisely that this shape does not typecheck.
        kind: kind as "studentLoan",
        openingBalanceCents: dollarsToCents(30_000),
        apr: 5,
        termMonths: 60,
      });

    it("refuses an auto loan, naming what to do instead", () => {
      expect(originate("auto")).toThrow(/"auto" loan cannot be originated on its own/);
      expect(originate("auto")).toThrow(/carryLoan/);
    });

    it("refuses a bare mortgage — a house is bought, not borrowed against from nothing", () => {
      expect(originate("mortgage")).toThrow(/"mortgage" loan cannot be originated on its own/);
      expect(originate("mortgage")).toThrow(/buying\s+a home/);
    });

    it("still originates the two kinds that carry no asset", () => {
      expect(originate("studentLoan")).not.toThrow();
      expect(() =>
        freshProjection().takeLoan({
          month: 6,
          ownerId: P1,
          kind: "creditCard",
          openingBalanceCents: dollarsToCents(2_000),
          apr: 20,
          creditLimitCents: dollarsToCents(5_000),
        }),
      ).not.toThrow();
    });

    it("leaves `carryLoan` unrestricted — an existing car loan is a fact, not an origination", () => {
      // The household already owns the car and owes on it. Refusing that would refuse to
      // describe a real balance sheet.
      const p = freshProjection();
      expect(() =>
        p.carryLoan({
          ownerId: P1,
          kind: "auto",
          balanceCents: dollarsToCents(12_000),
          apr: 6,
          remainingTermMonths: 36,
        }),
      ).not.toThrow();
      expect(() =>
        p.carryLoan({
          ownerId: P1,
          kind: "mortgage",
          balanceCents: dollarsToCents(200_000),
          apr: 4,
          remainingTermMonths: 240,
        }),
      ).not.toThrow();
    });

    it("still lets a home purchase mint its own mortgage", () => {
      // The one legitimate mortgage origination path: `buyHome` emits the loan AND the property,
      // so both sides land together and the restriction has nothing to catch.
      const p = freshProjection();
      p.addJob(P1, plainJob);
      expect(() =>
        p.ownHome({
          ownerId: P1,
          valueCents: dollarsToCents(300_000),
          mortgage: {
            balanceCents: dollarsToCents(200_000),
            apr: 0.05,
            remainingTermMonths: 240,
          },
        }),
      ).not.toThrow();
    });
  });

  it("mints a job id whatever the caller passes — `JobInput` cannot name one", () => {
    // Jobs take no `id` at all: authoring one is the engine's to name, and a job cannot change
    // owner, so no write ever needs to name an existing one.
    const p = freshProjection();
    expect(p.addJob(P1, plainJob)).toBe("job-1");
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    expect(p.addPartnerJob(partnerId, plainJob)).toMatch(/^job-\d+$/);
    // Including the jobs a partner arrives with, nested inside the marriage.
    const q = freshProjection();
    q.marry({ month: 24, name: "Kim", birthYear: 1990, jobs: [plainJob] });
    expect(partnerEvent(q).person.jobs[0]?.id).toMatch(/^job-\d+$/);
  });

  it("routes the added job onto the standing plan, owned by the person", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const jobs = p.state.scenario.plan.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, ownerId: P1, endYear: JOB_END_YEAR });
  });
});

describe("Projection root — one counter across both planes, across a round trip", () => {
  it("never reissues a partner job's id after a state round trip", () => {
    const authored = freshProjection();
    const partnerId = authored.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const partnerJobId = authored.addPartnerJob(partnerId, plainJob);
    const planJobId = authored.addJob(P1, plainJob);

    // Out through the serialization boundary and back — a fresh handle, no memory of what
    // the first one issued beyond what the state itself carries.
    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored.toState())) as ProjectionState,
      nullJurisdiction,
    );

    const held = new Set([partnerId, partnerJobId, planJobId]);
    const minted = [
      reloaded.addPartnerJob(partnerId, plainJob),
      reloaded.addJob(P1, plainJob),
      reloaded.marry({ month: 36, name: "Kim", birthYear: 1990 }),
    ];
    for (const id of minted) expect(held.has(id)).toBe(false);
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("carries every adjustment id through a state round trip, unchanged", () => {
    const authored = freshProjection();
    const jobId = authored.addJob(P1, plainJob);
    const raise = authored.addJobPayChange(jobId, {
      month: 12,
      kind: "setTo",
      cents: dollarsToCents(9000),
    });
    const first = authored.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 100 });
    const second = authored.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 200 });

    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored.toState())) as ProjectionState,
      nullJurisdiction,
    );

    // Identity is what makes a stacked sibling addressable, so it has to survive the boundary
    // that a saved plan crosses — not be regenerated into a fresh set on the way back in.
    const job = reloaded.plan.jobs[0]!;
    expect(job.payChanges?.map((c) => c.id)).toEqual([raise]);
    expect(job.incomeOverrides?.map((o) => o.id)).toEqual([first, second]);

    // And removal still finds exactly one of them on the far side.
    reloaded.removeJobIncomeOverride(jobId, first);
    expect(reloaded.plan.jobs[0]?.incomeOverrides?.map((o) => o.id)).toEqual([second]);
  });

  it("never reissues an adjustment id to a new adjustment after a round trip", () => {
    const authored = freshProjection();
    const jobId = authored.addJob(P1, plainJob);
    const held = new Set([
      authored.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 100 }),
      authored.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: 100 }),
    ]);

    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored.toState())) as ProjectionState,
      nullJurisdiction,
    );

    // A reissued id would make the new bonus and the restored one the same row to every
    // surface, and removing either would take both.
    const minted = reloaded.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 200 });
    expect(held.has(minted)).toBe(false);
    expect(reloaded.plan.jobs[0]?.incomeOverrides).toHaveLength(2);
  });

  it("steps past a partner job an imported scenario already holds", () => {
    // The hazard the old per-owner scheme left open: an id shape the counter's floor does not
    // recognize is an id the next mint can hand out a second time. `job-9` is recognized.
    //
    // The id arrives by IMPORT, which is now the only way one can: no authoring path lets a
    // caller name a job, so `fromState` is exactly what the floor exists for.
    const seeded = freshProjection();
    const partnerId = seeded.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const state = seeded.toState();
    const imported: ProjectionState = {
      ...state,
      scenario: withLedger(state.scenario, {
        ...state.scenario.ledger,
        events: state.scenario.ledger.events.map((e) =>
          e.type === "RelationshipEvent"
            ? {
                ...e,
                person: {
                  ...e.person,
                  jobs: [{ ...plainJob, id: "job-9", ownerId: partnerId }],
                },
              }
            : e,
        ),
      }),
    };

    const reloaded = Projection.fromState(imported, nullJurisdiction);
    expect(reloaded.addPartnerJob(partnerId, plainJob)).toBe("job-10");
    expect(reloaded.addJob(P1, plainJob)).toBe("job-11");
  });

  it("keeps the counter monotonic while writes alternate between the planes", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const minted: string[] = [];
    for (let i = 0; i < 4; i++) {
      minted.push(p.addJob(P1, plainJob));
      minted.push(p.addPartnerJob(partnerId, plainJob));
    }
    // Strictly increasing across the alternation — neither plane restarts or rewinds.
    const numbers = minted.map((id) => Number(id.replace("job-", "")));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("Projection root — restoring a timeline that already holds ids", () => {
  it("advances both counters past what the restored ledger already occupies", () => {
    // A counter sitting exactly where the state already is: `nextSeq` 1 beside an imported
    // `child-1` at sequenceNumber 1. Unfloored, the next haveChild() would mint `child-1` a
    // second time and the next append would reuse sequence number 1.
    const restored: Ledger = {
      events: [
        {
          id: "child-1",
          type: "ChildEvent",
          month: 12,
          sequenceNumber: 1,
          childId: "child-1",
          childName: "Robin",
          birthMonth: 12,
          annualCostCents: dollarsToCents(12_000),
        },
      ],
      nextSequenceNumber: 2,
    };
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [] }, restored),
      nullJurisdiction,
    );

    const newChildId = p.haveChild({ month: 36, name: "Sam", annualCostCents: dollarsToCents(9_000) });

    // A distinct id, and a place in the log after the event it was restored alongside.
    expect(newChildId).not.toBe("child-1");
    const ids = p.ledger.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const restored0 = p.ledger.events.find((e) => e.id === "child-1");
    const added = p.ledger.events.find((e) => e.id === newChildId);
    expect(added?.sequenceNumber).toBeGreaterThan(restored0?.sequenceNumber ?? 0);

    // Both events remain individually addressable: a revision lands on the restored one and
    // leaves the new one alone, and a removal takes only the event it names.
    p.reviseTransaction("child-1", {
      type: "haveChild",
      name: "Robin (renamed)",
      annualCostCents: dollarsToCents(15_000),
    });
    expect(p.ledger.events.find((e) => e.id === "child-1")).toMatchObject({
      childName: "Robin (renamed)",
      // A revision keeps its place in the log.
      sequenceNumber: restored0?.sequenceNumber,
    });
    expect(p.ledger.events.find((e) => e.id === newChildId)).toMatchObject({ childName: "Sam" });

    p.removeTransaction("child-1");
    expect(p.ledger.events.map((e) => e.id)).toEqual([newChildId]);
  });

  it("clears a sequence number a restored ledger would otherwise hand out twice", () => {
    // A ledger whose own `nextSequenceNumber` violates the Ledger invariant — it is not above
    // every event's `sequenceNumber`. This is the malformed-persisted-state case: unfloored,
    // `addEvent` would stamp 3, then 4, and the 4 would collide with the restored event.
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [] }, {
        events: [
          {
            id: "restored-loan",
            type: "LoanEvent",
            month: 6,
            sequenceNumber: 4,
            kind: "auto",
            liabilityId: "restored-loan",
            ownerId: P1,
            openingBalanceCents: dollarsToCents(20_000),
            apr: 5,
            termMonths: 60,
          },
        ],
        nextSequenceNumber: 3,
      }),
      nullJurisdiction,
    );

    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 4,
      termMonths: 24,
    });

    const seqs = p.ledger.events.map((e) => e.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(p.ledger.events.find((e) => e.id === loanId)?.sequenceNumber).toBeGreaterThan(4);
  });

  it("reads named id fields, not every string it can reach", () => {
    // `childName` is a person's words. A scan over every string in the ledger would read
    // "goal-50000" as a counter reading and advance the mint by fifty thousand on the
    // strength of a name.
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [], goals: [] }, {
        events: [
          {
            id: "restored-child",
            type: "ChildEvent",
            month: 12,
            sequenceNumber: 0,
            childId: "restored-child",
            childName: "room-50000",
            birthMonth: 12,
            annualCostCents: 0,
          },
          {
            id: "restored-child-2",
            type: "ChildEvent",
            month: 18,
            sequenceNumber: 1,
            childId: "restored-child-2",
            // Mint-SHAPED and a real minted kind — still a name, still ignored.
            childName: "goal-50000",
            birthMonth: 18,
            annualCostCents: 0,
          },
        ],
        nextSequenceNumber: 2,
      }),
      nullJurisdiction,
    );

    // Only the two sequence numbers moved the floor, so the next goal is goal-2, not goal-50001.
    expect(p.addGoal(carGoalInput)).toBe("goal-2");
  });
});

describe("Projection root — fromState restores a plan and its timeline together", () => {
  it("carries the timeline and floors both counters past the ids it already holds", () => {
    // State that arrives already built: a plan holding `job-4`, a ledger whose event holds
    // `loan-2` at sequence number 2, and — the reason normalization is not optional — a
    // `nextSeq` and a `nextSequenceNumber` that both understate what the state contains. This
    // is the shape a hand-edited or stale serialization takes, and `fromState` is the only
    // door it can come through.
    const state: ProjectionState = {
      scenario: {
        plan: {
          ...samplePlan,
          goals: [],
          budgetLines: [],
          jobs: [{ ...plainJob, id: "job-4", ownerId: P1 }],
        },
        ledger: {
          events: [
            {
              id: "loan-2",
              type: "LoanEvent" as const,
              month: 6,
              sequenceNumber: 2,
              kind: "auto" as const,
              liabilityId: "loan-2",
              ownerId: P1,
              openingBalanceCents: dollarsToCents(20000),
              apr: 5,
              termMonths: 60,
            },
          ],
          nextSequenceNumber: 0,
        },
      },
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    };

    const p = Projection.fromState(state, nullJurisdiction);

    // The restored event survived the construction — unlike `fromInput`, which authors from a
    // document and always starts from an empty ledger.
    expect(p.ledger.events.map((e) => e.id)).toEqual(["loan-2"]);
    // The id floor cleared `job-4`, so the next mint is `job-5` — not `job-1`, which the
    // state's own `nextSeq` would have handed out on top of a live id.
    expect(p.addJob(P1, plainJob)).toBe("job-5");
    // One shared counter: the sequence side was lifted to that same floor, so the next append
    // lands at or above 5 — well clear of the restored event still sitting at 2.
    const eventId = p.takeLoan({ month: 12, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(1000), apr: 4, termMonths: 24 });
    const appended = p.ledger.events.find((e) => e.id === eventId);
    expect(appended?.sequenceNumber).toBeGreaterThanOrEqual(5);
  });

  it("keeps every id and event across a round trip, and never lowers a counter", () => {
    const authored = freshProjection();
    authored.addJob(P1, plainJob);
    authored.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });
    const before = authored.toState();
    const after = Projection.fromState(before, nullJurisdiction).toState();

    // What the round trip must preserve: the plan, and every event with its id and its place
    // in the sequence.
    expect(after.scenario.plan).toEqual(before.scenario.plan);
    expect(after.scenario.ledger.events).toEqual(before.scenario.ledger.events);
    // Counters only ever rise. `nextSequenceNumber` DOES rise here, and legitimately: the two
    // counters share one floor (see `seqFloor`), but `commit` maintains only `nextSeq` as a
    // write lands, so restoring is where the sequence side catches up. Raising it is always
    // safe — the invariant is "strictly above every event" — and it never reissues a number.
    expect(after.nextSeq).toBeGreaterThanOrEqual(before.nextSeq);
    expect(after.scenario.ledger.nextSequenceNumber).toBeGreaterThanOrEqual(
      before.scenario.ledger.nextSequenceNumber,
    );
  });

  it("is idempotent from the second trip on, so restoring cannot walk a counter upward", () => {
    // The catch-up above happens once. If it repeated, every reload would inflate the counters
    // a little further — so this is the property that makes the raise safe rather than a drift.
    const authored = freshProjection();
    authored.addJob(P1, plainJob);
    authored.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });

    const once = Projection.fromState(authored.toState(), nullJurisdiction).toState();
    const twice = Projection.fromState(once, nullJurisdiction).toState();
    expect(twice).toEqual(once);
  });
});

describe("Projection root — importing a pre-built ledger rejects one that will not replay", () => {
  // A lone separation with no marriage to end: replay fails its precondition on the first
  // event, so every import path must refuse it and name it rather than install a broken
  // timeline. The offender's type and id surface in the thrown message.
  const unreplayable: Ledger = {
    events: [
      {
        id: "sep-1",
        type: "SeparationEvent",
        month: 24,
        sequenceNumber: 1,
        partnerPersonId: "nobody",
        alimonyMonthlyCents: dollarsToCents(0),
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: dollarsToCents(0),
      },
    ],
    nextSequenceNumber: 2,
  };

  // A ledger holding an event no handler answers to — a hand-edited plan, or one written by a
  // build that knows an event this one doesn't.
  const unknownType: Ledger = {
    events: [
      { id: "bogus-1", type: "Frobnicate", month: 12, sequenceNumber: 1 } as unknown as LifeEvent,
    ],
    nextSequenceNumber: 2,
  };

  it("fromState rejects an un-replayable ledger, naming the offending event", () => {
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unreplayable),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(
      /cannot load — event "sep-1" \(SeparationEvent\) fails —/,
    );
  });

  it("refuses before any handle escapes, so nothing partial is observable", () => {
    // `fromState` is now the ONLY import path — `fromScenario` and `resetLedger` are gone — so
    // the gate has one door to cover rather than three. It throws during construction, which is
    // stronger than the old "a refused reset commits nothing": there is no handle to inspect.
    const base = freshProjection().toState();
    const state: ProjectionState = { ...base, scenario: withLedger(base.scenario, unreplayable) };
    let escaped: Projection | undefined;
    expect(() => {
      escaped = Projection.fromState(state, nullJurisdiction);
    }).toThrow(/cannot load — event "sep-1" \(SeparationEvent\) fails —/);
    expect(escaped).toBeUndefined();
  });

  it("names the offending event even when the reason itself carries no id", () => {
    // Regression: the message used to be `cannot load — ${reason}`, which read correctly only
    // because every `checkEvent` reason happens to open with the event's own type and id. The
    // unknown-type rejection is a reason that names nothing ("unknown event type"), so a message
    // borrowing its detail from the reason would lose the only pointer to the bad row.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unknownType),
    };

    // The reason the fold returns genuinely omits the id — otherwise this proves nothing.
    const validation = validateLedger(unknownType, {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [],
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).not.toContain("bogus-1");

    // Yet the thrown message carries both the id and the type.
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('"bogus-1"');
    expect(message).toContain("Frobnicate");
    expect(message).toBe(
      'Projection: cannot load — event "bogus-1" (Frobnicate) fails — unknown event type',
    );
  });

  it("rejects an unknown event type as a load error, not a raw TypeError", () => {
    // The handler lookup returns `undefined` for an unregistered discriminant; calling `.check`
    // on it threw a TypeError that named neither the event nor the plan.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unknownType),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).not.toThrow(TypeError);
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(
      /cannot load — event "bogus-1" \(Frobnicate\) fails — unknown event type/,
    );

    // `fromState` is the only import path left, so covering it covers every way an unknown
    // type can arrive.
  });
});

describe("Projection root — the serialized format declares its version", () => {
  // A lone separation with no marriage to end — un-replayable, reused to prove the version gate
  // fires before replay even reaches it.
  const unreplayable: Ledger = {
    events: [
      {
        id: "sep-1",
        type: "SeparationEvent",
        month: 24,
        sequenceNumber: 1,
        partnerPersonId: "nobody",
        alimonyMonthlyCents: dollarsToCents(0),
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: dollarsToCents(0),
      },
    ],
    nextSequenceNumber: 2,
  };

  it("stamps the current version on the serialized state", () => {
    expect(freshProjection().toState().version).toBe(CURRENT_FORMAT_VERSION);
  });

  it("round-trips a current-version plan unchanged", () => {
    const authored = freshProjection().toState();
    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored)) as ProjectionState,
      nullJurisdiction,
    );
    expect(reloaded.toState().version).toBe(CURRENT_FORMAT_VERSION);
  });

  it("rejects a non-current version with UnsupportedVersionError carrying file version and supported version", () => {
    const state: ProjectionState = {
      ...freshProjection().toState(),
      version: CURRENT_FORMAT_VERSION + 1,
    };
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedVersionError);
    const error = thrown as UnsupportedVersionError;
    expect(error.fileVersion).toBe(CURRENT_FORMAT_VERSION + 1);
    expect(error.supported).toBe(CURRENT_FORMAT_VERSION);
  });

  it("rejects an OLDER version too — there is nothing to migrate it with", () => {
    // The gate is exact equality, not a range: this build has no transforms, so a v0 file is no
    // more loadable than a v2 one. When real migrations land, an older version stops throwing
    // here because it gets migrated up — not because the accepted range quietly widened.
    const state: ProjectionState = {
      ...freshProjection().toState(),
      version: CURRENT_FORMAT_VERSION - 1,
    };
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedVersionError);
    expect((thrown as UnsupportedVersionError).fileVersion).toBe(CURRENT_FORMAT_VERSION - 1);
  });

  it("rejects an unversioned plan as an unsupported version", () => {
    const { version: _drop, ...unversioned } = freshProjection().toState();
    expect(() =>
      Projection.fromState(unversioned as ProjectionState, nullJurisdiction),
    ).toThrow(UnsupportedVersionError);
  });

  it("reports a version mismatch before replay — a foreign shape is never replayed", () => {
    // Both wrong: an unsupported version AND an un-replayable ledger. The version bucket wins,
    // because replaying a shape this build cannot read is meaningless.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      version: CURRENT_FORMAT_VERSION + 1,
      scenario: withLedger(base.scenario, unreplayable),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(UnsupportedVersionError);
  });
});

describe("Projection root — the id counter starts clear of the plan it is given", () => {
  function planWith(overrides: Partial<typeof samplePlan>) {
    return { ...samplePlan, jobs: [], budgetLines: [], goals: [], ...overrides };
  }

  const jobAt = (id: string) => ({
    id,
    ownerId: P1,
    startYear: SAMPLE_START_YEAR,
    endYear: JOB_END_YEAR,
    salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
  });

  it("mints past a job the supplied plan already holds", () => {
    // The app's own PLAN_DEFAULTS ships a `job-1`; before the fix a counter starting at 1
    // minted a second one and the plan carried two jobs under one id.
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-1")] })), nullJurisdiction);

    const added = p.addJob(P1, plainJob);
    expect(added).not.toBe("job-1");
    expect(added).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the floor from every plan collection, not just the one it is minting into", () => {
    const p = Projection.fromState(stateOf(planWith({
          jobs: [jobAt("job-3")],
          goals: [{
            id: "goal-7",
            name: "Car",
            targetCents: dollarsToCents(30000),
            targetDate: 36,
            disposition: "retain",
            annualReturnPct: 3,
          }],
          budgetLines: [{ ...expenseLine, id: "line-5" }],
        })), nullJurisdiction);

    // One counter across all kinds, so the highest id in ANY collection sets the floor.
    expect(p.addJob(P1, plainJob)).toBe("job-8");
    expect(p.addBudgetLine(expenseLine)).toBe("line-9");
  });

  it("counts ids nested inside a restored partner's own jobs", () => {
    const p = Projection.fromState(
      stateOf(planWith({}), {
        events: [
        {
          id: "person-4",
          type: "RelationshipEvent",
          month: 24,
          sequenceNumber: 0,
          person: {
            id: "person-4",
            name: "Partner",
            birthYear: 1988,
            benefitClaimingAge: 67,
            // A partner's jobs live ON their event — a floor reading only the event's own
            // fields would hand `job-9` straight back out.
            jobs: [jobAt("job-9")],
          },
        },
        ],
        nextSequenceNumber: 1,
      }),
      nullJurisdiction,
    );

    expect(p.addJob(P1, plainJob)).toBe("job-10");
  });

  it("ignores an id-shaped suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    // Past 2^53 `Number` rounds, so honouring the suffix would set a floor the counter can
    // never pass — and incrementing a non-safe integer is a no-op, so the mint would hand out
    // the SAME id forever. Ignoring it is both safe and correct: `mint` cannot have issued a
    // number it cannot count to.
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-9007199254740993")] })), nullJurisdiction);

    const first = p.addJob(P1, plainJob);
    const second = p.addJob(P1, plainJob);
    expect(first).toBe("job-1");
    expect(second).toBe("job-2");
    expect(first).not.toBe(second);
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Same guard on the ledger side, where the id sits in a real id field of a restored event.
    const q = Projection.fromState(
      stateOf(planWith({}), {
        events: [
          {
            id: "loan-9007199254740993",
            type: "LoanEvent",
            month: 6,
            sequenceNumber: 0,
            kind: "auto",
            liabilityId: "loan-9007199254740993",
            ownerId: P1,
            openingBalanceCents: dollarsToCents(20_000),
            apr: 5,
            termMonths: 60,
          },
        ],
        nextSequenceNumber: 1,
      }),
      nullJurisdiction,
    );

    const a = q.takeLoan({ month: 12, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    const b = q.takeLoan({ month: 18, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    expect(a).not.toBe(b);
    const eventIds = q.ledger.events.map((e) => e.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("never walks the counter backwards, however little the restored state admits to", () => {
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-6")] })), nullJurisdiction);
    expect(p.addJob(P1, plainJob)).toBe("job-7");

    // Restoring a state that UNDERSTATES its counter must not release ids already spent —
    // neither the plan's `job-6` nor the `job-7` just minted. `stateOf` seeds `nextSeq: 1`,
    // so this is that case exactly: the floor is read off what the state holds, not trusted.
    const reloaded = Projection.fromState(stateOf(p.plan), nullJurisdiction);
    expect(reloaded.addJob(P1, plainJob)).toBe("job-8");
  });

  it("still addresses the right entity after the counter has been advanced", () => {
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-1")] })), nullJurisdiction);
    const added = p.addJob(P1, plainJob);

    const job = p.plan.jobs.find((j) => j.id === added)!;
    p.replaceJob(added, { ...job, name: "Second job" });
    expect(p.plan.jobs.find((j) => j.id === "job-1")).not.toHaveProperty("name");
    expect(p.plan.jobs.find((j) => j.id === added)).toMatchObject({ name: "Second job" });

    p.removeJob(added);
    expect(p.plan.jobs.map((j) => j.id)).toEqual(["job-1"]);
  });
});

/**
 * No authoring input carries an `id`, so the counter is the only thing that issues one. What
 * still needs flooring is an id that arrives WITHOUT passing through the mint: a revision that
 * introduces a whole event, or an imported state (covered in the round-trip suite above).
 */
describe("Projection root — the counter floors ids it did not mint", () => {
  it("mints from one counter across every kind, so two things never share a number", () => {
    const p = freshProjection();
    const ids = [
      p.addGoal(carGoalInput),
      p.addJob(P1, plainJob),
      p.addBudgetLine(expenseLine),
      p.takeLoan({
        month: 6,
        ownerId: P1,
        kind: "studentLoan",
        openingBalanceCents: dollarsToCents(20000),
        apr: 5,
        termMonths: 60,
      }),
    ];
    // Distinct, and each says what it names — one counter, so the numbers never repeat.
    expect(ids).toEqual(["goal-1", "job-2", "line-3", "loan-4"]);
  });

  /** A handle over a plan that already holds a job named elsewhere — the import case. */
  const importedHolding = (jobId: string) =>
    Projection.fromState(stateOf({
          ...samplePlan,
          goals: [],
          budgetLines: [],
          jobs: [{ ...plainJob, id: jobId, ownerId: P1 }],
        }), nullJurisdiction);

  it("leaves the counter alone for an imported id it could not have minted", () => {
    const p = importedHolding("external-payroll-job");
    // Not a shape `mint` produces, so no id it goes on to issue can collide with it and
    // nothing is spent stepping over it.
    expect(p.addJob(P1, plainJob)).toBe("job-1");
  });

  it("ignores an imported suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    const p = importedHolding("job-9007199254740993");

    const a = p.addJob(P1, plainJob);
    const b = p.addJob(P1, plainJob);
    // Honouring the suffix would have set a floor the counter cannot pass — and incrementing
    // a non-safe integer is a no-op, so every later mint would return the SAME id.
    expect(a).toBe("job-1");
    expect(b).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("steps over an imported id of minted shape rather than reissuing it", () => {
    const p = importedHolding("job-2");
    // `job-2` is one of ours, so the counter must clear it — minting 1 then 2 would hand out
    // an id the plan already holds.
    const second = p.addJob(P1, plainJob);
    expect(second).toBe("job-3");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has nothing to floor after a revision, because a revision introduces no id", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 }) as PersonId;
    // The shared counter floors both ids and sequence numbers, so the marriage's own event
    // (which takes the first sequence number) steps the counter one past it — the first
    // authored job is `job-2`, a harmless gap, the same as any other construction path.
    expect(p.addJob(P1, plainJob)).toBe("job-2");
    const spent = p.toState().nextSeq;

    // A revision names data, never an entity, so it cannot smuggle an id into the ledger the
    // way a caller-built event once could. The counter has nothing to step over.
    p.reviseTransaction(partnerId, { type: "marry", month: 30, name: "Renamed" });

    expect(p.toState().nextSeq).toBe(spent);
    expect(p.addJob(P1, plainJob)).toBe("job-3");
  });

  it("a refused transaction consumes no id", () => {
    const p = freshProjection();
    const before = p.state;

    expect(() =>
      p.buyHome({
        month: 12,
        ownerId: P1,
        purchasePriceCents: dollarsToCents(500000),
        downPaymentCents: dollarsToCents(400000),
        downPaymentSourceIds: ["savings"],
        mortgageApr: 6,
        mortgageTermMonths: 360,
      }),
    ).toThrow();

    // The refusal never reached the commit, so it claimed nothing.
    expect(p.state).toBe(before);
    expect(p.state.nextSeq).toBe(before.nextSeq);
    expect(p.addJob(P1, plainJob)).toBe("job-1");
  });
});

describe("Projection root — transact wraps one write over plain state", () => {
  it("returns the next state and the write's own result, leaving the input state untouched", () => {
    const before = freshProjection().state;
    const { state, result } = Projection.transact(before, nullJurisdiction, (p) =>
      p.addJob(P1, plainJob),
    );

    // The id-returning write hands its id straight back through `result`.
    expect(result).toBe("job-1");
    // The next state carries the write; the state passed in is never mutated in place.
    expect(state.scenario.plan.jobs.map((j) => j.id)).toEqual(["job-1"]);
    expect(before.scenario.plan.jobs).toHaveLength(0);
  });

  it("carries a void write through as an undefined result", () => {
    const seeded = Projection.transact(freshProjection().state, nullJurisdiction, (p) =>
      p.addJob(P1, plainJob),
    );
    const { state, result } = Projection.transact(seeded.state, nullJurisdiction, (p) => {
      const job = p.plan.jobs[0]!;
      p.replaceJob("job-1", {
        ...job,
        salary: {
          ...job.salary,
          startingSalaryCents: dollarsToCents(9000) * 12,
          currentSalaryCents: dollarsToCents(9000) * 12,
        },
      });
    });

    expect(result).toBeUndefined();
    expect(state.scenario.plan.jobs[0]?.salary.startingSalaryCents).toBe(dollarsToCents(108000));
  });

  it("floors the counter on ids the imported state already carries", () => {
    // The handle is built through the flooring path, so a write inside the transaction mints
    // clear of a `job-5` the imported state already holds rather than colliding with it.
    const seeded: ProjectionState = {
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
      scenario: {
        plan: { ...samplePlan, jobs: [{ ...plainJob, id: "job-5", ownerId: P1 }], budgetLines: [], goals: [] },
        ledger: emptyLedger,
      },
    };

    const { result } = Projection.transact(seeded, nullJurisdiction, (p) => p.addJob(P1, plainJob));
    expect(result).toBe("job-6");
  });
});

describe("Projection root — id counter round-trips through serialization", () => {
  it("a reloaded plan continues the sequence without collision", () => {
    const p = freshProjection();
    p.addJob(P1, plainJob); // job-1
    p.addBudgetLine(expenseLine); // line-2 → nextSeq now 3

    const snapshot = JSON.parse(JSON.stringify(p.toJSON()));
    const reloaded = Projection.fromState(snapshot, nullJurisdiction);

    // The counter survived: the next mint is 3, not a colliding 1.
    expect(reloaded.state.nextSeq).toBe(3);
    expect(reloaded.addGoal({
      name: "Trip",
      targetCents: dollarsToCents(5000),
      targetDate: 12,
      disposition: "retain",
      annualReturnPct: 2,
    })).toBe("goal-3");
    expect(reloaded.state.scenario.plan.jobs).toHaveLength(1);
    expect(reloaded.state.scenario.plan.budgetLines).toHaveLength(1);
  });

  it("normalizes counters a serialized state got wrong", () => {
    // The least trustworthy input the API takes: a state that has been through JSON, and may
    // have been hand-edited or written by a build whose counters meant something else. Both
    // counters here are stale — `nextSeq` 1 against a `job-5`, and `nextSequenceNumber` 1
    // against an event already at 8.
    const stale: ProjectionState = {
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
      scenario: {
        plan: {
          ...samplePlan,
          goals: [],
          budgetLines: [],
          jobs: [
            {
              id: "job-5",
              ownerId: P1,
              startYear: SAMPLE_START_YEAR,
              endYear: JOB_END_YEAR,
              salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
            },
          ],
        },
        ledger: {
          events: [
            {
              id: "imported-loan",
              type: "LoanEvent",
              month: 6,
              sequenceNumber: 8,
              kind: "auto",
              liabilityId: "imported-loan",
              ownerId: P1,
              openingBalanceCents: dollarsToCents(20_000),
              apr: 5,
              termMonths: 60,
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };

    const p = Projection.fromState(stale, nullJurisdiction);

    // Trusting `nextSeq: 1` would have minted `job-5` a second time.
    const jobId = p.addJob(P1, plainJob);
    expect(jobId).not.toBe("job-5");
    const jobIds = p.plan.jobs.map((j) => j.id);
    expect(new Set(jobIds).size).toBe(jobIds.length);

    // Trusting `nextSequenceNumber: 1` would have stamped the next event 1, then 2 — and the
    // ledger already holds 8, so the log would have carried two events at one number before
    // long. The floor is taken from the whole state, so it clears the sequence AND `job-5`.
    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 4,
      termMonths: 24,
    });
    const added = p.ledger.events.find((e) => e.id === loanId);
    expect(added?.sequenceNumber).toBeGreaterThan(8);
    const seqs = p.ledger.events.map((e) => e.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    const eventIds = p.ledger.events.map((e) => e.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("only ever raises a counter, never renumbers what is already authored", () => {
    const p = freshProjection();
    p.addJob(P1, plainJob);
    p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const before = p.toJSON();

    const reloaded = Projection.fromState(JSON.parse(JSON.stringify(before)), nullJurisdiction);

    // The id counter is already at its floor, so a reload does not skip ids.
    expect(reloaded.state.nextSeq).toBe(before.nextSeq);
    // One floor serves both counters, so the ledger's own may be RAISED to meet it — a wider
    // gap before the next event, never a lower number.
    expect(reloaded.ledger.nextSequenceNumber).toBeGreaterThanOrEqual(
      before.scenario.ledger.nextSequenceNumber,
    );
    // What matters is that nothing already in the log is renumbered: sequence numbers are
    // identity for the same-month tie-break, and a reload must not reshuffle a timeline.
    expect(reloaded.ledger.events.map((e) => e.sequenceNumber)).toEqual(
      before.scenario.ledger.events.map((e) => e.sequenceNumber),
    );
    expect(reloaded.ledger.events.map((e) => e.id)).toEqual(
      before.scenario.ledger.events.map((e) => e.id),
    );
  });

  it("settles after one normalization — reloading repeatedly does not drift", () => {
    // Idempotence is what makes a save/load cycle safe to repeat: if each pass could raise
    // the counters again, a plan reopened daily would climb without ever being edited.
    const p = freshProjection();
    p.addJob(P1, plainJob);
    p.marry({ month: 24, name: "Partner", birthYear: 1988 });

    const once = Projection.fromState(JSON.parse(JSON.stringify(p.toJSON())), nullJurisdiction).toJSON();
    const twice = Projection.fromState(JSON.parse(JSON.stringify(once)), nullJurisdiction).toJSON();

    expect(twice.nextSeq).toBe(once.nextSeq);
    expect(twice.scenario.ledger.nextSequenceNumber).toBe(
      once.scenario.ledger.nextSequenceNumber,
    );
  });

  it("names the round-trip fromState/toState, with toJSON kept as a JSON-protocol alias", () => {
    const p = freshProjection();
    p.addJob(P1, plainJob); // job-1
    p.addBudgetLine(expenseLine); // line-2

    // toJSON is the JS protocol name: JSON.stringify calls it automatically, and it returns
    // the same state as toState — one payload, two names.
    expect(p.toJSON()).toBe(p.toState());
    expect(JSON.parse(JSON.stringify(p))).toEqual(p.toState());

    // fromState is the flooring construction path: a reloaded state continues the sequence.
    const reloaded = Projection.fromState(JSON.parse(JSON.stringify(p.toState())), nullJurisdiction);
    expect(reloaded.state.nextSeq).toBe(3);
    expect(
      reloaded.addGoal({
        name: "Trip",
        targetCents: dollarsToCents(5000),
        targetDate: 12,
        disposition: "retain",
        annualReturnPct: 2,
      }),
    ).toBe("goal-3");
  });
});

