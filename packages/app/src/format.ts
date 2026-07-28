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
