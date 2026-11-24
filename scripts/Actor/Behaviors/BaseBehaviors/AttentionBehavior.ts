/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  Vec3,
  TransformComponent,
  type Entity,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {
  ActorLookControllerTypeId,
  type ActorLookController,
  ActorLookParams,
} from 'meta/worlds';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  type ActorMovementController,
  ActorMoveParams,
} from 'meta/worlds';
import {ActorTaggingBlackboard, BlackboardScope} from 'meta/worlds';
import {isDead} from './Tagging/TargetTaggedEntityBehavior';
import {TargetLog} from '../../Utilities/ActorBehaviorLog';
import {PlayerRoster} from '../../Utilities/PlayerRoster';

/**
 * Target selection mode for the AttentionBehavior.
 */
export enum AttentionTargetMode {
  /** Automatically targets the nearest player within range */
  NearestPlayer,
  /** Targets a specific entity set via targetEntity */
  SpecificEntity,
  /** Targets the closest living entity carrying any of `targetTags` */
  Tagged,
}

/**
 * AttentionBehavior - Makes an Actor idly pay attention to nearby targets.
 *
 * When a target is in range, the Actor looks at it via ActorLookController.
 * When no target is in range, performs idle gaze — periodically looking in
 * random directions to appear alive.
 *
 * Claims ActorLookController at low priority (default 0) so that combat,
 * death, or other higher-priority behaviors can override the look direction.
 */
export class AttentionBehavior extends ActorBehavior {
  /** True once the behavior manager has removed this behavior; it no longer updates. */
  isRemoved: boolean = false;

  /** Target selection mode */
  targetMode: AttentionTargetMode = AttentionTargetMode.NearestPlayer;

  /** Specific entity to look at (only used with SpecificEntity mode) */
  targetEntity: Entity | null = null;

  /**
   * Tags to look for (only used with Tagged mode). The target must carry a
   * matching `ActorSdkTagComponent` tag. Players carry "player" only while an
   * `ActorSdkManagerComponent` in the scene runs the player tag service.
   */
  targetTags: string[] = [];

  /** Maximum distance (meters) to detect attention targets */
  attentionRange: number = 10.0;

  /** Speed of look interpolation when tracking a target (0-1 per frame) */
  lookSpeed: number = 0.15;

  /** Speed of look interpolation for idle gaze (0-1 per frame) */
  idleLookSpeed: number = 0.05;

  /** Whether to perform idle gaze when no target is in range */
  idleGazeEnabled: boolean = true;

  /** Minimum seconds between idle gaze direction changes */
  idleGazeMinInterval: number = 2.0;

  /** Maximum seconds between idle gaze direction changes */
  idleGazeMaxInterval: number = 5.0;

  /** Maximum horizontal angle (degrees) for idle gaze from forward */
  idleGazeMaxAngle: number = 45.0;

  /** Height offset added to target position for look-at (accounts for actor height) */
  targetHeightOffset: number = 1.5;

  // Internal state
  /**
   * Turn the body toward an acquired target.
   *
   * `ActorLookController` is the natural home for this, but NOTHING in this
   * package registers one — `ActorTransformMoveComponent` registers movement
   * and body direction, and no component registers look at all. So an actor
   * running this behavior gives no visible sign of attention unless the body
   * turns. `LeadBehavior` already claims body direction for the same reason.
   *
   * A body turn is a whole-actor yaw. The package's only skeleton mask
   * (`Assets/masks/human_upper_body.skelmask`) cannot substitute: it selects
   * which joints an authored CLIP drives, it does not aim anything at a world
   * position. A head- or chest-only turn needs a procedural look rig, which is
   * what the missing `ActorLookController` would provide.
   */
  turnBodyToTarget: boolean = true;

  /**
   * While turning to a target, also claim movement and stand still, as
   * `LeadBehavior` does while waiting. Without it, a lower-priority walker
   * (Wander, Patrol) keeps the movement controller and the actor walks
   * sideways or backwards while facing the target.
   */
  holdPositionWhileFacing: boolean = false;

