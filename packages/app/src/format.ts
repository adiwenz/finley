/** Shared display formatting — money and the month→time label. */

import { START_YEAR } from "./config";

export function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** "Year 3 (2029)" — the shared month→time label used across every surface. */
export function monthLabel(month: number): string {
  const year = Math.floor(month / 12);
  return `Year ${year} (${START_YEAR + year})`;
}
