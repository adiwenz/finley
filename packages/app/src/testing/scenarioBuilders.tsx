/**
 * The end-to-end scenario vocabulary, shared across scenario files. Each builder authors a
 * household through the public `Projection` API exactly as a user would through the UI, and each
 * reader pulls the SENTENCE or FIGURE a panel puts on screen — the retirement answer, a goal's
 * on-track status, the net-worth headline, the month's income — solved against the real US
 * jurisdiction and rendered through the real component. A scenario file imports these and is a
 * few assertions; without them a second file would re-implement the whole harness.
 */

import { renderToStaticMarkup } from "react-dom/server";
import {
  Projection,
  PRIMARY_PERSON_ID,
  SYNTHETIC_CARD_ID,
  dollarsToCents,
  liabilityKindLabel,
  planHorizonMonths,
  type JobInput,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./projectionHarness";
import { retirementView } from "../retirementView";
import { RetirementPanel } from "../components/retirementPanel/retirementPanel";
import { GoalsPanel } from "../components/goalsPanel/goalsPanel";
import { NetWorthBreakdownChart } from "../components/netWorthChart/netWorthBreakdownChart";
import { buildNetWorthBreakdown } from "../components/netWorthChart/netWorthBreakdown";
import { BaseAdjustmentsPanel } from "../components/baseAdjustments/baseAdjustmentsPanel";
import { PLAN_DEFAULTS } from "../planDefaults";
import { START_YEAR } from "../config";
import type { Transact } from "../hooks/useProjection";

/** These panels take a write callback they never fire under a static render; a typed no-op. */
const NO_WRITES: Transact = () => undefined;

/** The primary's birth year — exported so a partner authored at the same age names it directly. */
export const ALEX_BIRTH = PLAN_DEFAULTS.primary.birthYear;
const ALEX_AGE = START_YEAR - ALEX_BIRTH;
/** Life expectancy the portfolio-lasts sentences quote — exported so assertions read it too. */
export const LIFE_EXPECTANCY = PLAN_DEFAULTS.primary.lifeExpectancy;

/** The simulation month the household reaches an age on the PRIMARY's clock. */
export const monthAt = (age: number) => (age - ALEX_AGE) * 12;

/**
 * One job in the terms the Jobs form takes them: two ages on the owner's own clock and a
 * salary. Flat real growth throughout, so nothing in these scenarios turns on a pay curve.
 */
export function jobAt(
  startAge: number,
  endAge: number,
  annualDollars: number,
  birthYear = ALEX_BIRTH,
): JobInput {
  return {
    startYear: birthYear + startAge,
    endYear: birthYear + endAge,
    salary: {
      startingSalaryCents: dollarsToCents(annualDollars),
      currentSalaryCents: dollarsToCents(annualDollars),
      realGrowthPct: 0,
    },
  };
}

/** The default plan as a fresh handle — the household a user starts from. */
export const alexAlone = (): Projection => Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);

/**
 * One rendered HTML fragment as the plain text a reader sees: tags dropped, the entities
 * `renderToStaticMarkup` emits decoded back to the glyphs the panels author (`&#x27;`→`'`,
 * `&#x2019;`→`’`, `&#x2013;`→`–`, `&amp;`→`&`), whitespace collapsed. Every panel reader below
 * strips markup through here so an assertion is against the sentence, never the tags around it.
 */
function plainText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2019;/g, "’")
    .replace(/&#x2013;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The panel's own paragraphs, as the plain text a reader sees. Rendered through the real
 * component and the real view, so nothing between the solve and the screen is stubbed.
 */
export function paragraphs(p: Projection): string[] {
  const html = renderToStaticMarkup(
    <RetirementPanel
      view={retirementView(p, usJurisdiction)}
      budget={p.plan}
      previewing={false}
      onTogglePreview={() => {}}
    />,
  );
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) => plainText(m[1]!));
}

/**
 * One goal's claim to the household, in the order the panel stacks it: the projection-scored
 * status ("Funded", or "N% on track"), the pacing line when still in progress, the target and
 * date, and the at-target disposition. Rendered through the real `GoalsPanel` against the plan's
 * own run, so the on-track percentage is the engine's `goalProgress` math joined to the panel's
 * words — the seam a household actually reads, not the `GoalRow` fields underneath it.
 */
export function goalClaim(p: Projection, goalName: string): string[] {
  const html = renderToStaticMarkup(
    <GoalsPanel
      budget={p.plan}
      result={p.run(usJurisdiction)}
      projection={p}
      transact={NO_WRITES}
    />,
  );
  const row = html.match(new RegExp(`<li class="goal-row" aria-label="${goalName}">(.*?)</li>`, "s"));
  if (row === null) throw new Error(`no goal row "${goalName}" in:\n${html}`);
  return [
    ...row[1]!.matchAll(
      /<(?:span|div) class="goal-(?:track|status[^"]*|meta|disposition)"[^>]*>(.*?)<\/(?:span|div)>/gs,
    ),
  ].map((m) => plainText(m[1]!));
}

