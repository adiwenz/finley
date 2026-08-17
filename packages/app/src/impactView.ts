/**
 * "Impact on your plan" — what one life change is actually costing or buying.
 *
 * The delta is computed by running the plan a second time WITHOUT the change, and comparing the
 * two solved stop-working ages. That is a real counterfactual off the engine, not an estimate:
 * the same solver answers both halves, so the difference means exactly what it says.
 *
 * Deliberately not a live preview of un-committed keystrokes. Every event form owns its own
 * draft, and threading those drafts out to a shared projection would put a second, partially
 * validated authoring path beside the facade's. Comparing against the plan minus this change
 * needs nothing but the change's id, and answers the question the reader actually has once the
 * change is on the plan: "is this what is holding me back?"
 *
 * A second solve is not cheap, so callers must gate this on the drawer being open.
 */

import { Projection, type Jurisdiction, type ProjectionState } from "@finley/engine";
import { retirementView } from "./retirementView";
import { abbreviateDollars } from "./homeView";

export interface ImpactRow {
  readonly label: string;
  readonly value: string;
  /** Bark when the change pushes retirement later, leaf when it pulls it earlier. */
  readonly tone: "better" | "worse" | "neutral";
}

export interface ImpactView {
  readonly rows: readonly ImpactRow[];
  /** One plain-language sentence stating what the change did. Never a scold. */
  readonly note: string;
}

const TONE_COLOR: Record<ImpactRow["tone"], string> = {
  better: "var(--leaf-700)",
  worse: "var(--bark-600)",
  neutral: "var(--ink-900)",
};

export function impactToneColor(tone: ImpactRow["tone"]): string {
  return TONE_COLOR[tone];
}

/**
 * The impact of the event `eventId` on the plan `state` describes.
 *
 * Returns `null` when the counterfactual cannot be formed — the removal is refused because a
 * later event depends on this one, so "the plan without it" is not a plan. Better to show
 * nothing than a comparison against something that could not exist.
 */
export function impactView(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  eventId: string,
): ImpactView | null {
  const withChange = Projection.fromState(state, jurisdiction);
  const withResult = withChange.run(jurisdiction);
  const withAge = retirementView(withChange, jurisdiction).headlineAge;

  let withoutState: ProjectionState;
  try {
    withoutState = Projection.transact(state, jurisdiction, (p) => {
      p.removeTransaction(eventId);
    }).state;
  } catch {
    return null;
  }

  const without = Projection.fromState(withoutState, jurisdiction);
  const withoutAge = retirementView(without, jurisdiction).headlineAge;

  const rows: ImpactRow[] = [];

  if (withAge !== null && withoutAge !== null) {
    const delta = withAge - withoutAge;
    rows.push({
      label: "Stop working",
      value: `${withoutAge} → ${withAge}`,
      tone: delta > 0 ? "worse" : delta < 0 ? "better" : "neutral",
    });
  } else {
    rows.push({
      label: "Stop working",
      value: withAge === null ? "not yet reachable" : String(withAge),
      tone: withAge === null ? "worse" : "neutral",
    });
  }

  // The LAST month that states a net worth, not the last month outright: a run that blocked, or
  // one whose closing months carry no real figure, still has a last known position — and that is
  // the number the reader means by "where does this plan end up".
  const closing = [...withResult.series.months]
    .reverse()
    .find((m) => m.netWorthRealCents !== null);
  if (closing?.netWorthRealCents != null) {
    rows.push({
      label: "Net worth at the end of the plan",
      value: abbreviateDollars(closing.netWorthRealCents),
      tone: "neutral",
    });
  }

  return { rows, note: noteFor(withAge, withoutAge) };
}

/**
 * The sentence under the figures.
 *
 * Framed as information throughout — a change that delays retirement is described, not judged.
 * The reader chose to model it; the app's job is to say what it does.
 */
function noteFor(withAge: number | null, withoutAge: number | null): string {
  if (withAge === null && withoutAge !== null) {
    return "With this change your plan doesn’t reach a point where you can stop working. Try a later date or a smaller amount.";
  }
  if (withAge === null) {
    return "This plan doesn’t reach a point where you can stop working yet — with or without this change.";
  }
  if (withoutAge === null) {
    return "This change is what makes a stop-working date reachable at all.";
  }

  const delta = withAge - withoutAge;
  if (delta === 0) return "This change leaves your stop-working date where it is.";
  const years = Math.abs(delta);
  const unit = years === 1 ? "year" : "years";
  return delta > 0
    ? `This change moves your stop-working date about ${years} ${unit} later.`
    : `This change moves your stop-working date about ${years} ${unit} earlier.`;
}
