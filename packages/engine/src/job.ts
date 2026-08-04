/**
 * The `Job` standing authoring model — the sole source of truth for earned income. A job is
 * held by a {@link import("./person").Person} and compiles into the simulator via
 * {@link import("./compilePerson")}.
 *
 * Must not import from `projection/*`; that dependency lives in `compilePerson`.
 */

import type { Cents } from "./money";
import { RETIREMENT_ID } from "./ids";

/** Stable id of a household member. */
export type PersonId = string;

/**
 * A job's salary path across the month-0 boundary: **two independently authored anchors** and
 * a *real* (above-CPI) growth rate. The engine layers CPI on top — indexing backward for the
 * covered-wage record, nominal growth forward for the projected income series.
 *
 * `startingSalaryCents` anchors the job at its own `startYear` and feeds only the **historical
 * compensation reconstruction** — what was actually earned from the job's start through month
 * −1, with {@link JobPayChange}s and {@link JobIncomeOverride}s layered on in date order.
 *
 * It is stated in **the money of that year** — the actual paycheck, what the payslip said —
 * NOT in today's dollars. This is the one authored figure in the model denominated in anything
 * other than today's money, and deliberately so: a past wage is a fact the user remembers, and
 * asking them to restate it in dollars that did not exist yet is a conversion they should never
 * have to do. The engine takes it verbatim and inflates it forward, rather than de-indexing it
 * backward. `JobPayChange.cents` is dated the same way, so every past figure in the model is
 * the paycheck of its own month and they compose without conversion.
 *
 * `currentSalaryCents` anchors the job at month 0 and is **authoritative for everything
 * forward**: future growth and future pay changes compound from it, never from the
 * reconstructed history.
 *
 * The two are independent facts, not two views of one. The salary the history reconstructs at
 * month −1 need NOT equal `currentSalaryCents`, and a discontinuity there is accepted rather
 * than reconciled: deriving either anchor from the other would reapply historical raises on
 * top of a figure that already includes them.
 */
export interface SalaryTrajectory {
  /**
   * Annual, as of the owning job's `startYear`, **in that year's money** — the paycheck as it
   * was. Drives the historical reconstruction only, never the projected income series.
   */
  readonly startingSalaryCents: Cents;
  /**
   * Annual, as of month 0 ("now"). The authoritative base for all projected compensation.
   * Required: a job with no authored current salary has no defined projected pay, so there is
   * deliberately no fallback to re-deriving one from `startingSalaryCents`.
   */
  readonly currentSalaryCents: Cents;
  /** Whole-number percent; 0 = flat in real terms. */
  readonly realGrowthPct: number;
}

/**
 * A one-month perturbation of a job's earned income — a bonus, a missed paycheck, a one-off
 * correction. A value edit on the standing job, never a timeline life event.
 *
 * Rides the job's own income series, so it is taxed as `wages` and flows through the job's
 * 401(k) deferral like regular pay.
 */
export interface JobIncomeOverride {
  /**
   * Stable authored identity, minted once and preserved through every edit, serialization and
   * projection. A month does NOT name an adjustment: several may share one — a signing bonus
   * and a missed paycheck can land together, and both are real. The id is what a surface keys
   * a list row on and what {@link withoutIncomeOverride} removes, so removing one leaves the
   * others exactly where they were.
   */
  readonly id: string;
  /** Absolute simulation month (from "now") the override applies to. */
  readonly month: number;
  readonly kind: "setTo" | "addBonus";
  /** For `setTo`, the month's absolute monthly pay; for `addBonus`, the amount added. */
  readonly cents: Cents;
}

/** A one-month adjustment as a caller authors it — the id is the engine's to issue. */
export type JobIncomeOverrideInput = Omit<JobIncomeOverride, "id">;

