/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v31

import type {TemplateAsset, Vec3} from 'meta/worlds';
import {ActorBehavior, TransformComponent} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  ActorMoveParams,
  type ActorMovementController,
} from 'meta/worlds';
import {ActorBodyDirectionControllerTypeId} from 'meta/worlds';
import {
  IActorAttackControllerTypeId,
  type IActorAttackController,
} from '../../Controllers/Definitions/IActorAttackController';
import type {IActorInterruptibleAttack} from '../../Controllers/Definitions/IActorInterruptibleAttack';
import {
  ActorStaggerControllerTypeId,
  ActorStaggerParams,
  type ActorStaggerController,
} from 'meta/worlds';
import {
  ActorHealthControllerTypeId,
  type ActorHealthController,
} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {IActorStaggerImpulseReceiver} from '../../Controllers/Definitions/IActorStaggerImpulseReceiver';
import type {IActorLastAttackerProvider} from '../../Controllers/Definitions/IActorLastAttackerProvider';
import {CharacterGASComponent} from '../../../Character/gas/CharacterGASComponent';
import {STAGGERED_TAG, STAGGER_COOLDOWN_TAG} from '../../../Character/gas/CharacterTags';

/**
 * GUARD: claims Movement/BodyDirection while `state.staggered` is up; owns no
 * state (stagger effects are applied in the capability layer).
 *
 * StaggerBehavior temporarily prevents the Actor from moving or rotating when
 * damage is received.
 *
 * Stagger lives on the actor's CharacterGASComponent, which applies it: a
 * survivable hit on a character with `staggerOnHit` raises `state.staggered`
 * for staggerDuration plus `cooldown.stagger` for staggerDuration +
 * staggerCooldown, which blocks the next stagger. While `state.staggered` is
 * raised, this behavior claims Move and BodyDirection at basePriority
 * (default 100) and holds the Actor still. It always claims the Stagger
 * controller, to push the stagger parameters once. On each stagger start it
 * interrupts the in-flight attack (a GAS tag only refuses NEW attacks) and
 * fires the knockback impulse.
 *
 * Attacks are refused by the abilities, not here: the weapon's fire ability
 * lists `state.staggered` in `blockedByTags`. Both tags replicate and expire on
 * their own, so every client can read the stagger. An actor without a
 * CharacterGASComponent is never staggered.
 */
export class StaggerBehavior extends ActorBehavior {
  /**
   * The knockback force applied to the Actor when hit, in meters per second.
   * Delivered to the stagger controller via setStaggerParams(); the impulse
   * itself is triggered from onHitDetected().
   */
  knockbackForce: number = 5;

  /**
   * Time to reach the knockback destination, in seconds.
   * Reserved for future use.
   */
  knockbackMoveTime: number = 0.15;

  /**
   * Template asset for hit impact VFX spawned when enemy takes damage.
   */
  hitImpactVfx: TemplateAsset | null = null;

