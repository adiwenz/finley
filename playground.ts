/**
 * Scratch playground for the new `Projection` root (issue #70).
 * Run with:  npx tsx playground.ts
 * Not part of the build — delete freely.
 */
import {
  Projection,
  dollarsToCents,
  centsToDollars,
  CURRENT_FORMAT_VERSION,
  nullJurisdiction,
  type PersonId,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
// A ready-made Plan fixture (not barrel-exported; import by path).
import { samplePlan, SAMPLE_START_YEAR } from "./packages/engine/src/testing/samplePlan";

const P1 = "p1" as PersonId;

// 1. Open a handle. Two kinds of door — authoring mints, restoring preserves:
//
//      Projection.init(scalars, j)     — AUTHOR, imperatively: an empty projection to build up.
//      Projection.fromInput(input, j)  — AUTHOR, declaratively: an id-free `ScenarioInput`,
//                                        every durable id minted by the engine. `init` + entries.
//      Projection.fromState(state, j)  — RESTORE: a whole `ProjectionState` whose ids were
//                                        issued earlier; stale counters are normalized.
//
//    `samplePlan` is a fixture that already carries ids, so adopting it is restoration.
//    `nextSeq: 1` means "not known" — the normalization floors the counter past what the plan
//    holds. The jurisdiction here is the one WRITES validate against; `run()` below picks its own.
const p = Projection.fromState(
  { scenario: { plan: samplePlan, ledger: { events: [], nextSequenceNumber: 0 } }, startYear: SAMPLE_START_YEAR, nextSeq: 1, version: CURRENT_FORMAT_VERSION },
  nullJurisdiction,
);

// 2. Standing edits. Creating writes return a minted id.
const jobId = p.addJob(P1, {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(120_000), realGrowthPct: 1 },
});

const rentId = p.addBudgetLine({
  label: "Rent",
  target: { kind: "expense" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_500) },
  category: "needs",
});

p.setRetirementTarget(62); // an edit, not a creating write — mints no id

// 3. Ledger transactions — same object as the standing edits above.
const loanId = p.takeLoan({
  month: 12,
  ownerId: P1,
  kind: "auto",
  openingBalanceCents: dollarsToCents(25_000),
  apr: 6,
  termMonths: 60,
});

console.log({ jobId, rentId, loanId, events: p.state.scenario.ledger.events.length });

// 4. Run under a jurisdiction — pure, repeatable, no mutation.
const result = p.run(usJurisdiction);
console.log({
  jurisdiction: result.jurisdictionId,
  months: result.series.months.length,
  firstInsolventMonth: result.firstInsolventMonth,
  // Net worth is `null` for every month after the first insolvent one (§5.1).
  netWorthRealAt0: centsToDollars(result.series.months[0].netWorthRealCents ?? 0),
  netWorthRealAt36: centsToDollars(result.series.months[36].netWorthRealCents ?? 0),
});

// 5. No undo — writes are reversed by addressable removal (a later slice).

console.log({ ledgerEvents: p.state.scenario.ledger.events.length });

// 6. Serialize / reload — the id counter continues, so ids never collide.
const saved = JSON.parse(JSON.stringify(p.toJSON()));
const reloaded = Projection.fromState(saved, nullJurisdiction);
console.log({ nextIdAfterReload: reloaded.addGoal({
  name: "Car",
  targetCents: dollarsToCents(30_000),
  targetDate: 36,
  disposition: "retain",
  annualReturnPct: 3,
}) });
