/**
 * Scratch playground for the new `Projection` root (issue #70).
 * Run with:  npx tsx playground.ts
 * Not part of the build — delete freely.
 */
import { Projection, dollarsToCents, centsToDollars, type PersonId } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
// A ready-made Plan fixture (not barrel-exported; import by path).
import { samplePlan, SAMPLE_START_YEAR } from "./packages/engine/src/testing/samplePlan";

const P1 = "p1" as PersonId;

// 1. Create — standing numbers in, jurisdiction NOT yet involved.
const p = Projection.create({ plan: samplePlan, startYear: SAMPLE_START_YEAR });

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
const reloaded = Projection.fromJSON(saved);
console.log({ nextIdAfterReload: reloaded.addGoal({
  name: "Car",
  targetCents: dollarsToCents(30_000),
  targetDate: 36,
  disposition: "retain",
  annualReturnPct: 3,
}) });