  /** Radians per second for the body turn. Matches LeadBehavior's default. */
  bodyDirectionAngularSpeed: number = 3.14;

  private currentTarget: Entity | null = null;
  private readonly targetLog: TargetLog = new TargetLog('looking at');
  private hasTarget: boolean = false;
  private desiredBodyDirection: Vec3 | null = null;
  private idleGazeTimer: number = 0;
  private idleGazeInterval: number = 3.0;
  private idleGazeDirection: Vec3 | null = null;
  private actorTransform: TransformComponent | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    this.resetIdleGazeTimer();
  }

  override update(deltaTime: number): void {
    this.updateTarget();
    this.targetLog.note(this, this.currentTarget);

    if (this.hasTarget) {
      // Reset idle gaze timer while tracking a target
      this.resetIdleGazeTimer();
      this.updateDesiredBodyDirection();
    } else {
      this.desiredBodyDirection = null;
      if (this.idleGazeEnabled) {
        this.updateIdleGaze(deltaTime);
      }
    }
  }

  /**
   * Horizontal unit vector from the actor to its target, or null when the two
   * are stacked. Flattened to XZ because a body turn is a yaw — pitching the
   * whole actor toward a target above or below it would tip the character over.
   */
  private updateDesiredBodyDirection(): void {
    this.desiredBodyDirection = null;
    const actorPos = this.getEntity()?.getComponent(TransformComponent)?.worldPosition;
    const targetPos = this.currentTarget?.getComponent(TransformComponent)?.worldPosition;
    if (!actorPos || !targetPos) {
      return;
    }
    const toTarget = targetPos.sub(actorPos);
    const horizontal = new Vec3(toTarget.x, 0, toTarget.z);
    const magnitude = horizontal.magnitude();
    if (magnitude > 0.001) {
      this.desiredBodyDirection = horizontal.mul(1 / magnitude);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorLookControllerTypeId) {
      // Always claim look controller — idle gaze or target tracking
      if (this.hasTarget || (this.idleGazeEnabled && this.idleGazeDirection != null)) {
        return this.basePriority;
      }
    }
    // Body direction is claimed ONLY while a target is held, never for idle
    // gaze: an idle actor slowly rotating on the spot reads as broken, and the
    // gaze is meant to be a glance, not a turn.
    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.turnBodyToTarget &&
      this.hasTarget &&
      this.desiredBodyDirection != null
    ) {
      return this.basePriority;
    }
    if (controllerType === ActorMovementControllerTypeId && this.isHoldingPosition()) {
      return this.basePriority;
    }
    return -1;
  }

  private isHoldingPosition(): boolean {
    return (
      this.holdPositionWhileFacing &&
      this.turnBodyToTarget &&
      this.hasTarget &&
      this.desiredBodyDirection != null
    );
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorMovementControllerTypeId) {
      const here = this.getEntity()?.getComponent(TransformComponent)?.worldPosition;
      if (this.isHoldingPosition() && here) {
        (controller as ActorMovementController).moveToPosition(new ActorMoveParams(here, null));
      }
      return;
    }
    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.desiredBodyDirection != null
    ) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(
          this.desiredBodyDirection,
          this.bodyDirectionAngularSpeed,
        ),
      );
      return;
    }

    if (controllerType !== ActorLookControllerTypeId) {
      return;
    }

    const lookController = controller as ActorLookController;

    if (this.hasTarget && this.currentTarget) {
      const targetTransform = this.currentTarget.getComponent(TransformComponent);
      if (targetTransform) {
        const targetPos = targetTransform.worldPosition;
        // Offset upward to look at head/center of target, not feet
        const lookAtPos = new Vec3(targetPos.x, targetPos.y + this.targetHeightOffset, targetPos.z);
        lookController.setLookTarget(ActorLookParams.fromTarget(lookAtPos, this.lookSpeed));
      }
    } else if (this.idleGazeEnabled && this.idleGazeDirection) {
      lookController.setLookTarget(ActorLookParams.fromDirection(this.idleGazeDirection, this.idleLookSpeed));
    } else {
      lookController.resetToDefaultLook();
    }
  }

  override onRemove(): void {
    this.isRemoved = true;
    this.currentTarget = null;
    this.hasTarget = false;
    this.idleGazeDirection = null;
    this.desiredBodyDirection = null;
  }

  // #region Private

  private updateTarget(): void {
    if (this.targetMode === AttentionTargetMode.SpecificEntity) {
      if (this.targetEntity && this.isEntityInRange(this.targetEntity)) {
        this.currentTarget = this.targetEntity;
        this.hasTarget = true;
      } else {
        this.currentTarget = null;
        this.hasTarget = false;
      }
      return;
    }

    const nearest =
      this.targetMode === AttentionTargetMode.Tagged
        ? this.findNearestTaggedInRange()
        : this.findNearestPlayerInRange();
    this.currentTarget = nearest;
    this.hasTarget = nearest != null;
  }

  private findNearestTaggedInRange(): Entity | null {
    if (!this.behaviorManager || !this.actorTransform || this.targetTags.length === 0) {
      return null;
    }
    const taggingBB = this.behaviorManager.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      /* actorId */ undefined,
      /* groupId */ undefined,
      BlackboardScope.Global,
    );
    if (!taggingBB) {
      return null;
    }

    const actorPos = this.actorTransform.worldPosition;
    const self = this.getEntity();
    let closest: Entity | null = null;
    let closestDistance = this.attentionRange;
    for (const tag of this.targetTags) {
      for (const entry of taggingBB.getTaggedEntities(tag)) {
        if (entry.entity === self || !entry.entity.valid || isDead(entry.entity)) {
          continue;
        }
        const transform = entry.entity.getComponent(TransformComponent);
        if (!transform) {
          continue;
        }
        const distance = actorPos.sub(transform.worldPosition).magnitude();
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = entry.entity;
        }
      }
    }
    return closest;
  }

  private findNearestPlayerInRange(): Entity | null {
    if (!this.actorTransform) {
      return null;
    }

    return PlayerRoster.get().nearest(this.actorTransform.worldPosition, this.getEntity(), this.attentionRange);
  }

  private isEntityInRange(entity: Entity): boolean {
    if (!this.actorTransform || !entity.valid) {
      return false;
    }

    const entityTransform = entity.getComponent(TransformComponent);
    if (!entityTransform) {
      return false;
    }

    const distance = this.actorTransform.worldPosition.sub(entityTransform.worldPosition).magnitude();
    return distance <= this.attentionRange;
  }

  private updateIdleGaze(deltaTime: number): void {
    this.idleGazeTimer += deltaTime;

    if (this.idleGazeTimer >= this.idleGazeInterval) {
      this.generateNewIdleGazeDirection();
      this.resetIdleGazeTimer();
    }
  }

  private generateNewIdleGazeDirection(): void {
    const maxAngleRad = this.idleGazeMaxAngle * (Math.PI / 180);
    const horizontalAngle = (Math.random() * 2 - 1) * maxAngleRad;
    const verticalAngle = (Math.random() * 2 - 1) * maxAngleRad * 0.3; // Less vertical range

    this.idleGazeDirection = new Vec3(
      Math.sin(horizontalAngle),
      Math.sin(verticalAngle),
      -Math.cos(horizontalAngle),
    ).normalize();
  }

  private resetIdleGazeTimer(): void {
    this.idleGazeTimer = 0;
    this.idleGazeInterval =
      this.idleGazeMinInterval +
      Math.random() * (this.idleGazeMaxInterval - this.idleGazeMinInterval);
  }

  // #endregion
}
