import type { BlockedWarningView } from "../../ledgerView";
import { formatDollars, monthLabel } from "../../format";

/**
 * A soft warning for a projection the engine stopped: an explicitly-funded purchase whose sources
 * could not cover it, so the curve is hatched from there on. Persistent and non-dismissible — it
 * carries no dismiss control, because dismissing it would not make it less true; it clears only when
 * the plan no longer blocks (a different funding source, a smaller purchase). Named for the DTI
 * advisory's `soft-warning` marker class, but NOT advice: it proposes no value change, it reports a
 * stop that already happened. Red rather than amber for that reason.
 *
 * The copy branches on the engine's funding-failure classification. A funding-configuration block
 * names the eligible accounts that could cover it — the money exists, the instructions don't point
 * at it — and the remedy is to re-point the funding. A no-eligible-source block states the
 * eligibility fact and explicitly withholds any judgement about affordability: a household with
 * ample retirement wealth lands here, and calling that "can't afford it" would be false.
 *
 * The parent renders this only while `blockedWarning` returns non-null, so mounting IS the
 * condition holding; the component itself is a pure statement of that fact.
 */
export function BlockedWarning({ warning }: { warning: BlockedWarningView }) {
  const lead = (
    <>
      <strong>Projection stopped.</strong> “{warning.eventLabel}” in {monthLabel(warning.month)}{" "}
    </>
  );
  const selected = (
    <>
      {" "}
      Named, in order: {warning.selectedSources
        .map((s) => `${s.label} (${formatDollars(s.availableCents)} available)`)
        .join(", ")}
      . Remaining shortfall: {formatDollars(warning.shortfallCents)}.
    </>
  );
  return (
    <div className="alert alert-red soft-warning" role="status">
      {warning.kind === "funding-configuration" ? (
        <>
          {lead}
          can’t be funded from the accounts you chose — they fall{" "}
          {formatDollars(warning.shortfallCents)} short after the tax on selling them.
          {warning.selectedSources.length > 0 && selected} The money is
          there, just not in the accounts you pointed at:{" "}
          {warning.alternativeSources
            .map((s) => `${s.label} (${formatDollars(s.availableCents)} available)`)
            .join(", ")}{" "}
          could cover it. Re-point the funding or lower the amount — nothing is moved for you.
        </>
      ) : (
        <>
          {lead}
          can’t be funded: the eligible funding sources together can’t cover it, and it falls{" "}
          {formatDollars(warning.shortfallCents)} short after the tax on selling what you have.
          {warning.selectedSources.length > 0 && selected} Retirement accounts aren’t eligible for
          a purchase like this, so a balance held there doesn’t change it. This isn’t a judgement
          about what you can manage — it’s that no account the purchase may draw from holds
          enough.
        </>
      )}
    </div>
  );
}
