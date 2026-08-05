/**
 * The sanctioned place to explore the engine — kept working on purpose. Preloaded with the live
 * `@finley/engine` surface (a fresh `Projection` in `p`, `fresh()`, `summarize(p)`, `samplePlan`,
 * both jurisdictions) and the read-only formatters below, so a question about what the engine does
 * is answered against the engine itself, never a script that reimplements it in another language.
 * Run with `npm run repl`. Observe here, then pin what you saw as a test.
 */
import * as repl from "node:repl";
import * as engine from "@finley/engine";
import * as rules from "@finley/rules";
import { samplePlan, SAMPLE_START_YEAR } from "./packages/engine/src/testing/samplePlan";

const { Projection, dollarsToCents, centsToDollars, nullJurisdiction } = engine;
const { usJurisdiction } = rules;

/**
 * Start over: a handle over the sample plan. `fromState` rather than an authoring call — the
 * fixture is a `Plan` that already carries ids, so adopting it is restoration. `nextSeq: 1`
 * means "not known"; the normalization floors both counters past what the plan holds.
 */
const fresh = () =>
  Projection.fromState(
    { scenario: { plan: samplePlan, ledger: { events: [], nextSequenceNumber: 0 } }, startYear: SAMPLE_START_YEAR, nextSeq: 1, version: engine.CURRENT_FORMAT_VERSION },
    nullJurisdiction,
  );

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

/**
 * Read-only formatters over a `ProjectionResult` — the views a probe otherwise hand-rolls each
 * session. They take a run that already happened and shape it; none of them calls `run()`, because
 * the moment the REPL computes a projection it becomes a second implementation of the thing it
 * exists to observe. Get a run first (`const r = p.run(usJurisdiction)`), then pass it here.
 */

/** Cents → `$1,234`, or `—` for the null net worth every month past the first insolvent one carries. */
const money = (cents: number | null): string =>
  cents === null ? "—" : `$${centsToDollars(cents).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Headline stocks, one row per `step` months. `step` defaults to a year so a decades-long run fits
 * on screen; pass `1` for true month-by-month. `insolvent` marks where the shortfall cascade ran
 * out of credit — the same months whose real net worth reads `—`.
 */
const dumpMonths = (r: engine.ProjectionResult, step = 12) => {
  console.table(
    r.series.months
      .filter((m) => m.month % step === 0)
      .map((m) => ({
        month: m.month,
        year: Math.floor(m.month / 12),
        netWorthReal: money(m.netWorthRealCents),
        netWorthNominal: money(m.netWorthNominalCents),
        insolvent: m.isInsolvent ? "✗" : "",
      })),
  );
};

/**
 * One month's cash waterfall — what came in, what it had to cover, and (when insolvent) what fell
 * through. Reads `months[month].flows`, the record the sim actually funded from, so it cannot
 * disagree with the run. The `opening` snapshot and out-of-range indices carry no flows and print a
 * notice rather than throw.
 */
const waterfall = (r: engine.ProjectionResult, month: number) => {
  const m = r.series.months[month];
  if (!m?.flows) {
    console.log(`month ${month}: no flows (out of range, or the pre-flow opening snapshot)`);
    return;
  }
  const f = m.flows;
  console.log(`— month ${month} (year ${Math.floor(month / 12)}) —`);
  console.log("in:");
  console.table(
    f.incomeSources.map((s) => ({
      source: s.label,
      category: s.category,
      gross: money(s.cashInflowCents),
      net: money(s.netCashFlowCents),
    })),
  );
  console.log(`  income ${money(f.totalIncomeCents)}   tax ${money(f.taxCents)}   payroll ${money(f.payrollTaxCents)}`);
  console.log("out:");
  console.table(
    f.obligations.map((o) => ({ obligation: o.label, treatment: o.treatment, amount: money(o.amountCents) })),
  );
  console.log(
    `  expenses ${money(f.expensesCents)}   liabilities ${money(f.liabilityPaymentsCents)}   total ${money(f.totalObligationsCents)}`,
  );
  if (m.isInsolvent) console.log(`  UNCOVERED ${money(m.uncoveredCents)}`);
};

/**
 * A month's balance sheet at one instant — accounts, liabilities and property side by side, the
 * cross-section a probe assembles to ask "what is owned and owed here?". Liabilities print signed
 * (owed = negative); a property's equity is its value minus any same-keyed liability.
 */
const balances = (r: engine.ProjectionResult, month: number) => {
  const m = r.series.months[month];
  if (!m) {
    console.log(`month ${month}: out of range`);
    return;
  }
  const rows: { kind: string; id: string; amount: string }[] = [];
  for (const [id, c] of Object.entries(m.accountBalancesCents)) rows.push({ kind: "account", id, amount: money(c) });
  for (const [id, c] of Object.entries(m.liabilityBalancesCents)) rows.push({ kind: "liability", id, amount: money(-c) });
  for (const [id, c] of Object.entries(m.propertyValuesCents)) rows.push({ kind: "property", id, amount: money(c) });
  console.table(rows);
  console.log(`  net worth ${money(m.netWorthRealCents)} (real) / ${money(m.netWorthNominalCents)} (nominal)`);
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
  dumpMonths,
  waterfall,
  balances,
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
    "Formatters over a run: dumpMonths(r), waterfall(r, month), balances(r, month)",
    "",
    "Try:  p.addJob(P1, { startYear: SAMPLE_START_YEAR, endYear: null,",
    "        salary: { startingSalaryCents: dollarsToCents(120000),",
    "                  currentSalaryCents: dollarsToCents(120000), realGrowthPct: 1 } })",
    "      summarize(p)",
    "      const r = p.run(usJurisdiction)",
    "      dumpMonths(r)        // net worth, one row per year",
    "      waterfall(r, 12)     // month 12's cash in and out",
    "      balances(r, 12)      // accounts, debts, property at month 12",
    "",
  ].join("\n"),
);