/**
 * What a month pays once ONE adjustment is applied to what already stands there — the single
 * definition of what an adjustment *means*, and the only place the arithmetic lives.
 *
 * Every surface reads through it: the projection compiler, the authoring chart, the pay
 * timeline, and the Base + Adjustments list. They cannot agree by coincidence, and a duplicated
 * `kind === "setTo" ? … : base + …` in the UI is a second definition that drifts the first time
 * either changes — which is exactly what it did.
 *
 * `basePayCents` is what the month pays *before this adjustment*, which for the second of two
 * stacked adjustments is the first one's result. Stacking therefore needs no special case: fold
 * this over {@link orderedIncomeOverrides} and the composition falls out.
 *
 * Two rules it owns:
 *
 *  - **Zero floor.** A deduction larger than the paycheck is a missed paycheck, never a negative
 *    one — the household cannot be billed by its employer.
 *  - **Whole cents.** Cents are integers everywhere in the model; rounding here means no caller
 *    can introduce a fractional cent that a later comparison then fails on.
 */
export function applyJobIncomeOverride(
  basePayCents: Cents,
  override: JobIncomeOverride,
): Cents {
  const target = override.kind === "setTo" ? override.cents : basePayCents + override.cents;
  return Math.max(0, Math.round(target));
}

/**
 * A job's one-month adjustments in the order they apply — the ordering rule the compiler and
 * every authoring surface share, so none of them can stack in a different order than the
 * projection pays.
 *
 * By month, then **by authoring order** within a month, since `sort` is stable. Authoring order
 * is the only defensible tie-break: two adjustments dated the same month have nothing else to
 * separate them, and the user watched themselves add the second one after the first. It matters
 * whenever a `setTo` shares a month with an additive adjustment — a `setTo` authored first is a
 * new baseline the bonus then adds to, and authored second it discards the bonus, which is what
 * "set this month's pay to X" says.
 */
export function orderedIncomeOverrides(
  overrides: readonly JobIncomeOverride[],
): readonly JobIncomeOverride[] {
  return [...overrides].sort((a, b) => a.month - b.month);
}

/**
 * What a job's `month` pays once every adjustment dated there is applied to `basePayCents` —
 * the whole stack, folded in {@link orderedIncomeOverrides} order. Returns `basePayCents`
 * untouched for a month carrying none, which is nearly every month.
 */
export function applyJobIncomeOverridesAt(
  basePayCents: Cents,
  overrides: readonly JobIncomeOverride[],
  month: number,
): Cents {
  return orderedIncomeOverrides(overrides)
    .filter((o) => o.month === month)
    .reduce((pay, override) => applyJobIncomeOverride(pay, override), basePayCents);
}

/**
 * A raise or a cut. Where a {@link JobIncomeOverride} perturbs one month, a pay change opens a
 * new salary segment: in force from `month`, then growing at the job's own real-plus-CPI rate.
 * A value edit, so it rides ONE continuous job instead of splitting it in two.
 *
 * Taxed as `wages` and flows through the 401(k) deferral, like overrides. `cents` is nominal at
 * `month` (the actual paycheck), matching the one-month `setTo`.
 *
 * `month` alone decides which side of "now" a change belongs to — there is no scope flag. A
 * change dated before month 0 reconstructs history: it holds from its effective month through
 * month −1, or until a later historical change supersedes it, and is then dropped at the
 * month-0 current-salary anchor. A change dated after month 0 is a future raise, applied on
 * top of that anchor.
 *
 * A change dated *at* month 0 is the one case where the authored month and the month it takes
 * effect differ — see {@link payChangeEffectiveMonth}.
 */
export interface JobPayChange {
  /**
   * Stable authored identity — see {@link JobIncomeOverride.id}. A pay change is at most one per
   * (job, month), so unlike an override its month *does* name it; it carries an id anyway so that
   * every authored adjustment is addressed the same way, and so a list mixing the two kinds has
   * one key rule rather than two.
   */
  readonly id: string;
  /**
   * Absolute simulation month (from "now") the change is **authored at**. The month it takes
   * force is {@link payChangeEffectiveMonth} of it, which differs only at month 0.
   */
  readonly month: number;
  readonly kind: "setTo" | "changeBy";
  /** For `setTo`, the new monthly pay; for `changeBy`, the amount added on — negative is a cut. */
  readonly cents: Cents;
}

/** A pay change as a caller authors it — the id is the engine's to issue. */
export type JobPayChangeInput = Omit<JobPayChange, "id">;

