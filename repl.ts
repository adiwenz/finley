/**
 * Interactive REPL preloaded with the `@finley/engine` surface (issue #70).
 * Run with:  npx tsx repl.ts
 * Not part of the build — delete freely.
 */
import * as repl from "node:repl";
import * as engine from "@finley/engine";
import * as rules from "@finley/rules";
import { samplePlan, SAMPLE_START_YEAR } from "./packages/engine/src/testing/samplePlan";

const { Projection, dollarsToCents, centsToDollars, nullJurisdiction } = engine;
const { usJurisdiction } = rules;

/** Start over: a fresh Projection on the sample plan. */
const fresh = () => Projection.create({ plan: samplePlan, startYear: SAMPLE_START_YEAR });

/** Run under the US jurisdiction and print the headline numbers. */
const summarize = (p: engine.Projection, j: engine.Jurisdiction = usJurisdiction) => {
  const r = p.run(j);
  const last = r.series.months[r.series.months.length - 1];
  return {
    jurisdiction: r.jurisdictionId,
    months: r.series.months.length,
    firstInsolventMonth: r.firstInsolventMonth,
    // null after the first insolvent month (§5.1) — not zero.
    netWorthRealStart: centsToDollars(r.series.months[0].netWorthRealCents ?? 0),
    netWorthRealEnd: last.netWorthRealCents === null ? null : centsToDollars(last.netWorthRealCents),
  };
};

const server = repl.start({ prompt: "finley> " });

Object.assign(server.context, {
  engine,
  rules,
  Projection,
  dollarsToCents,
  centsToDollars,
  nullJurisdiction,
  usJurisdiction,
  samplePlan,
  SAMPLE_START_YEAR,
  fresh,
  summarize,
  // A projection to poke at immediately.
  p: fresh(),
  P1: "p1" as engine.PersonId,
});

console.log(
  [
    "",
    "Preloaded: p (a fresh Projection), fresh(), summarize(p), P1,",
    "           Projection, samplePlan, SAMPLE_START_YEAR,",
    "           usJurisdiction, nullJurisdiction, dollarsToCents, centsToDollars,",
    "           engine.* / rules.* (full namespaces)",
    "",
    "Try:  p.addJob(P1, { startYear: SAMPLE_START_YEAR, endYear: null,",
    "        salary: { startingSalaryCents: dollarsToCents(120000), realGrowthPct: 1 } })",
    "      summarize(p)",
    "      p.toJSON()",
    "",
  ].join("\n"),
);
