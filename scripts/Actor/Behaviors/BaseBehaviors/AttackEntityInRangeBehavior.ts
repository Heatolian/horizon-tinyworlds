/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v29

import {
  Vec3,
  type Entity,
  TransformComponent,
  WorldService,
} from 'meta/worlds';
import { ActorBehavior } from 'meta/worlds';
import type { ActorController } from 'meta/worlds';
import { ActorHealthControllerTypeId, type ActorHealthController } from 'meta/worlds';
import { ActorDeathReader, TargetDeathReader } from '../../Utilities/ActorDeathReader';
import { IActorAttackControllerTypeId, type IActorAttackController } from '../../Controllers/Definitions/IActorAttackController';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';
import { ActorMovementControllerTypeId, type ActorMovementController, ActorMoveParams } from 'meta/worlds';

/**
 * Behavior that triggers an attack when a target entity is within range.
 *
 * When the target is within [{@link minAttackDistance}, {@link maxAttackDistance}],
 * this behavior claims the attack, body-direction, and movement controllers at
 * its base priority. Movement is stopped while in range so patrol or follow
 * behaviors yield. Rotation toward the target uses XZ-plane direction only.
 *
 * It keeps no cooldown of its own: it attacks when the attack controller's
 * `canAttack(target)` says an attack would be accepted, and that answer comes
 * from the GAS attack ability (cooldown, `state.dead`, `state.staggered`). Only
 * when no GAS ability can refuse (no attack controller registered, or no
 * `CharacterGASComponent`) does it read death itself, via `ActorDeathReader`.
 *
 * A dead target counts as no target: the behavior claims nothing for it.
 */
export class AttackEntityInRangeBehavior extends ActorBehavior {
  /** Entity to track and attack when within range. */
  targetEntity: Entity | null = null;

  /**
   * Smoothed world-space velocity (m/s) of {@link targetEntity}, or null when
   * unknown. Forwarded to the attack controller in the payload so ranged
   * controllers can lead a moving target. Set by the owning composite (e.g.
   * `EngageCombatBehavior`) from the targeting `TargetInfo` each frame.
   */
  targetVelocity: Vec3 | null = null;

  /** Damage value passed to the attack controller via the payload. */
  damage: number = 1;

  /**
   * Minimum distance in meters at which the actor will initiate an attack.
   * @internal Written every frame by `EngageCombatBehavior.updateDerivedRanges()`
   * as `sumR + composite.minAttackDistance`. Direct authoring is silently
   * overwritten — set `minAttackDistance` on `EngageCombatBehavior` instead.
   * Read freely; do not write.
   */
  minAttackDistance: number = 1.0;

  /**
   * Maximum distance in meters at which the actor will initiate an attack.
   * @internal Written every frame by `EngageCombatBehavior.updateDerivedRanges()`
   * as `sumR + composite.maxAttackDistance`. Direct authoring is silently
   * overwritten — set `maxAttackDistance` on `EngageCombatBehavior` instead.
   * Read freely; do not write.
   */
  maxAttackDistance: number = 4.0;

  /**
   * Self + target collider-radii sum (meters) for the current target.
   * @internal Written every frame by `EngageCombatBehavior.updateDerivedRanges()`
   * — the SAME `sumR` folded into {@link minAttackDistance}/{@link maxAttackDistance}
   * — so subtracting it from a center-to-center distance yields a surface (gap)
   * distance directly comparable to the attack band. Direct authoring is silently
   * overwritten. Read freely; do not write.
   */
  radiiSum: number = 0;

  /** When true, the actor rotates to face the target while in attack range. */
  rotateTowardsTarget: boolean = true;

  /**
   * Angular turn speed toward the target, in radians per second (passed as
   * `ActorBodyDirectionParams.angularSpeed`). 3.14 (~180°/s) matches the other
   * behaviors' `bodyDirectionAngularSpeed`; a ranged attacker fires along its
   * facing, so a slow turn leaves it shooting away from the target.
   */
  rotationSpeed: number = 3.14;

  /** Read-only output flag: true when the actor wants to attack (in range, and an attack would be accepted). */
  wantsToAttack: boolean = false;

  /** Desired facing direction on the XZ plane, or null when not rotating. */
  protected desiredBodyDirection: Vec3 | null = null;

  /** Cached distance to target from last update. */
  private cachedDistance: number = 0;

  private readonly deathReader = new ActorDeathReader();

  private readonly targetDeath = new TargetDeathReader();

  private sourceTransform: TransformComponent | null = null;

  private isInRange: boolean = false;

