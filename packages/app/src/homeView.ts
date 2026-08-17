/**
 * Presentation logic for the home screen — the rail's three "current life" cards, the life-change
 * list, the stop-working headline, and the ordered life timeline.
 *
 * Everything here is a read off one {@link ProjectionResult} plus the ledger. Nothing recomputes
 * engine arithmetic: the headline age comes from {@link RetirementView} (which the retirement
 * solver produced), the figures come from month 0 of the run, and an event's position comes from
 * its own `month`. A surface that restated any of these would be a second opinion about a number
 * the engine already answered.
 *
 * Money is never coloured red-for-bad here. Debt is stated as a magnitude with a bark tint, which
 * is a category signal, not a judgement — the brand refuses to shame.
 */

import type { Cents, Ledger, LifeEvent, Plan, ProjectionResult, ProjectionSeries } from "@finley/engine";
import { START_YEAR } from "./config";
import { summarizeEvent } from "./ledgerView";
import type { RetirementView } from "./retirementView";
import type { IconName } from "./components/ds/icon";

/**
 * The cash flows for "now".
 *
 * `series.opening` is the pre-simulation POSITION — balances only — so it carries no flows at
 * all; reading income or spending off it silently yields zero. Month 0 is the first simulated
 * month and the one every "today" figure means. Shared so no surface rediscovers this the hard
 * way.
 */
export function currentFlows(series: ProjectionSeries) {
  return series.months[0]?.flows;
}

/** A whole-dollar figure, abbreviated: `$1.2m`, `$430k`, `$820`. For headline tiles and axes. */
export function abbreviateDollars(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1_000_000) {
    // Two decimals below $10m, one above — enough precision to distinguish $1.24m from $1.31m
    // without spending four characters on a figure the reader is only comparing at a glance.
    const millions = (dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 1 : 2);
    return `${sign}$${millions.replace(/0+$/, "").replace(/\.$/, "")}m`;
  }
  if (dollars >= 1000) return `${sign}$${Math.round(dollars / 1000)}k`;
  return `${sign}$${Math.round(dollars)}`;
}

/**
 * The icon and tint each life event carries, everywhere it appears — rail row, timeline dot,
 * chart marker. One map so a home purchase is never a house in one place and a bank in another.
 *
 * The tints are literal palette values rather than semantic aliases on purpose: these are
 * category colours for a legend, not states, and there is no semantic role for "this row is
 * about a child".
 */
const EVENT_STYLE: Record<LifeEvent["type"], { readonly icon: IconName; readonly color: string }> = {
  RelationshipEvent: { icon: "heart-handshake", color: "var(--leaf-600)" },
  ChildEvent: { icon: "baby", color: "var(--sun-500)" },
  SeparationEvent: { icon: "users", color: "var(--ink-400)" },
  HomePurchaseEvent: { icon: "home", color: "var(--leaf-600)" },
  LoanEvent: { icon: "landmark", color: "var(--berry-500)" },
  DebtPayoffEvent: { icon: "shield-check", color: "var(--leaf-700)" },
  OneTimeSpendEvent: { icon: "receipt", color: "var(--bark-500)" },
};

/** One row in the rail's "Life changes" list, and one dot on the ordered timeline. */
export interface LifeChangeRow {
  readonly id: string;
  readonly label: string;
  /** The event's specifics — an amount, a rate, a name. Never a restatement of the label. */
  readonly detail: string;
  /** "Age 47", in the primary's own years. */
  readonly ageLabel: string;
  readonly month: number;
  readonly icon: IconName;
  readonly color: string;
}

/** One "current life" card in the rail. */
export interface RailCard {
  readonly id: "income" | "spending" | "networth";
  readonly label: string;
  readonly icon: IconName;
  readonly value: string;
  readonly sub: string;
}

export interface HomeView {
  /** "You could stop working at" — the eyebrow above the headline figure. */
  readonly headlineEyebrow: string;
  /** The solved age, or "Not yet" when the plan never reaches one. */
  readonly headlineValue: string;
  /** "years old", or empty when there is no age to qualify. */
  readonly headlineUnit: string;
  /** The calendar year the age lands in, or why there is none. */
  readonly headlineSub: string;
  /**
   * The plan reaches no stop-working age. Surfaced as an advisory block, in the honey warning
   * tone rather than the danger red — an unreached goal is information, not a failure.
   */
  readonly unreachable: boolean;
  readonly unreachableTitle: string;
  readonly unreachableBody: string;
  readonly railCards: readonly RailCard[];
  readonly lifeChanges: readonly LifeChangeRow[];
  /** "3 planned", or empty when the plan has none yet. */
  readonly changeCountLabel: string;
  readonly householdLine: string;
}

