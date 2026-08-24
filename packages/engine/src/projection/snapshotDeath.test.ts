/**
 * Death is not a departure, and the dated snapshot has to say both halves of that.
 *
 * A membership closes on SEPARATION alone — deliberately, because a partner who dies leaves their
 * accounts to the household and the estate rules depend on the projection still carrying them.
 * The roster the "As of Year X" panel prints was read off that same membership, so it went on
 * listing a partner years dead as a current member of the household, beside their money. The two
 * questions are different: whose holdings this cross-section may show, and who the household is
 * composed of. Only the second one is closed by a death.
 *
 * The money side has its own rule, and it is about what is LEFT rather than about who is gone.
 * The simulation never filters the spendable pool by whether an owner is alive, so a deceased
 * partner's balance still funds the household and still counts in its net worth — it is the
 * estate, and it stays on the list, named as the estate. An estate with nothing in it is the one
 * row that has nothing to say: the person is gone and so is their money, so it goes too, exactly
 * as a paid-off debt and a sold property already do.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";

/** Marries a partner at month 24 who dies exactly at `DEATH`, holding money of their own. */
const JOIN = 24;
const DEATH = 120;
const PARTNER_AGE = 60;

/**
 * `broughtCents` decides which side of the estate rule the fixture lands on: the household spends
 * a partner's own savings on their share of its costs, so a small balance is gone well before they
 * are, and a large one outlives them.
 */
function household(separateAt?: number, broughtCents = 500_000) {
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
      savingsBalanceCents: broughtCents,
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

const partnerAccount = (result: ReturnType<typeof household>, month: number) =>
  (result.snapshot(month).balances?.accounts ?? []).find((a) => a.id.includes("savings-person"));

const holdsPartnerAccount = (result: ReturnType<typeof household>, month: number): boolean =>
  partnerAccount(result, month) !== undefined;

/** Enough that the household cannot have spent it all on Sam's share before Sam dies. */
const RICH = 500_000_000;

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
    const result = household(undefined, RICH);
    expect(holdsPartnerAccount(result, DEATH - 1)).toBe(true);
    expect(holdsPartnerAccount(result, DEATH)).toBe(true);
    expect(holdsPartnerAccount(result, DEATH + 120)).toBe(true);
  });

  it("calls what they left an estate only once they are gone", () => {
    const result = household(undefined, RICH);
    // The same account, the same money, on both sides of one month: it is theirs while they are
    // here, and the household's afterwards. Nothing about the balance changes at the boundary.
    expect(partnerAccount(result, DEATH - 1)?.inEstate).toBeUndefined();
    expect(partnerAccount(result, DEATH)?.inEstate).toBe(true);
  });

  it("drops an emptied estate rather than listing a dead person holding nothing", () => {
    // The default fixture's partner brings little enough that the household spends it on their
    // share before they die — so the row that survived them was a name the roster had already
    // stopped printing, against $0.
    const result = household();
    expect(partnerAccount(result, DEATH - 1)?.balanceCents).toBe(0);
    expect(holdsPartnerAccount(result, DEATH)).toBe(false);
  });

  it("keeps a LIVING member's empty account, which is still theirs to refill", () => {
    // The rule is about the estate, not about zero: an account at $0 is only meaningless once
    // there is nobody left who could put anything into it.
    const result = household();
    expect(partnerAccount(result, DEATH - 1)).toBeDefined();
  });
});

/** A separation has to happen while both are alive, so it is booked a year before the death. */
const SEPARATION = DEATH - 12;

describe("the dated snapshot, comparing a death with a separation", () => {
  it("gives opposite answers about the money it gives the same answer about the name", () => {
    const died = household(undefined, RICH);
    const left = household(SEPARATION, RICH);
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
