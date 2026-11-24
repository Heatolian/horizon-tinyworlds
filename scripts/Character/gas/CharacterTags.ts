/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v9

/**
 * Character-level gameplay tags — the facts other systems gate on.
 *
 * They live here rather than on the component that raises them so that both
 * sides of a gate can import one without importing the other:
 * `CharacterGASComponent` already depends on `weapons/core/WeaponSetup` for the
 * damage effect, so a weapon reaching back for a tag defined on the component
 * would close an import cycle.
 *
 * 🚨 Tag matching is CASE-SENSITIVE and splits on `.` — see
 * `tags/HierarchicalTagMatcher`. `state.dead` and `State.Dead` are unrelated
 * tags, and a query only matches a whole path segment. Note the weapon stack's
 * own `RELOADING_TAG` is spelled `State.Reloading`, so it is NOT in the `state`
 * hierarchy these constants use; a `blockedByTags: ['state']` gate catches death
 * and not reloading.
 */

/**
 * The character is dead. Applied when `health` reaches zero and never cleared —
 * respawn rather than revive.
 *
 * Hierarchical, so `blockedByTags: ['state']` matches it as well as
 * `blockedByTags: ['state.dead']`.
 */
export const DEAD_TAG = 'state.dead';

/**
 * The character is staggered: it holds still and cannot attack. Granted by a
 * Durational effect, so it clears itself; in the `state` hierarchy so a
 * `blockedByTags: ['state']` gate catches it alongside death.
 */
export const STAGGERED_TAG = 'state.staggered';

/** Stagger recovery window: while raised, a new hit does not stagger again. */
export const STAGGER_COOLDOWN_TAG = 'cooldown.stagger';

/**
 * The character is mid dodge roll. Raised by the `character.dodge` ability while it runs; in
 * the `state` hierarchy, so a `blockedByTags: ['state']` gate also waits for the roll.
 */
export const DODGING_TAG = 'state.dodging';