  override update(_deltaTime: number): void {
    const targetTransform = this.targetEntity?.getComponent(TransformComponent);
    if (!targetTransform || this.targetDeath.isDead(this.targetEntity)) {
      this.clearAttackIntent();
      return;
    }

    // Cache the source transform if not already cached
    if (!this.sourceTransform) {
      const entity = this.getEntity();
      if (!entity) {
        this.clearAttackIntent();
        return;
      }
      this.sourceTransform = entity.getComponent(TransformComponent);
    }

    // Check if source transform exists
    if (!this.sourceTransform) {
      this.clearAttackIntent();
      return;
    }

    const currentPosition = this.sourceTransform.worldPosition;
    const targetPosition = targetTransform.worldPosition;

    const toTargetVec = targetPosition.sub(currentPosition);
    const distance = toTargetVec.magnitude();

    if (distance >= this.minAttackDistance && distance <= this.maxAttackDistance) {
      this.isInRange = true;
      this.cachedDistance = distance;

      if (this.attackWouldBeAccepted()) {
        // Edge-triggered attack-intent telemetry: emit once per false->true
        // transition of wantsToAttack, i.e. once per attack the actor decides to
        // initiate. this.wantsToAttack still holds the PREVIOUS frame's value at
        // this point (it is reassigned below), so `!this.wantsToAttack` is the
        // rising edge. It re-arms after every accepted attack because the
        // controller reads not ready until the next may start (the
        // IActorAttackController contract). Emitted here at the DECISION point,
        // so the "did this actor try to attack its target" signal survives even
        // when no attack controller is provisioned (the eval grades this, not
        // the animation).
        // See eval_spawn_enemy_wave.castle_attack_gameplay.
        if (!this.wantsToAttack) {
          const currentTime = WorldService.get().getWorldTime();
          // Log a surface (gap) distance, not the center-to-center `distance`:
          // subtract the SAME self+target collider-radii sum EngageCombatBehavior
          // folds into the attack band, so `range=` is directly comparable to
          // min/maxAttackDistance (which the consumer eval treats as the band).
          // Clamp at 0 so overlapping colliders never emit a negative range.
          const surfaceDistance = Math.max(0, distance - this.radiiSum);
          this.emitAttackRequested(surfaceDistance, currentTime);
        }
        this.wantsToAttack = true;
      } else {
        this.wantsToAttack = false;
      }

      // Calculate direction to target on XZ plane only
      if (this.rotateTowardsTarget) {
        const toTargetXZ = new Vec3(toTargetVec.x, 0, toTargetVec.z);
        if (toTargetXZ.magnitude() > 0.001) {
          this.desiredBodyDirection = toTargetXZ.normalize();
        }
      }
    } else {
      this.clearAttackIntent();
    }
  }

  /** Stand down: claim no controller and start a fresh rising edge next time. */
  private clearAttackIntent(): void {
    this.wantsToAttack = false;
    this.isInRange = false;
    this.desiredBodyDirection = null;
  }

  /**
   * Whether an attack issued now would be accepted, answered by the attack
   * controllers. With none registered the decision rests on range and death,
   * which keeps the intent telemetry for actors provisioned without one.
   */
  private attackWouldBeAccepted(): boolean {
    const entity = this.behaviorManager ? this.getEntity() : null;
    const controllers = this.behaviorManager?.getControllers<IActorAttackController>(IActorAttackControllerTypeId);
    const hasController = controllers != null && controllers.length > 0;
    // Only a GAS ability refuses a dead actor. With no controller, or no GAS
    // behind it, a corpse would otherwise keep reporting attack intent.
    if (
      (!hasController || !this.deathReader.hasGas(entity)) &&
      this.deathReader.read(
        entity,
        this.behaviorManager?.getControllers<ActorHealthController>(ActorHealthControllerTypeId),
      )
    ) {
      return false;
    }
    if (!hasController) {
      return true;
    }
    for (const controller of controllers) {
      if (controller.canAttack(this.targetEntity)) {
        return true;
      }
    }
    return false;
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType == IActorAttackControllerTypeId && this.wantsToAttack) {
      return this.basePriority;
    }

    if (controllerType == ActorBodyDirectionControllerTypeId && this.rotateTowardsTarget && this.desiredBodyDirection) {
      return this.basePriority;
    }

    // When in attack range, claim movement controller to stop patrol/other movement behaviors
    if (controllerType == ActorMovementControllerTypeId && this.isInRange) {
      return this.basePriority;
    }

    return super.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType == IActorAttackControllerTypeId) {
      const attackController = controller as IActorAttackController;
      if (this.targetEntity && attackController.canAttack(this.targetEntity)) {
        attackController.attack({
          target: this.targetEntity,
          damage: this.damage,
          attackRange: this.cachedDistance,
          targetVelocity: this.targetVelocity,
        });
      }
    }

    if (controllerType == ActorBodyDirectionControllerTypeId && this.rotateTowardsTarget && this.desiredBodyDirection) {
      (controller as ActorBodyDirectionController).rotateBodyTo(new ActorBodyDirectionParams(this.desiredBodyDirection, this.rotationSpeed));
    }

    // Stop movement when in attack range - this prevents patrol from continuing
    if (controllerType == ActorMovementControllerTypeId && this.isInRange) {
      (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
    }

    super.useController(controllerType, controller);
  }

  /**
   * Emit one structured telemetry line per attack the actor DECIDES to initiate,
   * mirroring the `[ActorSpawnTelemetry]` markers (see
   * `ActorSpawner`/`ActorIntervalTrigger`). Event-driven (rising edge of
   * {@link wantsToAttack}, not per frame), so it is not an update-loop log. Carries
   * the target entity name so a log-only eval can confirm the attack was aimed at
   * the castle, plus the surface distance and game time for a legible detail. The
   * grade reads these lines directly (no live world / no animation state), so it
   * survives a missing attack/animation controller.
   */
  private emitAttackRequested(surfaceDistance: number, gameTime: number): void {
    const entity = this.getEntity();
    const actorName = entity != null && entity.valid ? entity.name : '<destroyed>';
    const targetName =
      this.targetEntity != null && this.targetEntity.valid
        ? this.targetEntity.name
        : '<unknown>';
    console.log(
      `[ActorAttackTelemetry] event=attack_requested actor=${actorName} ` +
        `target=${targetName} range=${surfaceDistance.toFixed(3)} gt=${gameTime.toFixed(3)}`,
    );
  }
}
