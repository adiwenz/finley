/** Shared display formatting — money and the month→time label. */

import { START_YEAR } from "./config";

export function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * The plan-year a month falls in, 0-indexed: months 0–11 are Year 0 ("now"). Every surface
 * naming a year MUST go through this — the net-worth chart once did its own
 * `floor(month / 12) + 1` and called the same insolvency month "year 45" while the banner
 * said "Year 44".
 */
export function yearOf(month: number): number {
  return Math.floor(month / 12);
}

/** "Year 3 (2029)" — the shared month→time label used across every surface. */
export function monthLabel(month: number): string {
  const year = yearOf(month);
  return `Year ${year} (${START_YEAR + year})`;
}

/**
 * `partsCents` as whole dollars summing to EXACTLY `totalDollars`.
 *
 * Every amount on a surface is rounded to the dollar ({@link formatDollars}), and rounding each
 * part on its own is what makes a breakdown read as though it did not add up: two shares of
 * $2,700.005 each print as $2,700 beside a household total of $5,400.01 printed as $5,400 — or,
 * one cent later, as $5,401. Cumulative rounding takes each part as the difference between two
 * rounded running totals instead, so the printed parts sum to the printed total by construction
 * and the last one absorbs whatever the rounding left.
 *
 * `totalDollars` is passed in rather than derived, so a nested breakdown can be rounded against
 * the figure its own parent row already printed.
 */
export function dollarParts(partsCents: readonly number[], totalDollars: number): number[] {
  const totalCents = partsCents.reduce((sum, cents) => sum + cents, 0);
  if (totalCents === 0) return partsCents.map(() => 0);
  const out: number[] = [];
  let prevCum = 0;
  let acc = 0;
  for (const cents of partsCents) {
    acc += cents;
    const cum = Math.round((totalDollars * acc) / totalCents);
    out.push(cum - prevCum);
    prevCum = cum;
  }
  return out;
}

/** A whole-dollar figure, formatted the same way {@link formatDollars} formats cents. */
export function formatWholeDollars(dollars: number): string {
  return formatDollars(dollars * 100);
}
