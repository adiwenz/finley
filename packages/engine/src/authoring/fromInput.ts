/**
 * Interpreting a declarative {@link ScenarioInput} — how a document that names no ids becomes an
 * authored projection whose every id the engine minted.
 *
 * It drives the *public authoring methods* rather than the state functions beneath them, and that
 * is the point: each entry lands through the same write-time gate a live edit does, so an
 * unaffordable down payment or a separation before its marriage is refused here exactly as it
 * would be in the app. A path that assembled state directly would accept documents the UI cannot.
 *
 * `Projection` is named as a TYPE only, and the handle to fill arrives through `open` — so this
 * module sits under the facade in the import graph rather than beside it, and there is no runtime
 * cycle between them.
 */

import type { BudgetTarget } from "../budgetLine";
import { goalFundAccountId } from "../compile/projectionBase";
import { ageAboveMaximum } from "../plan";
import {
  PRIMARY_PERSON_REF,
  RETIREMENT_REF,
  WELL_KNOWN_REF_IDS,
  resolveRefs,
} from "../scenarioRefs";
import { ref } from "../scenarioInput";
import type {
  FromInputResult,
  JobEntry,
  Ref,
  ScenarioInput,
  ScenarioScalars,
} from "../scenarioInput";
import type { Projection } from "../projectionFacade";
import type { JobInput } from "./jobs";

/**
 * Apply `input` to a freshly opened projection, in two phases mirroring {@link resolveRefs}'s
 * resolution model. First the plan plane (`jobs`, `goals`, `budgetLines`) — no month, applied as
 * one block through the standing-edit methods; then `events` in the month-sorted order
 * `resolveRefs` returns, each through the matching authoring method.
 *
 * Refs are translated to ids through a registry filled as entries apply, seeded so a well-known
 * ref ({@link WELL_KNOWN_REF_IDS}) resolves to itself. `resolveRefs` has already proved every ref
 * resolves at the point it is used, so a lookup miss here is an engine bug, not a bad document —
 * surfaced as a thrown internal error rather than a refusal. The registry is local to this call
 * and dies with it: a ref names things while the document is being applied and is never written
 * into `Plan` or `Ledger`.
 *
 * All-or-nothing: the handle `open` returns is local until the last write lands, so a refused
 * document — a bad ref graph, or any refusal a method raises — answers `{ ok: false }` naming the
 * offending entry and yields no partial projection.
 */