/** The primary's age at an absolute simulation month. */
function ageAtMonth(plan: Plan, month: number): number {
  return START_YEAR + Math.floor(month / 12) - plan.primary.birthYear;
}

export function homeView(
  plan: Plan,
  ledger: Ledger,
  result: ProjectionResult,
  retirement: RetirementView,
): HomeView {
  const opening = result.series.opening;
  const flows = currentFlows(result.series);
  // Month 0 states a monthly rate; the rail's income card reads yearly, which is how a salary is
  // spoken about. Spending stays monthly for the same reason — nobody quotes a yearly grocery bill.
  const annualIncomeCents = (flows?.totalIncomeCents ?? 0) * 12;
  const monthlySpendCents = (flows?.expensesCents ?? 0) + (flows?.liabilityPaymentsCents ?? 0);

  const assetsCents =
    Object.values(opening.accountBalancesCents).reduce((sum, c) => sum + c, 0) +
    Object.values(opening.propertyValuesCents).reduce((sum, c) => sum + c, 0);
  const debtCents = Object.values(opening.liabilityBalancesCents).reduce((sum, c) => sum + c, 0);
  const netWorthCents = opening.netWorthRealCents ?? assetsCents - debtCents;

  const railCards: RailCard[] = [
    {
      id: "income",
      label: "Income",
      icon: "trending-up",
      value: abbreviateDollars(annualIncomeCents),
      sub: "per year, before tax",
    },
    {
      id: "spending",
      label: "Spending",
      icon: "wallet",
      value: abbreviateDollars(monthlySpendCents),
      sub: "per month, household",
    },
    {
      id: "networth",
      label: "Net worth",
      icon: "piggy-bank",
      value: abbreviateDollars(netWorthCents),
      sub: `${abbreviateDollars(assetsCents)} assets · ${abbreviateDollars(debtCents)} debt`,
    },
  ];

  // Ordered by when they happen, not by when they were authored — the rail reads as a life.
  const lifeChanges: LifeChangeRow[] = [...ledger.events]
    .sort((a, b) => a.month - b.month)
    .map((event) => {
      const { label, detail } = summarizeEvent(event);
      const style = EVENT_STYLE[event.type];
      return {
        id: event.id,
        label,
        detail,
        ageLabel: `Age ${ageAtMonth(plan, event.month)}`,
        month: event.month,
        icon: style.icon,
        color: style.color,
      };
    });

  const age = retirement.headlineAge;
  // A partner is a ledger fact, not a plan field: they join the household through a relationship
  // event, so the roster is where "is this a two-person plan?" is answered. Anyone in the opening
  // roster who is not the primary is the partner — children are not memberships.
  const partner =
    result.household.memberships.find((m) => m.person.id !== plan.primary.id)?.person ?? null;
  const headlineEyebrow = partner
    ? `You and ${partner.name} could stop working at`
    : "You could stop working at";

  return {
    headlineEyebrow,
    headlineValue: age === null ? "Not yet" : String(age),
    headlineUnit: age === null ? "" : "years old",
    headlineSub:
      age === null
        ? "No stop-working date yet"
        : `${START_YEAR + (age - (START_YEAR - plan.primary.birthYear))}`,
    unreachable: age === null,
    unreachableTitle: retirement.blocked
      ? "Something in your plan can't be funded yet."
      : "Your plan doesn't reach a point where you can stop working yet.",
    unreachableBody: retirement.blocked
      ? "An obligation runs out of money before the plan finishes. Adjust its date, its amount, or where it draws from."
      : "Try adjusting spending, income, savings, or your future plans — small changes to spending move this date the most.",
    railCards,
    lifeChanges,
    changeCountLabel: lifeChanges.length > 0 ? `${lifeChanges.length} planned` : "",
    householdLine: partner
      ? `You are ${ageAtMonth(plan, 0)} · ${partner.name} is ${START_YEAR - partner.birthYear}`
      : `Age ${ageAtMonth(plan, 0)}`,
  };
}
