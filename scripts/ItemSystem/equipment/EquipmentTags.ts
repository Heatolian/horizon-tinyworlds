/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

/**
 * The tags that say what a character has equipped.
 *
 * A leaf with no imports, so the character side, the item side and the
 * animation module can all name the same fact without depending on each other —
 * the same reason `Character/gas/CharacterTags` exists.
 *
 * 🚨 Tag matching is CASE-SENSITIVE and splits on `.`, so `equipment.pistol`
 * and `Equipment.Pistol` are unrelated tags. Keep everything under the lower
 * case `equipment` root, which lets `blockedByTags: ['equipment']` mean
 * "while holding anything".
 */

/** Root of the equipped hierarchy; matches every `equipmentTag(...)`. */
export const EQUIPMENT_TAG_ROOT = 'equipment';

/**
 * The tag raised on a character while `equipKey` is in its hands.
 *
 * This is the whole of "what am I holding". It is a GAS tag rather than a field
 * so it replicates with the character for free and any system — the animation
 * module, a HUD, an NPC deciding whether you look armed — subscribes instead of
 * being told.
 */
export function equipmentTag(equipKey: string): string {
  return `${EQUIPMENT_TAG_ROOT}.${equipKey}`;
}

/** The `equipKey` an `equipmentTag` was built from, or null for any other tag. */
export function equipKeyOf(tag: string): string | null {
  const prefix = `${EQUIPMENT_TAG_ROOT}.`;
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : null;
}
