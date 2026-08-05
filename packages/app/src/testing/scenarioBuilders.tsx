/**
 * The end-to-end scenario vocabulary, shared across scenario files. Each builder authors a
 * household through the public `Projection` API exactly as a user would through the UI, and each
 * reader pulls the SENTENCES the retirement panel puts on screen — solved against the real US
 * jurisdiction, rendered through the real component. A scenario file imports these and is a few
 * assertions; without them a second file would re-implement the whole harness.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { Projection, PRIMARY_PERSON_ID, dollarsToCents, type JobInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./projectionHarness";
import { retirementView } from "../retirementView";
import { RetirementPanel } from "../components/retirementPanel/retirementPanel";
import { PLAN_DEFAULTS } from "../planDefaults";
import { START_YEAR } from "../config";

const ALEX_AGE = PLAN_DEFAULTS.currentAge;
const ALEX_BIRTH = START_YEAR - ALEX_AGE;
/** Life expectancy the portfolio-lasts sentences quote — exported so assertions read it too. */
export const LIFE_EXPECTANCY = PLAN_DEFAULTS.lifeExpectancy;

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
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) =>
    m[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&#x2019;/g, "’")
      .replace(/&#x2013;/g, "–")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  );
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
  const sam = p.marry({ month: opts.joinAt ?? 0, name: "Sam", birthYear: ALEX_BIRTH });
  const jobIds = (opts.jobs ?? [jobAt(35, 50, 60_000)]).map((j) => p.addPartnerJob(sam, j));
  p.setContinuationJob(sam, jobIds[0]!);
  if (opts.separateAt !== undefined) p.separate({ month: opts.separateAt, partnerPersonId: sam });
  return { projection: p, sam, jobIds };
}