/**
 * **The two kinds compose in one order, always: salary state first, then the month's payment.**
 *
 * A {@link JobPayChange} establishes what the job PAYS from its month forward — it changes the
 * salary, and every later month inherits it. A {@link JobIncomeOverride} changes only what is
 * paid IN its month; it settles nothing and the next month is unaffected by it.
 *
 * So where both are dated the same month, the raise sets that month's salary and the one-month
 * adjustment then acts on the raised figure. A missed paycheck against a same-month raise pays
 * $0 that month and the raised salary from the next one — both authored facts survive, because
 * they are answers to different questions. `compilePersonIncomeSeries` enforces this by calling
 * `applyPayChanges` before `applyIncomeOverrides`, and `jobPayPath` compiles the salary state
 * alone, which is why an authoring surface layers the adjustments on top of what it returns.
 */

/**
 * The month a permanent pay change actually takes force: its own, except at month 0, where it
 * is month 1.
 *
 * `currentSalaryCents` is authoritative for month 0 — that is the whole basis of the forward
 * anchor (see {@link SalaryTrajectory}), so a change cannot both be dated "now" and displace
 * the figure that defines "now". Deferring it by one month keeps both facts: the stated current
 * salary is what this month pays, and the raise the user just authored is real from next month.
 * The alternative readings were to let the change silently override the anchor it was authored
 * beside, or to drop it as out of range; both make an authored figure disappear.
 *
 * Only the month-0 boundary is special-cased. Month-negative changes are historical and month-1
 * and later are ordinary future raises, both unmoved — the engine is start-of-month everywhere
 * else, and shifting every change by one would change what a projection pays.
 *
 * A one-month {@link JobIncomeOverride} is NOT deferred: a bonus at month 0 adds to that month's
 * pay rather than replacing the base salary, so nothing about the anchor is in question.
 */
export function payChangeEffectiveMonth(change: JobPayChange): number {
  return change.month === 0 ? 1 : change.month;
}

/**
 * A job's permanent pay changes in the order they take force, each paired with the month it
 * does. Sorted by effective month, then by authored month, so the deferred month-0 changes land
 * ahead of any authored at month 1 — and, both being equal, in the order they were authored,
 * since `sort` is stable. The single ordering rule the projection compiler and
 * {@link jobPayPath} both read, so the two cannot drift.
 */
export function effectivePayChanges(
  changes: readonly JobPayChange[],
): readonly { readonly change: JobPayChange; readonly month: number }[] {
  return changes
    .map((change) => ({ change, month: payChangeEffectiveMonth(change) }))
    .sort((a, b) => a.month - b.month || a.change.month - b.change.month);
}

/**
 * Lives on the **job**, not the person, because the employer match and elected fraction are
 * properties of that employment. Compiles to the income source's
 * {@link import("./projection/waterfall").PlanDescriptor}.
 */
export interface JobDeferral {
  /** Fraction of THIS job's gross deferred pre-tax (0..1). */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds. */
  readonly fundAccountId: string;
  /** Employer match as a fraction of the amount deferred (e.g. 0.5 = 50%). */
  readonly employerMatchFraction?: number;
}

/**
 * **May a what-if run this job on past the date it was authored to end?**
 *
 * A policy the user states, not a shape the engine infers. It is read by the retirement solver
 * and the stop-working preview and by nothing else: the authored projection pays every job over
 * exactly the years it was given, whichever value this holds.
 *
 *  - `"extendable"` — a what-if testing a later stop-working age may carry this job past its
 *    authored end. The ordinary case: most employment is work you could simply keep doing.
 *  - `"fixed"` — it may not, at any age. A contract with a term, a fellowship, a role with a
 *    mandatory retirement: continuing it is not the user's to choose, so a plan that only
 *    survives by assuming they do is not an answer.
 *
 * **Never inferred from the dates.** Every job has an end year — that is what authoring one
 * means — so an end date says nothing about whether the work could continue past it, and a job
 * ending at 65 is neither more nor less fixed than one ending at 70. This is the *only* thing
 * that distinguishes them, which is why it is authored rather than derived.
 */
export type RetirementStrategy = "fixed" | "extendable";

/**
 * What a job gets when its author does not say — see {@link RetirementStrategy}.
 *
 * `"extendable"` because it is the assumption that keeps a solve HONEST about what it did.
 * Defaulting to `"fixed"` would make "when could you retire?" answer `null` for most households
 * — nothing may run past the authored plan, so no later age can ever help — and a user who
 * never met this field would read that as a finding about their finances rather than a
 * consequence of a default they never chose.
 */
