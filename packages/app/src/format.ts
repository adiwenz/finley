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
 * The plan-year a month falls in, 0-indexed: month 0–11 is Year 0 ("now"). Every
 * surface that names a year MUST go through this — the net-worth chart once did its
 * own `floor(month / 12) + 1`, which labelled the same insolvency month "year 45"
 * while the banner called it "Year 44".
 */
export function yearOf(month: number): number {
  return Math.floor(month / 12);
}

/** "Year 3 (2029)" — the shared month→time label used across every surface. */
export function monthLabel(month: number): string {
  const year = yearOf(month);
  return `Year ${year} (${START_YEAR + year})`;
}