/**
 * The one sentence the net-worth breakdown chart states above its bands — the peak figure and
 * the composition ("across N accounts", property, debt). Built exactly as `main.tsx` builds it
 * (real account descriptors, the synthetic last-resort card labelled as a credit card), so the
 * dollars are the ones a user reads, formatted, not the cents the series carries.
 */
export function netWorthSummary(p: Projection): string {
  const result = p.run(usJurisdiction);
  const liabilityLabels: Record<string, string> = {
    [SYNTHETIC_CARD_ID]: liabilityKindLabel("creditCard"),
  };
  for (const liability of result.household.liabilities) {
    liabilityLabels[liability.id] = liabilityKindLabel(liability.kind);
  }
  const data = buildNetWorthBreakdown(
    result.series,
    { accounts: p.accountDescriptors(), liabilityLabels },
    planHorizonMonths(p.plan, START_YEAR),
  );
  const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
  const summary = html.match(/data-testid="breakdown-summary"[^>]*>(.*?)<\/p>/s);
  if (summary === null) throw new Error(`no breakdown summary in:\n${html}`);
  return plainText(summary[1]!);
}

/**
 * The Base + Adjustments panel's income read-out at month 0: the total, formatted string a user
 * sees for "what your jobs pay at the selected month". Rendered through the real panel off the
 * plan's own run, so it is the engine's household wage total joined to the panel — a two-earner
 * household reads a figure a one-earner household does not.
 */
export function budgetIncome(p: Projection): string {
  const result = p.run(usJurisdiction);
  const personNames = new Map<string, string>([[PRIMARY_PERSON_ID, p.plan.primary.name]]);
  for (const member of result.membersAt(0)) personNames.set(member.id, member.name);
  const html = renderToStaticMarkup(
    <BaseAdjustmentsPanel
      plan={p.plan}
      transact={NO_WRITES}
      series={result.series}
      personNames={personNames}
      household={result.household}
      ledger={p.ledger}
      projection={p}
      plannedWorkStopAge={retirementView(p, usJurisdiction).plannedWorkStopAge}
    />,
  );
  const income = html.match(/data-testid="income-readonly"[^>]*>(.*?)<\/span>/s);
  if (income === null) throw new Error(`no income read-out in:\n${html}`);
  return plainText(income[1]!);
}

/**
 * The one sentence that gives the answer — in whichever of its three forms the panel chose.
 * Matched by what each form actually says rather than by position, so a new paragraph appearing
 * above it (a health nudge, a preview hint) cannot silently retarget these assertions.
 */
export function headline(p: Projection): string {
  const found = paragraphs(p).find(
    (t) =>
      t.startsWith("You could stop working at") ||
      t.startsWith("You can retire at") ||
      t.startsWith("On these numbers"),
  );
  if (found === undefined) throw new Error(`no headline sentence in:\n${paragraphs(p).join("\n")}`);
  return found;
}

/** Every "This scenario assumes …" sentence — the overlap disclosures, in the order shown. */
export const assumptions = (p: Projection): string[] =>
  paragraphs(p).filter((t) => t.startsWith("This scenario assumes"));

/**
 * Alex and Sam, married at month 0, Sam holding one job and named as the household's only
 * continuation — Alex answers None, so every claim these tests make is unambiguously about
 * Sam's job and no second extension can account for it.
 *
 * `$60k` and a job ending at Sam's 50 are tuned so the solved age lands PAST that end: the
 * continuation is then load-bearing, which is the only condition under which the panel says
 * anything about it at all.
 */
export function alexAndSam(
  opts: { jobs?: readonly JobInput[]; joinAt?: number; separateAt?: number } = {},
) {
  const p = alexAlone();
  p.setContinuationJob(PRIMARY_PERSON_ID, null);
  const sam = p.marry({ month: opts.joinAt ?? 0, name: "Sam", birthYear: ALEX_BIRTH, lifeExpectancy: LIFE_EXPECTANCY });
  const jobIds = (opts.jobs ?? [jobAt(35, 50, 60_000)]).map((j) => p.addPartnerJob(sam, j));
  p.setContinuationJob(sam, jobIds[0]!);
  if (opts.separateAt !== undefined) p.separate({ month: opts.separateAt, partnerPersonId: sam });
  return { projection: p, sam, jobIds };
}