export const DEFAULT_RETIREMENT_STRATEGY: RetirementStrategy = "extendable";

/**
 * An earned, covered income stream owned by exactly one person. Employment is per-person — a
 * two-earner household is two jobs, not one job with two owners — so every date on it resolves
 * against *the* owner's own clock without ambiguity. A person may hold any number of jobs, and
 * none is elevated over the others: there is no "career" job here, and no rule anywhere reads
 * one job of a person's as their real one.
 */
export interface Job {
  readonly id: string;
  /**
   * Display-only: reports and the income graph show it in place of the `id` when set. Never
   * an identity — the `id` keys the job and its income band's `sourceId`, so two jobs may
   * share a name or have none.
   */
  readonly name?: string;
  readonly ownerId: PersonId;
  readonly startYear: number;
  /**
   * Exclusive — worked in calendar years `[startYear, endYear)`. **Required**: every job says
   * when it ends.
   *
   * There is no open-ended job. A `null` end used to mean "runs until the owner's retirement
   * age", which quietly made a planning target into an employment boundary: a job authored to
   * start after that age disappeared from the projection the moment it was saved, because the
   * thing that ended it was a number the user had entered somewhere else entirely. An end date
   * is a fact about a job, and a job states its own.
   */
  readonly endYear: number;
  /**
   * Whether a what-if may run this job past {@link endYear} — see {@link RetirementStrategy}.
   * Required on the model and defaulted only at the authoring boundary, so nothing downstream
   * has to decide what an absent policy means.
   */
  readonly retirementStrategy: RetirementStrategy;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
  readonly incomeOverrides?: readonly JobIncomeOverride[];
  /**
   * Applied BEFORE the one-month {@link incomeOverrides}, so a bonus adds on top of the
   * changed pay.
   */
  readonly payChanges?: readonly JobPayChange[];
}

/**
 * Real growth rate (whole-number percent) between two salary points. Both are in today's
 * dollars, so the slope is real (above-CPI). Returns 0 for a non-positive span or a
 * non-positive earlier salary.
 */
export function deriveRealGrowthPct(
  earlierCents: Cents,
  earlierYear: number,
  laterCents: Cents,
  laterYear: number,
): number {
  const years = laterYear - earlierYear;
  if (years <= 0 || earlierCents <= 0) return 0;
  return (Math.pow(laterCents / earlierCents, 1 / years) - 1) * 100;
}

// ── Authoring transforms ──
//
// Pure, id-free, one job in and one job out. They live here, beside the type they edit,
// because BOTH write paths over a `Job` — the `Projection` API and the app's Jobs and
// Base + Adjustments panels — must apply the SAME rule. Two implementations of "0 removes
// the deferral" is a rule that can drift; keeping the rule in one place and duplicating
// only the wiring is what makes the two surfaces safe to keep.

/** Every editable {@link Job} field. The stable `id` and the `ownerId` are both out: a job
 * cannot change owner — re-reading its dates against another birthday would rewrite the
 * employment the person stated — so moving a job between members is delete-and-re-add, never a
 * patch. */
export type JobPatch = Partial<Omit<Job, "id" | "ownerId">>;

/** Apply `f` to the job with `id`, leaving the rest of the list alone. */
export function mapJob(
  jobs: readonly Job[],
  id: string,
  f: (job: Job) => Job,
): readonly Job[] {
  return jobs.map((j) => (j.id === id ? f(j) : j));
}

/**
 * Overwrite the named fields, carrying everything else through — the other salary fields,
 * the deferral's funded account and employer match, accumulated adjustments, and any field
 * added to {@link Job} later. Neither `id` nor `ownerId` is in {@link JobPatch}, so an edit can
 * re-point a job to neither a new identity nor a new owner.
 */
export function withJobPatch(job: Job, patch: JobPatch): Job {
  return { ...job, ...patch };
}

