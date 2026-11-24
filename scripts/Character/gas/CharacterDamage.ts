/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v9

import {GASAttributeData} from '../../gas/attributes/GASAttributeData';
import {GASComponent} from '../../gas/core/GASComponent';
import {DurationPolicy, MagnitudeMode, ModifierOperator} from '../../gas/core/Enums';
import {GASEffectData} from '../../gas/effects/GASEffectData';
import {GASEffectModifier} from '../../gas/effects/GASEffectModifier';
import {HEALTH_ATTR} from './CharacterAttributes';

/**
 * Definitions already built here, keyed by effect id. Every weapon INSTANCE runs
 * setup, so N players carrying one weapon type would otherwise build N distinct
 * GASEffectData under one id — and `registerEffect` compares by object identity,
 * so it would treat them as a conflict, drop the id and blacklist it, leaving
 * every one of those weapons unable to deal damage.
 */
const damageEffects = new Map<
  string,
  {effect: GASEffectData; damage: number; attribute: string; cues: string}
>();

/**
 * Flat -damage on `attributeName` (health, or a shield / armour pool), registered
 * by id so a remote target's authority resolves the same effect from its own
 * registry. For per-shot dynamic damage build a SetByCaller effect instead.
 *
 * Instances of the same weapon type share one definition. Two DIFFERENT weapons
 * under one id still fall through to `registerEffect`, which rejects the
 * conflict — one id must mean one thing on every machine.
 */
export function createDamageEffect(
  effectId: string,
  damage: number,
  attributeName: string = HEALTH_ATTR,
  cueTagsOnExecute: readonly string[] = [],
): GASEffectData {
  const cues = cueTagsOnExecute.join(',');
  const cached = damageEffects.get(effectId);
  if (cached && cached.damage === damage && cached.attribute === attributeName && cached.cues === cues) {
    return cached.effect;
  }
  const effect = new GASEffectData({
    effectId,
    durationPolicy: DurationPolicy.Instant,
    gameplayCueTagsOnExecute: [...cueTagsOnExecute],
  });
  effect.modifiers.push(
    new GASEffectModifier({
      attribute: new GASAttributeData({attributeName}),
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: -damage,
    }),
  );
  GASComponent.registerEffect(effect);

  // Cache only what actually registered: an empty id is never stored, and a
  // rejected conflict must not be handed to the next instance.
  if (GASComponent.getRegisteredEffect(effectId) === effect) {
    damageEffects.set(effectId, {effect, damage, attribute: attributeName, cues});
  }
  return effect;
}
