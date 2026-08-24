/**
 * Death is not a departure, and the dated snapshot has to say both halves of that.
 *
 * A membership closes on SEPARATION alone — deliberately, because a partner who dies leaves their
 * accounts to the household and the estate rules depend on the projection still carrying them.
 * The roster the "As of Year X" panel prints was read off that same membership, so it went on
 * listing a partner years dead as a current member of the household, beside their money. The two
 * questions are different: whose holdings this cross-section may show, and who the household is
 * composed of. Only the second one is closed by a death.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";

/** Marries a partner at month 24 who dies exactly at `DEATH`, holding money of their own. */
const JOIN = 24;
const DEATH = 120;
const PARTNER_AGE = 60;

function household(separateAt?: number) {
  const p = Projection.fromState(
    stateOf({ ...samplePlan, primary: { ...samplePlan.primary, lifeExpectancy: 100 } }),
    nullJurisdiction,
  );
  const id = p.marry({
    month: JOIN,
    name: "Sam",
    // Dies at DEATH: born (age) years before the start year, living exactly to the month.
    birthYear: SAMPLE_START_YEAR - PARTNER_AGE,
    lifeExpectancy: PARTNER_AGE + DEATH / 12,
    accounts: {
      savingsBalanceCents: 500_000,
      savingsReturnPct: 0,
      retirementBalanceCents: 0,
      retirementReturnPct: 0,
      brokerageBalanceCents: 0,
      brokerageReturnPct: 0,
    },
  });
  if (separateAt !== undefined) p.separate({ month: separateAt, partnerPersonId: id });
  return p.run(nullJurisdiction);
}

const names = (result: ReturnType<typeof household>, month: number): string[] =>
  result.snapshot(month).persons.map((who) => who.name);

const holdsPartnerAccount = (result: ReturnType<typeof household>, month: number): boolean =>
  (result.snapshot(month).balances?.accounts ?? []).some((a) => a.id.includes("savings-person"));

describe("the dated snapshot, when a partner dies", () => {
  it("lists them the month before they die", () => {
    expect(names(household(), DEATH - 1)).toContain("Sam");
  });

  it("stops listing them from the month they die", () => {
    // End-of-month convention: DEATH is the first month they are gone, not their last one.
    expect(names(household(), DEATH)).not.toContain("Sam");
  });

  it("does not list them in any month after", () => {
    expect(names(household(), DEATH + 60)).not.toContain("Sam");
    expect(names(household(), DEATH + 240)).not.toContain("Sam");
  });

  it("never stops listing the person who is still alive", () => {
    const result = household();
    for (const m of [JOIN, DEATH - 1, DEATH, DEATH + 120]) {
      expect(names(result, m)).toContain(samplePlan.primary.name);
    }
  });

  it("keeps what they left to the household, which is what a death IS", () => {
    // The estate is the whole reason the membership stays open. Narrowing that instead of the
    // roster would carry their accounts out of the snapshot along with their name.
    const result = household();
    expect(holdsPartnerAccount(result, DEATH - 1)).toBe(true);
    expect(holdsPartnerAccount(result, DEATH)).toBe(true);
    expect(holdsPartnerAccount(result, DEATH + 120)).toBe(true);
  });
});

/** A separation has to happen while both are alive, so it is booked a year before the death. */
const SEPARATION = DEATH - 12;

describe("the dated snapshot, comparing a death with a separation", () => {
  it("gives opposite answers about the money it gives the same answer about the name", () => {
    const died = household();
    const left = household(SEPARATION);
    // Each read at the first month that partner is no longer part of the household.
    expect(names(died, DEATH)).not.toContain("Sam");
    expect(names(left, SEPARATION)).not.toContain("Sam");
    // A partner who left took their accounts with them; one who died left theirs behind.
    expect(holdsPartnerAccount(died, DEATH)).toBe(true);
    expect(holdsPartnerAccount(left, SEPARATION)).toBe(false);
  });

  it("still lists a partner who has neither died nor separated", () => {
    const left = household(SEPARATION);
    expect(names(left, JOIN)).toContain("Sam");
    expect(names(left, SEPARATION - 1)).toContain("Sam");
    expect(holdsPartnerAccount(left, SEPARATION - 1)).toBe(true);
  });
});