/**
 * Set pay in **monthly** cents, the denomination a person states income in; {@link Job}
 * stores the annualized figure. Leaves the growth rate alone.
 *
 * Sets BOTH salary anchors to the stated figure: "this job pays X" means a flat history, and
 * the deviations from it are exactly what a {@link JobPayChange} is for. That is the right rule
 * for a job stated in ONE number — a job being authored for the first time, or a surface that
 * shows one salary field.
 *
 * Flat in **paycheck** terms, note, not in real terms: the start anchor is the money of the
 * job's own year (see {@link SalaryTrajectory}), so a long-running job stated in one number
 * says "the payslip read X then and reads X now" — a real-terms decline. Correcting for that
 * would mean deriving one anchor from the other through CPI, which is exactly what the two
 * independent anchors exist to avoid; a user who means something else states the two.
 *
 * A surface that shows the two anchors separately writes them with
 * {@link withStartingMonthlyIncome} / {@link withCurrentMonthlyIncome} instead, so that editing
 * one authored fact cannot silently overwrite the other.
 */
export function withMonthlyIncome(job: Job, monthlyCents: Cents): Job {
  return {
    ...job,
    salary: {
      ...job.salary,
      startingSalaryCents: monthlyCents * 12,
      currentSalaryCents: monthlyCents * 12,
    },
  };
}

/**
 * Set the **start** anchor alone, in monthly cents — what the job paid in its own `startYear`,
 * which drives the historical reconstruction and nothing else. The current-salary anchor is
 * left exactly as authored: the two are independent facts, and re-deriving one from the other
 * is the thing {@link SalaryTrajectory} exists to refuse.
 */
export function withStartingMonthlyIncome(job: Job, monthlyCents: Cents): Job {
  return { ...job, salary: { ...job.salary, startingSalaryCents: monthlyCents * 12 } };
}

/**
 * Set the **month-0** anchor alone, in monthly cents — the figure the projection starts from.
 * Leaves the start anchor standing, for the same reason as {@link withStartingMonthlyIncome}:
 * a raise since the job began is not evidence about what it paid on day one.
 */
export function withCurrentMonthlyIncome(job: Job, monthlyCents: Cents): Job {
  return { ...job, salary: { ...job.salary, currentSalaryCents: monthlyCents * 12 } };
}

/**
 * Read pay back in **monthly** cents — the inverse of {@link withMonthlyIncome}, and the
 * reason it exists: a job stores an annual figure and every surface states a monthly one, so
 * the two halves of that conversion have to round the same way or a number typed into a form
 * comes back a cent different from what was typed.
 *
 * The CURRENT salary — the month-0 anchor, before future growth and before any future
 * {@link JobPayChange}. That is what a headline quotes and what an edit form seeds from: it is
 * the figure the projection actually starts from, where the starting salary is a historical
 * fact that may be decades stale.
 */
export function monthlyIncomeCentsOf(job: Job): Cents {
  return Math.round(job.salary.currentSalaryCents / 12);
}

/**
 * Read the **start** anchor back in monthly cents — the counterpart of
 * {@link withStartingMonthlyIncome}, rounding the same way {@link monthlyIncomeCentsOf} does so
 * a figure typed into a form comes back as it was typed.
 */
export function startingMonthlyIncomeCentsOf(job: Job): Cents {
  return Math.round(job.salary.startingSalaryCents / 12);
}

/**
 * The elected pre-tax 401(k) fraction (0..1), 0 when there is no deferral — the inverse of
 * {@link withDeferralFraction}, which removes the deferral outright at 0. The absent case is
 * that rule read back: no deferral and a 0% deferral are the same elected rate.
 */
export function deferralFractionOf(job: Job): number {
  return job.deferral?.deferralFraction ?? 0;
}

/**
 * Set the pre-tax 401(k) deferral as a fraction of THIS job's gross (0..1). A fraction of 0
 * *removes* the deferral rather than recording a 0% one, and any positive fraction preserves
 * the funded account and employer match — both properties of the employment, not of the
 * elected rate.
 */
export function withDeferralFraction(job: Job, fraction: number): Job {
  if (fraction <= 0) {
    const { deferral: _drop, ...rest } = job;
    return rest;
  }
  return {
    ...job,
    deferral: {
      deferralFraction: fraction,
      fundAccountId: job.deferral?.fundAccountId ?? RETIREMENT_ID,
      ...(job.deferral?.employerMatchFraction !== undefined
        ? { employerMatchFraction: job.deferral.employerMatchFraction }
        : {}),
    },
  };
}

