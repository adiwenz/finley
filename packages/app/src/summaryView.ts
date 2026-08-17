/**
 * The three read-only summaries behind the rail cards: income, spending, and net worth.
 *
 * Each answers one question — "what is this figure made of?" — and then hands the reader to the
 * workspace that edits it. Nothing here writes, which is why they are drawers rather than pages:
 * a summary the reader consults should not cost them their place in the plan.
 *
 * Every figure is read off the engine (`expenseRowsAt`, `jobMonthlyIncomeCents`, month 0's
 * balances) rather than summed from the plan, so a drawer can never quote a number the
 * projection disagrees with.
 */

import {
  liabilityKindLabel,
  type Household,
  type Projection,
  type ProjectionResult,
} from "@finley/engine";
import { formatDollars } from "./format";
import { abbreviateDollars, currentFlows } from "./homeView";

/** One line in a summary drawer. A group row is a subtotal; an item row is a component of it. */
export interface SummaryRow {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
  readonly value: string;
  /** `debt` tints the figure bark-brown — a category signal, never a judgement. */
  readonly tone?: "default" | "debt";
  readonly isGroup?: boolean;
}

export interface SummaryDrawerView {
  readonly title: string;
  readonly sub: string;
  /** The eyebrow above the big total. */
  readonly eyebrow: string;
  readonly total: string;
  readonly totalSub: string;
  readonly rows: readonly SummaryRow[];
  /** Where this summary hands off to. The drawer's one green action. */
  readonly cta: { readonly label: string; readonly view: "jobs" | "spending" | "accounts" };
}

export function incomeSummary(
  household: Household,
  projection: Projection,
  result: ProjectionResult,
): SummaryDrawerView {
  const annualCents = (currentFlows(result.series)?.totalIncomeCents ?? 0) * 12;
  const rows: SummaryRow[] = [];

  for (const membership of household.memberships) {
    const jobs = membership.person.jobs;
    if (jobs.length === 0) continue;
    // Only name whose jobs these are when there is more than one earner to distinguish.
    if (household.memberships.length > 1) {
      rows.push({
        id: `person-${membership.person.id}`,
        label: membership.person.name,
        value: "",
        isGroup: true,
      });
    }
    for (const job of jobs) {
      rows.push({
        id: job.id,
        label: job.name ?? "Job",
        sub: `${formatDollars(projection.jobMonthlyIncomeCents(job.id))}/mo`,
        value: formatDollars(projection.jobMonthlyIncomeCents(job.id) * 12),
      });
    }
  }

  return {
    title: "Income",
    sub: "What the household earns today",
    eyebrow: "Household income",
    total: formatDollars(annualCents),
    totalSub: "per year, before tax",
    rows,
    cta: { label: "Manage jobs & income", view: "jobs" },
  };
}

export function spendingSummary(projection: Projection, result: ProjectionResult): SummaryDrawerView {
  // Month 0: what the household spends now, which is the figure the rail card showed.
  const lines = projection.expenseRowsAt(0);
  const flows = currentFlows(result.series);
  const expensesCents = flows?.expensesCents ?? 0;
  const debtPaymentsCents = flows?.liabilityPaymentsCents ?? 0;

  const rows: SummaryRow[] = lines.map((line) => ({
    id: line.lineId,
    label: line.label,
    sub: line.overridden ? "Changed from the base amount" : undefined,
    value: formatDollars(line.monthlyCents),
  }));

  // Debt payments are spending the reader cannot edit as a budget line — they belong to a
  // liability — so they are stated separately rather than folded into an untouchable row.
  if (debtPaymentsCents > 0) {
    rows.push({
      id: "debt-payments",
      label: "Debt payments",
      sub: "Mortgage and loans",
      value: formatDollars(debtPaymentsCents),
      tone: "debt",
    });
  }

  return {
    title: "Spending",
    sub: "Household spending today",
    eyebrow: "Household spending",
    total: formatDollars(expensesCents + debtPaymentsCents),
    totalSub: "per month",
    rows,
    cta: { label: "Edit spending", view: "spending" },
  };
}

export function netWorthSummary(
  projection: Projection,
  household: Household,
  result: ProjectionResult,
): SummaryDrawerView {
  const opening = result.series.opening;
  const descriptors = projection.accountDescriptors();

  const rows: SummaryRow[] = [];
  let assetsCents = 0;

  for (const descriptor of descriptors) {
    const balance = opening.accountBalancesCents[descriptor.id] ?? 0;
    assetsCents += balance;
    // A zero account is noise in a summary — it tells the reader nothing about what they have.
    if (balance === 0) continue;
    rows.push({ id: descriptor.id, label: descriptor.label, value: formatDollars(balance) });
  }

  for (const [id, value] of Object.entries(opening.propertyValuesCents)) {
    assetsCents += value;
    rows.push({ id, label: "Property", value: formatDollars(value) });
  }

  let debtCents = 0;
  for (const liability of household.liabilities) {
    const balance = opening.liabilityBalancesCents[liability.id] ?? 0;
    if (balance === 0) continue;
    debtCents += balance;
    rows.push({
      id: liability.id,
      label: liabilityKindLabel(liability.kind),
      value: `−${formatDollars(balance)}`,
      tone: "debt",
    });
  }

  rows.push({
    id: "assets-total",
    label: "Assets",
    value: abbreviateDollars(assetsCents),
    isGroup: true,
  });

  return {
    title: "Net worth",
    sub: "What the household owns and owes",
    eyebrow: "Total net worth",
    total: formatDollars(opening.netWorthRealCents ?? assetsCents - debtCents),
    totalSub: "today",
    rows,
    cta: { label: "Manage accounts", view: "accounts" },
  };
}
