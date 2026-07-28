/**
 * Branded domain IDs — nominal `string` subtypes: a `PersonId` is a string at runtime, but
 * the compiler refuses to mix it with a `SeriesId` or a raw `string`, so keying
 * `Map<PersonId, …>` by a `LiabilityId` is a compile error.
 *
 * Scope: the ledger/interpret boundary and the derived model. Public event objects keep
 * plain `string` ids so authoring stays ergonomic (`{ id: "e1", … }`); the replay boundary
 * brands them via the smart constructors below. Branded ids are assignable *to* `string`,
 * so comparisons, display, and record keys just work.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type EventId = Brand<string, "EventId">;
export type PersonId = Brand<string, "PersonId">;
export type ChildId = Brand<string, "ChildId">;
export type SeriesId = Brand<string, "SeriesId">;
export type LiabilityId = Brand<string, "LiabilityId">;
export type AccountId = Brand<string, "AccountId">;
export type PropertyId = Brand<string, "PropertyId">;

// Smart constructors — the one place each assertion lives, so nothing else writes
// `as PersonId` inline.
export const asEventId = (s: string): EventId => s as EventId;
export const asPersonId = (s: string): PersonId => s as PersonId;
export const asChildId = (s: string): ChildId => s as ChildId;
export const asSeriesId = (s: string): SeriesId => s as SeriesId;
export const asLiabilityId = (s: string): LiabilityId => s as LiabilityId;
export const asAccountId = (s: string): AccountId => s as AccountId;
export const asPropertyId = (s: string): PropertyId => s as PropertyId;
