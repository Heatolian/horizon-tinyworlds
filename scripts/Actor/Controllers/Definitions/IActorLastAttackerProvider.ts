/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v8

import type {Entity} from 'meta/worlds';

/**
 * Optional extension for a health controller that remembers who dealt its most
 * recent damage, so a knockback impulse can be aimed away from the attacker
 * instead of along the victim's own facing.
 *
 * The SDK's `ActorHealthController` cannot carry this: its only read path is
 * `getHealthData()`, which returns a fixed-shape `ActorHealthControllerData`
 * (`maxHealth` / `currentHealth` / `isDead` / `isHit`) defined in `meta/worlds`.
 * StaggerBehavior polls that struct rather than subscribing to a damage event,
 * so without this interface the attacker is simply not observable at the moment
 * the impulse fires — which is why the impulse used to fall back to
 * `-worldForward`.
 *
 * A health component that wants directional knockback implements this;
 * StaggerBehavior feature-detects it, exactly as it already feature-detects
 * {@link IActorStaggerImpulseReceiver} on the stagger controller. Implementing
 * it is optional — a component that does not is left on the facing fallback.
 *
 * ## Pending vs last
 *
 * The two-phase shape is what keeps the attacker from going stale.
 * `recordAttacker()` writes a PENDING value, which the implementer promotes to
 * the readable one inside `takeDamage()` and then clears. So a damage source
 * that does not call `recordAttacker()` (a hazard, a direct `takeDamage()` from
 * script) leaves nothing pending, `getLastAttacker()` returns null, and that hit
 * correctly falls back to the facing direction rather than reusing whoever last
 * punched this actor.
 *
 * One exception: `CharacterGASComponent` promotes the source of a GAS damage
 * effect when nothing is pending, so a hit applied with `applyEffectToTarget`
 * (every player weapon, and each periodic tick of such an effect) reports its
 * caster at multiplier 1.
 */
export interface IActorLastAttackerProvider {
  /**
   * Called by a damage source immediately BEFORE `takeDamage()`, on the owner.
   * Order matters: the implementer promotes this pending value during
   * `takeDamage()`, so recording afterwards would land on the following hit.
   */
  recordAttacker(attacker: Entity, knockbackMultiplier?: number): void;

  /**
   * The attacker behind the most recent damage application, or null when that
   * damage came from a source that neither recorded one nor carried a GAS
   * effect source.
   */
  getLastAttacker(): Entity | null;

  /** Impulse scale the attacker asked for on that hit. 1 means unscaled. */
  getLastKnockbackMultiplier(): number;
}
