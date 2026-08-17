/**
 * The Jobs workspace's gantt: every job in the household as a bar on one shared calendar.
 *
 * A gantt rather than a list because the questions this screen answers are about overlap and
 * gaps — when two jobs run together, when nobody is earning, how long a career actually is.
 * A list sorted by start date shows none of that.
 *
 * The window is fixed relative to "now" rather than fitted to the jobs, so the today marker
 * lands in a stable place and two households' charts are comparable. Jobs are clipped to it;
 * a job entirely outside the window is dropped rather than squeezed to a sliver.
 */

import type { Household, Job, Projection } from "@finley/engine";
import { START_YEAR } from "./config";
import { abbreviateDollars } from "./homeView";

/** Years of history and future the chart shows. Past is shorter: the plan is about what's next. */
const YEARS_BEFORE = 12;
const YEARS_AFTER = 32;

/** The bar palette, cycled per person so one household's jobs stay visually grouped. */
const BAR_COLORS = [
  "var(--leaf-700)",
  "var(--leaf-500)",
  "var(--sky-500)",
  "var(--bark-500)",
] as const;

export interface GanttBar {
  readonly id: string;
  readonly name: string;
  /** Current pay, abbreviated — "$104k/yr". */
  readonly pay: string;
  /** CSS percentages into the chart's own width. */
  readonly left: string;
  readonly width: string;
  readonly color: string;
  /** "2016 – 2056", or the same span in the owner's ages. */
  readonly range: string;
}

export interface GanttGroup {
  readonly personId: string;
  /** "Alex · age 40 today" — omitted from the render when the household has one earner. */
  readonly label: string;
  readonly bars: readonly GanttBar[];
}

export interface JobsGanttView {
  readonly groups: readonly GanttGroup[];
  readonly ticks: readonly string[];
  /** Where "today" falls across the chart, as a CSS percentage. */
  readonly todayPct: string;
  /** True when the household has more than one earner, so groups need naming. */
  readonly named: boolean;
}

export function jobsGanttView(
  household: Household,
  projection: Projection,
  labelBy: "dates" | "ages",
): JobsGanttView {
  const firstYear = START_YEAR - YEARS_BEFORE;
  const lastYear = START_YEAR + YEARS_AFTER;
  const span = lastYear - firstYear;
  const pct = (year: number) => ((year - firstYear) / span) * 100;

  const ticks: string[] = [];
  for (let year = firstYear; year <= lastYear; year += 6) {
    ticks.push(labelBy === "ages" ? `age ${year - START_YEAR}` : String(year));
  }

  const groups: GanttGroup[] = [];
  let colorIndex = 0;

  for (const membership of household.memberships) {
    const person = membership.person;
    const age = START_YEAR - person.birthYear;
    const bars: GanttBar[] = [];

    const ordered = [...person.jobs].sort((a, b) => a.startYear - b.startYear);
    for (const job of ordered) {
      const start = Math.max(firstYear, job.startYear);
      const end = Math.min(lastYear, job.endYear);
      // A job wholly outside the window has nothing to draw; a zero-width bar would read as a
      // job that lasted no time.
      if (end <= start) continue;
      bars.push({
        id: job.id,
        name: jobName(job),
        pay: `${abbreviateDollars(projection.jobMonthlyIncomeCents(job.id) * 12)}/yr`,
        left: `${pct(start).toFixed(2)}%`,
        width: `${(pct(end) - pct(start)).toFixed(2)}%`,
        color: BAR_COLORS[colorIndex++ % BAR_COLORS.length]!,
        range:
          labelBy === "ages"
            ? `age ${job.startYear - person.birthYear}–${job.endYear - person.birthYear}`
            : `${job.startYear} – ${job.endYear}`,
      });
    }

    if (bars.length === 0) continue;
    groups.push({
      personId: person.id,
      label: `${person.name} · age ${age} today`,
      bars,
    });
  }

  return {
    groups,
    ticks,
    todayPct: `${pct(START_YEAR).toFixed(2)}%`,
    named: groups.length > 1,
  };
}

/** A job's own name, or a plain fallback — never an id, which means nothing to a reader. */
function jobName(job: Job): string {
  return job.name?.trim() || "Job";
}