/**
 * Attach a permanent raise or cut, in force from its month forward.
 *
 * **At most one per (job, month), unlike a one-month adjustment** — re-authoring a month
 * replaces what stood there. Not an arbitrary limit: a pay change opens a salary *segment*, and
 * two segments beginning the same month is a contradiction rather than a stack, since the second
 * would immediately supersede the first for every month either covers.
 *
 * Stacking within a month is what {@link withIncomeOverride} is for: several *payments* in one
 * month is an ordinary fact, where several *salaries* is not.
 */
export function withPayChange(job: Job, payChange: JobPayChange): Job {
  return {
    ...job,
    payChanges: [...(job.payChanges ?? []).filter((c) => c.month !== payChange.month), payChange],
  };
}

/** Drop the pay change with this id, if any; the field goes away entirely once empty. */
export function withoutPayChange(job: Job, payChangeId: string): Job {
  if (job.payChanges === undefined) return job;
  const kept = job.payChanges.filter((c) => c.id !== payChangeId);
  if (kept.length === job.payChanges.length) return job;
  if (kept.length === 0) {
    const { payChanges: _drop, ...rest } = job;
    return rest;
  }
  return { ...job, payChanges: kept };
}

/**
 * Attach a one-month income perturbation — a bonus, a missed paycheck, a correction. Where
 * {@link withPayChange} opens a new salary segment, this touches exactly one month.
 *
 * **Stacks.** Any number may share a month, and each stays its own authored fact: a signing
 * bonus, a performance bonus and a deduction in the same month are three things that happened,
 * and collapsing them into one figure would lose which was which and make the second edit erase
 * the first. They compose in {@link orderedIncomeOverrides} order, each applied to what the ones
 * before it left — see {@link applyJobIncomeOverride}.
 *
 * Appends rather than replacing, so nothing already authored is disturbed; editing one is
 * removing it by id and adding the new one.
 */
export function withIncomeOverride(job: Job, override: JobIncomeOverride): Job {
  return { ...job, incomeOverrides: [...(job.incomeOverrides ?? []), override] };
}

/**
 * Drop the one-month adjustment with this id, if any; the field goes away entirely once empty.
 *
 * By id, not by month: a month may hold several and removing "the bonus in March" has to mean
 * one of them. Removing by month would take the whole stack, which is how a second bonus used
 * to make the first one unreachable.
 */
export function withoutIncomeOverride(job: Job, overrideId: string): Job {
  if (job.incomeOverrides === undefined) return job;
  const kept = job.incomeOverrides.filter((o) => o.id !== overrideId);
  if (kept.length === job.incomeOverrides.length) return job;
  if (kept.length === 0) {
    const { incomeOverrides: _drop, ...rest } = job;
    return rest;
  }
  return { ...job, incomeOverrides: kept };
}

// ── The authored pay path ──
//
// What a job pays across its whole span, as the person authored it — the reading an editor
// needs to draw the salary it is editing, and the one place the month-0 seam is a number
// rather than a paragraph. `compilePerson` compiles the same two anchors into simulator series;
// this reads them back without a simulation, so an authoring surface can show a job's pay
// without running a projection over every keystroke.

/** A job's paying window, in simulation months from "now". Both bounds are the caller's:
 * an open-ended job stops at ITS OWNER's retirement age, which a job alone cannot know. */
export interface JobPaySpan {
  /** The month the job starts — negative for a job already under way. */
  readonly startMonth: number;
  /** One past the last month it pays. */
  readonly endMonthExclusive: number;
}

/**
 * A job's pay across its span, in either denomination — see {@link JobPayPathOptions}. By
 * default today's dollars: the anchors as authored, real growth compounding between changes,
 * and no CPI, because none of the figures that go in carry it. Given the plan's CPI it instead
 * reproduces the nominal paycheck the projection pays.
 *
 * The two anchors are read the way the engine reads them and no other way: months before 0 come
 * off `startingSalaryCents` with the pre-"now" pay changes on it, months from 0 come off
 * `currentSalaryCents` with the later ones. Nothing crosses the boundary — see
 * {@link SalaryTrajectory}. {@link monthZeroStepCents} is the size of that seam, which is an
 * authored fact and not an error to be closed.
 */
