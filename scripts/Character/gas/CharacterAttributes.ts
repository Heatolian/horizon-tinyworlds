/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v3

/**
 * Character-level GAS attribute names — the pair every health reader agrees on.
 *
 * A leaf with no imports, so the health component and the weapon stack can both
 * name an attribute without depending on each other. The tag equivalent is
 * `CharacterTags`.
 */

/** Current health. Reaching zero applies {@link DEAD_TAG}. */
export const HEALTH_ATTR = 'health';

/** THE ceiling; healing cannot exceed it. Moves at runtime — see `setMaxHealth`. */
export const MAX_HEALTH_ATTR = 'max_health';
