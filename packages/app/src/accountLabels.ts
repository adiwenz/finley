/**
 * Naming an account — or a debt — in a household that has more than one person in it.
 *
 * An account's authored label says what KIND of money it is — "Cash savings", "Brokerage" — which
 * was the whole answer while there was only ever one person to own it. With a partner there are
 * two of everything, and a label that names only the kind cannot tell the reader whose money moved:
 * "Cash savings $900" is the same sentence whether a partner covered their own share, the household
 * drew on its shared pot, or one partner quietly paid the other's bill.
 *
 * So the owner is prepended, and ONLY when there is somebody to distinguish them from — a solo
 * household reads exactly as it always has, because there is no ambiguity to resolve and "Alex's
 * cash savings" would just be noise.
 *
 * A goal fund keeps its authored name. It is the household's purpose rather than a person's
 * holding, and "Alex's emergency fund" would claim an ownership the goal does not have.
 *
 * Pure — no React, no simulation — so it unit-tests in node beside the other `*View` modules.
 */

import {
  liabilityKindLabel,
  SYNTHETIC_CARD_ID,
  type Household,
  type PlanAccountDescriptor,
} from "@finley/engine";

/**
 * A partner's account already carries its owner, compiled in as "Blake — Cash savings", because
 * the whole-plan charts show it beside the primary's with no roster to hand. Taken back apart
 * here so every account is named the same way from the same two facts, rather than one being
 * qualified twice ("Blake's Blake — Cash savings").
 */
function bareLabel(label: string): string {
  const dash = label.indexOf(" — ");
  return dash === -1 ? label : label.slice(dash + 3);
}

/** "Cash savings" reads as a kind mid-sentence, so it joins a possessive in lower case. */
function lowerFirst(label: string): string {
  return label.charAt(0).toLocaleLowerCase() + label.slice(1);
}

/**
 * Account id → the name to show for it. `personNames` is the household roster; one member (or
 * none) leaves every label as authored.
 */
export function accountLabelsFor(
  accounts: readonly PlanAccountDescriptor[],
  personNames: ReadonlyMap<string, string>,
): Map<string, string> {
  const qualify = personNames.size > 1;
  return new Map(
    accounts.map((a) => {
      const bare = bareLabel(a.label);
      const owner = personNames.get(a.ownerId);
      // An owner the roster cannot name is not evidence of a household account — it is a holding
      // this roster cannot speak for, so it keeps the label it was given rather than gaining a
      // possessive built from an id.
      if (!qualify || a.kind === "goal" || owner === undefined) return [a.id, bare] as const;
      return [a.id, `${owner}’s ${lowerFirst(bare)}`] as const;
    }),
  );
}

/** Account id → the id of the person who owns it, for deciding whose money paid for what. */
export function accountOwnersFor(
  accounts: readonly PlanAccountDescriptor[],
): Map<string, string> {
  return new Map(accounts.map((a) => [a.id, a.ownerId]));
}

/**
 * Liability id → the name to show for it, by the same rule accounts follow: the KIND, qualified by
 * its owner only where there is somebody to distinguish them from (two partners can each carry an
 * "Auto loan").
 *
 * The engine's last-resort borrowing is a real revolving card in the model but nobody authored it,
 * so it has no label of its own and the balances list printed its internal id at the reader —
 * "synthetic-credit-card (owed)" names an implementation, not a debt. It belongs to the household
 * rather than to a person, so it is never owner-qualified.
 */
export function liabilityLabelsFor(
  household: Household,
  personNames: ReadonlyMap<string, string>,
): Map<string, string> {
  const labels = new Map<string, string>([[SYNTHETIC_CARD_ID, liabilityKindLabel("creditCard")]]);
  for (const liability of household.liabilities) {
    const owner = personNames.get(liability.ownerId);
    labels.set(
      liability.id,
      owner === undefined || personNames.size < 2
        ? liabilityKindLabel(liability.kind)
        : `${owner} — ${liabilityKindLabel(liability.kind)}`,
    );
  }
  return labels;
}
