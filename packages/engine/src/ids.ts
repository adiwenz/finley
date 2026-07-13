/**
 * Branded domain IDs.
 *
 * These are nominal `string` subtypes: a `PersonId` is a string at runtime, but
 * the compiler refuses to mix it up with a `SeriesId` or a raw `string`. They
 * exist to make the replay layer's indexed maps (§9) type-safe — keying
 * `Map<PersonId, …>` by an accidental `LiabilityId` becomes a compile error.
 *
 * Scope (per §10): brands live at the ledger/interpret boundary and the derived
 * model. Public event objects keep plain `string` id fields so authoring an
 * event stays ergonomic (`{ id: "e1", … }`); the replay boundary brands them
 * with the smart constructors below. Branded ids are assignable *to* `string`,
 * so anything reading a model id (comparisons, display, record keys) just works.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type EventId = Brand<string, "EventId">;
export type PersonId = Brand<string, "PersonId">;
export type ChildId = Brand<string, "ChildId">;
export type SeriesId = Brand<string, "SeriesId">;
export type LiabilityId = Brand<string, "LiabilityId">;
export type AccountId = Brand<string, "AccountId">;
export type PropertyId = Brand<string, "PropertyId">;

// Smart constructors — the single localized spot each assertion lives, so the
// rest of the code never writes `as PersonId` inline.
export const asEventId = (s: string): EventId => s as EventId;
export const asPersonId = (s: string): PersonId => s as PersonId;
export const asChildId = (s: string): ChildId => s as ChildId;
export const asSeriesId = (s: string): SeriesId => s as SeriesId;
export const asLiabilityId = (s: string): LiabilityId => s as LiabilityId;
export const asAccountId = (s: string): AccountId => s as AccountId;
export const asPropertyId = (s: string): PropertyId => s as PropertyId;