  private gas: CharacterGASComponent | null = null;
  private unsubscribeDamaged: (() => void) | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.unsubscribeDamaged?.();
    this.gas = behaviorManager.actorEntity.getComponent(CharacterGASComponent);
    this.unsubscribeDamaged =
      this.gas?.onDamaged((_amount: number, remainingHealth: number): void => {
        // A killing blow goes to DeathBehavior, not to a stagger.
        if (remainingHealth > 0) {
          this.onHitDetected();
        }
      }) ?? null;
  }

  override onRemove(): void {
    this.unsubscribeDamaged?.();
    this.unsubscribeDamaged = null;
  }

  override update(_deltaTime: number): void {
    // Event-driven: stagger starts in onDamaged and ends when its effect expires.
  }

  protected get isStaggerActive(): boolean {
    return this.gas?.hasTag(STAGGERED_TAG) ?? false;
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorStaggerControllerTypeId) {
      return this.basePriority;
    }

    if (!this.isStaggerActive) {
      return -1;
    }

    if (
      controllerType === ActorMovementControllerTypeId ||
      controllerType === ActorBodyDirectionControllerTypeId
    ) {
      return this.basePriority;
    }

    return -1;
  }

  override useController(
    controllerType: string,
    controller: ActorController,
  ): void {
    if (controllerType === ActorStaggerControllerTypeId) {
      const staggerController = controller as ActorStaggerController;
      if (!staggerController.areStaggerParamsInitialized()) {
        // Durations ride along for the SDK signature but nothing reads them:
        // the window lives on the GAS effects. Sourced from GAS (single source
        // of truth), not behavior fields.
        const gas = this.gas;
        staggerController.setStaggerParams(
          new ActorStaggerParams(
            this.knockbackForce,
            gas?.effectiveStaggerDuration ?? 0.3,
            gas?.effectiveStaggerCooldown ?? 0.5,
            this.knockbackMoveTime,
            this.hitImpactVfx,
          ),
        );
      }
    }

    if (controllerType === ActorMovementControllerTypeId) {
      (controller as ActorMovementController).moveToPosition(
        new ActorMoveParams(null, null),
      );
    }

    // BodyDirection: claiming the controller at high priority is sufficient
    // to prevent other behaviors from rotating the Actor.
  }

  protected onHitDetected(): void {
    const gas = this.gas;
    if (!gas || gas.hasTag(STAGGER_COOLDOWN_TAG)) {
      return;
    }

    this.interruptInFlightAttack();
    this.applyStaggerImpulse();
  }

  /**
   * Cuts off a swing the actor had already started, on any attack controller
   * that supports it.
   *
   * The `state.staggered` gate on the attack ability only refuses a NEW attack —
   * it cannot reach one that is already running, so without this an in-flight
   * swing plays to completion. This is the part that actually stops it.
   *
   * Called from onHitDetected() rather than update() so it inherits the stagger
   * cooldown gate above: a hit landing inside the recovery window does not
   * interrupt, which reads as brief poise after a stagger rather than as an
   * actor that can be perpetually locked down by fast chip damage.
   *
   * Two entry points, because neither method is on the SDK's
   * `IActorAttackController`, so both have to be feature-detected (same reason
   * as applyStaggerImpulse()):
   *
   *  - `interruptAttack()` is preferred. It applies the pre-contact rule, so an
   *    attack whose damage has already resolved is left alone.
   *  - `cancelAttack()` is the fallback for a controller that does not
   *    implement {@link IActorInterruptibleAttack}.
   *
   * `ActorAnimatedAttackComponent`, the only attack controller this package
   * ships, implements `interruptAttack()` for the weapon in hand — it ends the
   * fire ability still before its melee contact or projectile release. The
   * fallback therefore
   * only matters for a controller from outside this package; it is kept because
   * a bare `interruptAttack` probe that finds nothing reports nothing, so
   * without the branch such a controller would keep attacking through a
   * stagger, silently.
   *
   * Preferring `interruptAttack()` when both exist keeps the shipped controller
   * on its stricter path: its `cancelAttack()` ends the attack in any phase.
   *
   * Iterating every registered controller (rather than the first) is
   * deliberate: `getControllers` returns a bucket, and an actor could carry a
   * controller from elsewhere alongside this one.
   */
  protected interruptInFlightAttack(): void {
    const attackControllers =
      this.behaviorManager?.getControllers<IActorAttackController>(
        IActorAttackControllerTypeId,
      );
    attackControllers?.forEach(attackController => {
      const interruptible = attackController as Partial<IActorInterruptibleAttack> &
        Partial<{cancelAttack: () => void}>;
      if (typeof interruptible.interruptAttack === 'function') {
        interruptible.interruptAttack();
      } else if (typeof interruptible.cancelAttack === 'function') {
        interruptible.cancelAttack();
      }
    });
  }

  /**
   * Fires the knockback impulse on any stagger controller that accepts one.
   *
   * This is the only place that knows a stagger is STARTING. setStaggerParams()
   * cannot carry the signal: getControllerUsePriority() above returns
   * basePriority for the stagger controller unconditionally, so the manager
   * grants it on the first frame, and useController() pushes params only while
   * areStaggerParamsInitialized() is false — once, before any damage. Driving
   * the impulse from there applied it at spawn and never again.
   *
   * Feature-detected rather than required, since the SDK's
   * ActorStaggerController interface has no such method: a controller that only
   * consumes the config push is left alone.
   */
  protected applyStaggerImpulse(): void {
    const knockback = this.resolveKnockbackFromAttacker();
    const staggerControllers =
      this.behaviorManager?.getControllers<ActorStaggerController>(
        ActorStaggerControllerTypeId,
      );
    staggerControllers?.forEach(staggerController => {
      const receiver =
        staggerController as Partial<IActorStaggerImpulseReceiver>;
      if (typeof receiver.applyStaggerImpulse === 'function') {
        receiver.applyStaggerImpulse(
          knockback?.attackerPosition ?? null,
          knockback?.forceScale,
        );
      }
    });
  }

  /**
   * Resolves the world position of whoever just hit this actor, plus the impulse
   * scale that attacker asked for. The receiver turns the position into a
   * direction; this behavior only supplies the source.
   *
   * Feature-detected on the health controller for the same reason the impulse
   * itself is feature-detected on the stagger controller: the SDK's
   * `ActorHealthController` exposes only `getHealthData()`, whose
   * `ActorHealthControllerData` has no attacker field. See
   * {@link IActorLastAttackerProvider}.
   *
   * Returns null when the source is unknown -- no provider, no recorded attacker
   * for this hit, a destroyed attacker, or an attacker with no transform. The
   * caller forwards that as the explicit `null` source, which selects the
   * receiver's facing fallback: what every stagger did before this.
   */
  private resolveKnockbackFromAttacker():
    | {attackerPosition: Vec3; forceScale: number}
    | null {
    const healthControllers =
      this.behaviorManager?.getControllers<ActorHealthController>(
        ActorHealthControllerTypeId,
      );
    if (!healthControllers) {
      return null;
    }

    for (const healthController of healthControllers) {
      const provider = healthController as Partial<IActorLastAttackerProvider>;
      if (typeof provider.getLastAttacker !== 'function') {
        continue;
      }
      const attacker = provider.getLastAttacker();
      if (!attacker || !attacker.valid) {
        continue;
      }
      const attackerPosition =
        attacker.getComponent(TransformComponent)?.worldPosition;
      if (!attackerPosition) {
        continue;
      }

      const forceScale =
        typeof provider.getLastKnockbackMultiplier === 'function'
          ? provider.getLastKnockbackMultiplier()
          : 1;
      return {attackerPosition, forceScale};
    }

    return null;
  }
}