export interface JobPayPath {
  readonly span: JobPaySpan;
  /** The job's whole span is behind us: it has no month-0 pay, and never reads one. */
  readonly endedBeforeNow: boolean;
  /** Monthly cents at `month`, and 0 outside the span. */
  monthlyCentsAt(month: number): Cents;
  /**
   * What the reconstruction reaches in the last month it covers — month −1 for a job still
   * running, its final month for one already over. `null` when the job contributes no pre-"now"
   * month at all. For a job that ended, this is the figure a dead `currentSalaryCents` should
   * be pinned to: the engine never reads it, so what matters is which latent value fails
   * better if the end date later moves past "now".
   */
  readonly historyReachMonthlyCents: Cents | null;
  /**
   * `currentSalaryCents` minus what the history would pay in month 0 if it simply kept running
   * — the step at the seam, positive for a jump up. 0 when the job has no history.
   *
   * Measured against the history CONTINUED to month 0, not against
   * {@link historyReachMonthlyCents} at month −1. Those two differ by a whole growth step,
   * because pay is flat within a growth year and month −1 falls in the year before month 0's.
   * Comparing them would report that step as a discrepancy on every job that grows at all,
   * including one whose anchors agree perfectly — the arithmetic of annual growth, dressed up
   * as an authored disagreement.
   *
   * Reported to the nearest dollar, and 0 when the two agree to within one: a few cents of
   * year-by-year rounding is not a fact about anyone's pay.
   */
  readonly monthZeroStepCents: Cents;
}

/** One salary segment: a baseline anchored at a month, compounding at the job's growth rate. */
interface PaySegment {
  readonly fromMonth: number;
  readonly monthlyCents: Cents;
}

/** How to denominate the path. */
export interface JobPayPathOptions {
  /**
   * CPI as a decimal (0.03 = 3%). Default 0. Needed in BOTH denominations — it is what the
   * paycheck grows by, and separately what converts one denomination into the other.
   */
  readonly inflationRate?: number;
  /**
   * `"paycheck"` (default) is the figure on the payslip of each month: past anchors and pay
   * changes verbatim, since they are already stated in the money of their own month, growing
   * at real-plus-CPI from there. This is what the projection pays, to the cent.
   *
   * `"todaysDollars"` divides that by CPI back to month 0, so the whole span is comparable
   * against each other and against today's pay — a real-terms reading, where a flat line means
   * flat purchasing power. Month 0 is identical under both, because today's money IS the
   * paycheck today.
   */
  readonly denomination?: "paycheck" | "todaysDollars";
}