export function interpretScenarioInput(
  input: ScenarioInput,
  open: (scalars: ScenarioScalars) => Projection,
): FromInputResult {
  const resolved = resolveRefs(input);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // Everything but the entry planes and the frozen `startYear` IS the plan's scalars; the three
  // id-bearing collections start EMPTY and are filled by the minting methods below. That is what
  // makes this an authoring path: the state it starts from holds no id at all, so restoration has
  // nothing to floor past and the counter opens at 1.
  const { jobs, goals, budgetLines, events: _events, continuationJobRef, ...scalars } = input;
  // `open` REFUSES an over-large age by throwing, which is right for a caller holding a handle
  // but wrong for a document: this path answers `{ ok: false }` with a reason, so the age is
  // checked here and reported like any other thing wrong with the input.
  const overAge = ageAboveMaximum(scalars);
  if (overAge) {
    return { ok: false, error: { reason: `${overAge.field} ${overAge.age} exceeds the ${overAge.limit} maximum` } };
  }
  const projection = open(scalars);

  const registry = new Map<Ref, string>();
  for (const id of WELL_KNOWN_REF_IDS) registry.set(ref(id), id);
  const idFor = (name: Ref): string => {
    const id = registry.get(name);
    if (id === undefined) throw new Error(`fromInput: ref "${name}" was accepted but never bound`);
    return id;
  };
  const bind = (name: Ref | undefined, id: string): void => {
    if (name !== undefined) registry.set(name, id);
  };

  // An id-free job to a {@link JobInput}: the deferral's account ref becomes an account id
  // (absent, it funds the standing 401(k)). `ownerRef` is resolved by the caller — a plan job
  // names its owner, a partner's job takes the owner `marry` mints — so it is dropped here.
  const toJobInput = (job: JobEntry): JobInput => {
    const { ref: _ref, ownerRef: _ownerRef, deferral, ...rest } = job;
    if (deferral === undefined) return rest;
    const { fundAccountRef, ...deferralRest } = deferral;
    return {
      ...rest,
      deferral: { ...deferralRest, fundAccountId: idFor(fundAccountRef ?? RETIREMENT_REF) },
    };
  };

  const refusal = (reason: string): FromInputResult => ({ ok: false, error: { reason } });
  const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  try {
    // Goals before jobs and budget lines: both can name a goal's fund account, and a goal points
    // at nothing, so this order binds every account ref before it is read. The plan plane is
    // mutually visible in `resolveRefs`, but application still needs a valid topological order,
    // and goals-first is one.
    for (const goal of goals ?? []) {
      const { ref, ...rest } = goal;
      bind(ref, goalFundAccountId({ ...rest, id: projection.addGoal(rest) }));
    }
    for (const job of jobs ?? []) {
      bind(job.ref, projection.addJob(idFor(job.ownerRef ?? PRIMARY_PERSON_REF), toJobInput(job)));
    }
    for (const line of budgetLines ?? []) {
      const { ref, target, ...rest } = line;
      const resolvedTarget: BudgetTarget =
        target.kind === "account"
          ? { kind: "account", accountId: idFor(target.accountRef), taxTreatment: target.taxTreatment }
          : { kind: "expense" };
      bind(ref, projection.addBudgetLine({ ...rest, target: resolvedTarget }));
    }
    // Last on this plane: it names a job, so every job entry has to be bound first. Omitted
    // stays omitted — "not chosen" is a state the engine resolves on read, and writing anything
    // here would settle it.
    if (continuationJobRef !== undefined) {
      projection.setContinuationJob(
        idFor(PRIMARY_PERSON_REF),
        continuationJobRef === null ? null : idFor(continuationJobRef),
      );
    }
  } catch (e) {
    return refusal(messageOf(e));
  }

  for (const { entry, index } of resolved.order) {
    try {
      switch (entry.type) {
        case "marry":
          bind(
            entry.ref,
            projection.marry({
              month: entry.month,
              name: entry.name,
              birthYear: entry.birthYear,
              ...(entry.benefitClaimingAge !== undefined ? { benefitClaimingAge: entry.benefitClaimingAge } : {}),
              ...(entry.jobs !== undefined ? { jobs: entry.jobs.map(toJobInput) } : {}),
            }),
          );
          break;
        case "haveChild":
          bind(
            entry.ref,
            projection.haveChild({
              month: entry.month,
              name: entry.name,
              annualCostCents: entry.annualCostCents,
              ...(entry.birthMonth !== undefined ? { birthMonth: entry.birthMonth } : {}),
            }),
          );
          break;
        case "startPartnered":
          bind(
            entry.ref,
            projection.startPartnered({
              partneredForMonths: entry.partneredForMonths,
              name: entry.name,
              birthYear: entry.birthYear,
              ...(entry.benefitClaimingAge !== undefined ? { benefitClaimingAge: entry.benefitClaimingAge } : {}),
              ...(entry.jobs !== undefined ? { jobs: entry.jobs.map(toJobInput) } : {}),
            }),
          );
          break;
        case "haveExistingChild":
          bind(
            entry.ref,
            projection.haveExistingChild({
              name: entry.name,
              ageMonths: entry.ageMonths,
              annualCostCents: entry.annualCostCents,
            }),
          );
          break;
        case "takeLoan": {
          const common = {
            month: entry.month,
            ownerId: idFor(entry.ownerRef),
            openingBalanceCents: entry.openingBalanceCents,
            apr: entry.apr,
          };
          bind(
            entry.ref,
            projection.takeLoan(
              entry.kind === "creditCard"
                ? { ...common, kind: "creditCard", creditLimitCents: entry.creditLimitCents }
                : { ...common, kind: entry.kind, termMonths: entry.termMonths },
            ),
          );
          break;
        }
        case "carryLoan": {
          const common = {
            ownerId: idFor(entry.ownerRef),
            balanceCents: entry.balanceCents,
            apr: entry.apr,
          };
          bind(
            entry.ref,
            projection.carryLoan(
              entry.kind === "creditCard"
                ? { ...common, kind: "creditCard", creditLimitCents: entry.creditLimitCents }
                : { ...common, kind: entry.kind, remainingTermMonths: entry.remainingTermMonths },
            ),
          );
          break;
        }
        case "buyHome":
          bind(
            entry.ref,
            projection.buyHome({
              month: entry.month,
              ownerId: idFor(entry.ownerRef),
              purchasePriceCents: entry.purchasePriceCents,
              downPaymentCents: entry.downPaymentCents,
              downPaymentSourceIds: entry.downPaymentSourceRefs.map(idFor),
              mortgageApr: entry.mortgageApr,
              mortgageTermMonths: entry.mortgageTermMonths,
              ...(entry.appreciationMode !== undefined ? { appreciationMode: entry.appreciationMode } : {}),
            }),
          );
          break;
        case "ownHome":
          bind(
            entry.ref,
            projection.ownHome({
              ownerId: idFor(entry.ownerRef),
              valueCents: entry.valueCents,
              ...(entry.mortgage !== undefined ? { mortgage: entry.mortgage } : {}),
              ...(entry.acquiredMonth !== undefined ? { acquiredMonth: entry.acquiredMonth } : {}),
              ...(entry.originalPriceCents !== undefined
                ? { originalPriceCents: entry.originalPriceCents }
                : {}),
              ...(entry.appreciationMode !== undefined
                ? { appreciationMode: entry.appreciationMode }
                : {}),
            }),
          );
          break;
        case "separate":
          bind(
            entry.ref,
            projection.separate({
              month: entry.month,
              partnerPersonId: idFor(entry.partnerRef),
              ...(entry.alimonyMonthlyCents !== undefined ? { alimonyMonthlyCents: entry.alimonyMonthlyCents } : {}),
              ...(entry.alimonyDurationMonths !== undefined ? { alimonyDurationMonths: entry.alimonyDurationMonths } : {}),
              ...(entry.childSupportMonthlyCents !== undefined ? { childSupportMonthlyCents: entry.childSupportMonthlyCents } : {}),
            }),
          );
          break;
        case "payOffDebt":
          bind(
            entry.ref,
            projection.payOffDebt({
              month: entry.month,
              liabilityId: idFor(entry.liabilityRef),
              accountId: idFor(entry.accountRef),
              amountCents: entry.amountCents,
            }),
          );
          break;
        default: {
          const exhaustive: never = entry;
          return exhaustive;
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: { reason: messageOf(e), eventIndex: index, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) },
      };
    }
  }

  return { ok: true, projection };
}