export function jobPayPath(job: Job, span: JobPaySpan, opts?: JobPayPathOptions): JobPayPath {
  const { startMonth, endMonthExclusive } = span;
  const inflationRate = opts?.inflationRate ?? 0;
  const inTodaysDollars = opts?.denomination === "todaysDollars";
  // Real and CPI compounded together — the same rate `salaryGrowthMode` builds.
  const realGrowth = job.salary.realGrowthPct / 100;
  const annualGrowth = (1 + realGrowth) * (1 + inflationRate) - 1;
  /**
   * Mirrors `SimCashFlowSeries` exactly rather than approximating it: pay is FLAT within a
   * growth year (whole years since the segment's anchor, floored) and each year's figure is
   * rounded to the cent before the next compounds on it. A single `Math.pow` would be neither
   * — it slopes through the year, and it drifts a cent or two off the projection over a career.
   * Both matter here, because this path is read against that projection.
   */
  const grownAt = (rate: number, segment: PaySegment, month: number): Cents => {
    if (rate === 0) return segment.monthlyCents;
    const years = Math.max(0, Math.floor((month - segment.fromMonth) / 12));
    let cents = segment.monthlyCents;
    for (let y = 0; y < years; y++) cents = Math.round(cents * (1 + rate));
    return cents;
  };
  /**
   * History does not grow — see `reconstructHistoricalCompensation`. The past is remembered, not
   * projected, so a historical segment holds its authored figure until the next authored one.
   *
   * The rate belongs to the SIDE, not to the month being asked about: continuing the history up
   * to month 0 to measure the seam must not suddenly compound it at the forward rate for every
   * year it ran.
   */
  const HISTORY_RATE = 0;

  // Read through the shared effective-month rule, so a change authored at month 0 opens its
  // segment at month 1 here exactly as it does in the projection compiler.
  const changes = effectivePayChanges(job.payChanges ?? []);

  /** The segments on one side of month 0, anchored at `anchorMonth` on `anchorCents`. */
  const segmentsOf = (
    rate: number,
    anchorMonth: number,
    anchorCents: Cents,
    lo: number,
    hi: number,
  ): PaySegment[] => {
    const segments: PaySegment[] = [{ fromMonth: anchorMonth, monthlyCents: anchorCents }];
    for (const { change, month } of changes) {
      if (month < lo || month > hi) continue;
      const before = segments[segments.length - 1];
      const cents =
        change.kind === "setTo" ? change.cents : grownAt(rate, before, month) + change.cents;
      segments.push({ fromMonth: month, monthlyCents: Math.max(0, cents) });
    }
    return segments;
  };

  // History runs from the job's own start to the month before "now" (or its end, if sooner);
  // the forward side is anchored at month 0 and clipped to the job's start if it begins later.
  const historyEndExclusive = Math.min(endMonthExclusive, 0);
  const forwardStart = Math.max(startMonth, 0);
  // Both anchors verbatim: each is already the paycheck of the month it anchors — the start
  // one in its own year's money, the current one in today's, which is the same thing at month
  // 0. Nothing is converted on the way in, exactly as `reconstructHistoricalCompensation` and
  // `compileJobIncome` read them.
  const history =
    historyEndExclusive > startMonth
      ? segmentsOf(
          HISTORY_RATE,
          startMonth,
          Math.round(job.salary.startingSalaryCents / 12),
          startMonth,
          historyEndExclusive - 1,
        )
      : null;
  const forward =
    endMonthExclusive > forwardStart
      ? segmentsOf(
          annualGrowth,
          forwardStart,
          Math.round(job.salary.currentSalaryCents / 12),
          forwardStart,
          endMonthExclusive - 1,
        )
      : null;

  /**
   * The one place a denomination is applied, so every figure below it agrees by construction.
   * CPI back to month 0 — continuous, not the annual step `grown` uses, because this is a unit
   * conversion and not another year of growth. A no-op for the paycheck reading, and at month 0
   * in either.
   */
  const denominated = (nominalCents: Cents, month: number): Cents =>
    inTodaysDollars && inflationRate !== 0
      ? Math.round(nominalCents / Math.pow(1 + inflationRate, month / 12))
      : nominalCents;

  const at = (rate: number, segments: PaySegment[], month: number): Cents => {
    let held = segments[0];
    for (const s of segments) if (s.fromMonth <= month) held = s;
    return grownAt(rate, held, month);
  };

  const monthlyCentsAt = (month: number): Cents => {
    if (month < startMonth || month >= endMonthExclusive) return 0;
    const side = month < 0 ? history : forward;
    const rate = month < 0 ? HISTORY_RATE : annualGrowth;
    return side === null ? 0 : denominated(at(rate, side, month), month);
  };

  const historyReachMonth = historyEndExclusive - 1;
  const historyReachMonthlyCents =
    history === null
      ? null
      : denominated(at(HISTORY_RATE, history, historyReachMonth), historyReachMonth);
  const endedBeforeNow = endMonthExclusive <= 0;

  // What the history would pay in month 0 if nothing stopped it — the like-for-like partner
  // for the current anchor, which needs no conversion in either denomination because it IS
  // month 0.
  const historyContinuedToMonthZero =
    history === null ? null : at(HISTORY_RATE, history, 0);
  const rawStep =
    historyContinuedToMonthZero === null || endedBeforeNow
      ? 0
      : Math.round(job.salary.currentSalaryCents / 12) - historyContinuedToMonthZero;

  return {
    span,
    endedBeforeNow,
    monthlyCentsAt,
    historyReachMonthlyCents,
    monthZeroStepCents: Math.abs(rawStep) < 100 ? 0 : Math.round(rawStep / 100) * 100,
  };
}
