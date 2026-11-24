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
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  type ActorMovementController,
  ActorMoveParams,
} from 'meta/worlds';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';
import {
  ActorLookControllerTypeId,
  type ActorLookController,
  ActorLookParams,
} from 'meta/worlds';
import {BlackboardScope} from 'meta/worlds';
import {ActorTaggingBlackboard} from 'meta/worlds';
import {PlayerRoster, type NearestPlayerOptions} from '../../Utilities/PlayerRoster';

const GROUND_DISTANCE: NearestPlayerOptions = {horizontal: true};

// Resume at least this far inside the wait distance. With no gap, a player trailing
// at the wait distance crosses one boundary back and forth and every resume rebuilds
// the goto; the gap is halved for authored wait distances under 2 m.
const MIN_RESUME_GAP_METERS = 1.0;

/**
 * State machine states for the LeadBehavior.
 */
enum LeadState {
  /** Actor is walking toward the destination */
  Leading,
  /** Actor has stopped and is waiting for the player to catch up */
  WaitingForPlayer,
  /** Actor has reached the destination */
  Arrived,
}

/**
 * LeadBehavior - Makes an Actor lead the player to a destination.
 *
 * The Actor walks toward a destination while monitoring the player's distance.
 * If the player falls behind (beyond maxPlayerDistance), the Actor stops and
 * turns to face the player. When the player catches up (within resumePlayerDistance),
 * the Actor resumes leading.
 *
 * Uses GotoBehavior internally for locomotion and NavMesh pathfinding.
 * Claims ActorLookController when waiting to face the player.
 */
export class LeadBehavior extends ActorBehavior {
  /** World position of the destination to lead the player to */
  destination: Vec3 = new Vec3(0, 0, 0);

  /** Tag of the destination entity. If set, overrides destination with the closest tagged entity's position. */
  destinationTag: string = '';

  /** Movement speed in meters/second */
  leadSpeed: number = 2.0;

  /** Distance from destination to consider "arrived" */
  arrivalThreshold: number = 1.0;

  /** Distance at which the Actor stops to wait for the player */
  maxPlayerDistance: number = 8.0;

  /** Distance at which the Actor resumes leading after waiting; kept at least MIN_RESUME_GAP_METERS inside maxPlayerDistance */
  resumePlayerDistance: number = 4.0;

  /** If true, automatically targets the closest player */
  followClosestPlayer: boolean = true;

  /** Specific player entity to lead when followClosestPlayer is false; the closest player while null */
  targetPlayer: Entity | null = null;

  /** If true, only considers XZ distances (ignores height) */
  use2DDistance: boolean = true;

  /** Angular speed in radians per second for body direction rotation */
  bodyDirectionAngularSpeed: number = 3.14;

  /** Height offset for look-at target when waiting for player */
  targetHeightOffset: number = 1.5;

  /** True once the behavior manager has removed this behavior; it no longer updates. */
  isRemoved: boolean = false;

  // Internal state
  private state: LeadState = LeadState.Leading;
  private gotoBehavior: GotoBehavior | null = null;
  private actorTransform: TransformComponent | null = null;
  private currentPlayer: Entity | null = null;
  private desiredBodyDirection: Vec3 | null = null;
  private warnedMissingTargetPlayer: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    this.state = LeadState.Leading;

    // Resolve destination from tag if set
    if (this.destinationTag.length > 0) {
      this.resolveDestinationFromTag();
    }

    this.initGotoBehavior();
  }

  override update(deltaTime: number): void {
    this.updateCurrentPlayer();

    if (!this.actorTransform || !this.gotoBehavior) {
      return;
    }

    const actorPos = this.actorTransform.worldPosition;

    // Check if we've arrived at the destination
    const distToDest = this.calculateDistance(actorPos, this.destination);
    if (distToDest <= this.arrivalThreshold) {
      this.state = LeadState.Arrived;
      this.isFinished = true;
      return;
    }

    const playerDistance = this.getPlayerDistance(actorPos);

    switch (this.state) {
      case LeadState.Leading:
        this.updateLeading(deltaTime, playerDistance);
        break;
      case LeadState.WaitingForPlayer:
        this.updateWaiting(deltaTime, playerDistance, actorPos);
        break;
      case LeadState.Arrived:
        this.isFinished = true;
        break;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (this.state === LeadState.Arrived) {
      return -1;
    }

    if (this.state === LeadState.Leading && this.gotoBehavior) {
      return this.gotoBehavior.getControllerUsePriority(controllerType);
    }

    if (this.state === LeadState.WaitingForPlayer) {
      // While waiting: control body direction to face player, and look at player
      if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
        return this.basePriority;
      }
      if (controllerType === ActorLookControllerTypeId) {
        return this.basePriority;
      }
      // Stop movement
      if (controllerType === ActorMovementControllerTypeId) {
        return this.basePriority;
      }
    }

    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (this.state === LeadState.Leading && this.gotoBehavior) {
      this.gotoBehavior.useController(controllerType, controller);
      return;
    }

    if (this.state === LeadState.WaitingForPlayer) {
      if (controllerType === ActorMovementControllerTypeId) {
        // Stop movement by targeting current position
        const currentPos = this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);
        (controller as ActorMovementController).moveToPosition(new ActorMoveParams(currentPos, null));
      }
      if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
        (controller as ActorBodyDirectionController).rotateBodyTo(
          new ActorBodyDirectionParams(this.desiredBodyDirection, this.bodyDirectionAngularSpeed),
        );
      }
      if (controllerType === ActorLookControllerTypeId && this.currentPlayer) {
        const playerTransform = this.currentPlayer.getComponent(TransformComponent);
        if (playerTransform) {
          const playerPos = playerTransform.worldPosition;
          const lookAtPos = new Vec3(playerPos.x, playerPos.y + this.targetHeightOffset, playerPos.z);
          (controller as ActorLookController).setLookTarget(
            ActorLookParams.fromTarget(lookAtPos, 0.15),
          );
        }
      }
    }
  }

  override onRemove(): void {
    this.isRemoved = true;
    this.gotoBehavior = null;
    this.currentPlayer = null;
    this.desiredBodyDirection = null;
  }

  // #region Private

  private initGotoBehavior(): void {
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.targetPosition = this.destination;
    this.gotoBehavior.desiredSpeed = this.leadSpeed;
    this.gotoBehavior.distanceToStop = this.arrivalThreshold;
    this.gotoBehavior.basePriority = this.basePriority;
    // LeadBehavior owns body direction (it faces the player while waiting);
    // the nested goto must not claim the body-direction controller.
    this.gotoBehavior.shouldFaceDirection = false;

    if (this.behaviorManager) {
      void this.gotoBehavior.initialize(this.behaviorManager);
    }
  }

  private updateLeading(deltaTime: number, playerDistance: number): void {
    if (playerDistance > this.maxPlayerDistance) {
      this.state = LeadState.WaitingForPlayer;
      return;
    }

    // Update goto toward destination. Speed is re-copied every frame so a live edit
    // reaches the nested goto without waiting for a resume.
    if (this.gotoBehavior) {
      this.gotoBehavior.targetPosition = this.destination;
      this.gotoBehavior.desiredSpeed = this.leadSpeed;
      void this.gotoBehavior.update(deltaTime);
    }
  }

  private updateWaiting(_deltaTime: number, playerDistance: number, actorPos: Vec3): void {
    if (playerDistance <= this.effectiveResumeDistance()) {
      this.state = LeadState.Leading;
      // Reinitialize goto to pick up from current position
      this.initGotoBehavior();
      return;
    }

    // Face the player while waiting
    if (this.currentPlayer) {
      const playerTransform = this.currentPlayer.getComponent(TransformComponent);
      if (playerTransform) {
        const playerPos = playerTransform.worldPosition;
        const toPlayer = playerPos.sub(actorPos);
        const horizontal = this.use2DDistance
          ? new Vec3(toPlayer.x, 0, toPlayer.z)
          : toPlayer;
        const mag = horizontal.magnitude();
        if (mag > 0.001) {
          this.desiredBodyDirection = horizontal.mul(1 / mag);
        }
      }
    }
  }

  // Enforced here rather than in the starter so authored, template and live-edited
  // values are all covered.
  private effectiveResumeDistance(): number {
    const gap = Math.min(MIN_RESUME_GAP_METERS, this.maxPlayerDistance / 2);
    return Math.min(this.resumePlayerDistance, this.maxPlayerDistance - gap);
  }

  private updateCurrentPlayer(): void {
    // Only a null targetPlayer falls back: without it the actor reads an infinite player
    // distance and waits forever with no sign why. A target that was set and has since
    // left keeps the actor waiting for it, as before.
    const fallBackToClosest = !this.followClosestPlayer && this.targetPlayer == null;
    if (!fallBackToClosest) {
      this.warnedMissingTargetPlayer = false;
    } else if (!this.warnedMissingTargetPlayer) {
      console.warn('[LeadBehavior] followClosestPlayer is off but targetPlayer is unset; leading the closest player.');
      this.warnedMissingTargetPlayer = true;
    }
    if ((this.followClosestPlayer || fallBackToClosest) && this.actorTransform) {
      // Measured the way the lead distances are (`use2DDistance`); a dead player is not led.
      const closestPlayer = PlayerRoster.get().nearest(
        this.actorTransform.worldPosition,
        this.getEntity(),
        Number.POSITIVE_INFINITY,
        this.use2DDistance ? GROUND_DISTANCE : undefined,
      );

      if (closestPlayer) {
        this.currentPlayer = closestPlayer;
      }
    } else {
      this.currentPlayer = this.targetPlayer != null && this.targetPlayer.valid ? this.targetPlayer : null;
    }
  }

  private getPlayerDistance(actorPos: Vec3): number {
    if (!this.currentPlayer) {
      return Infinity;
    }
    const playerTransform = this.currentPlayer.getComponent(TransformComponent);
    if (!playerTransform) {
      return Infinity;
    }
    return this.calculateDistance(actorPos, playerTransform.worldPosition);
  }

  private calculateDistance(a: Vec3, b: Vec3): number {
    const diff = a.sub(b);
    if (this.use2DDistance) {
      return Math.sqrt(diff.x * diff.x + diff.z * diff.z);
    }
    return diff.magnitude();
  }

  /**
   * Resolves the destination position from the closest entity with destinationTag.
   * Called once during initialize(). If no tagged entity is found, destination
   * remains at its default/configured Vec3 value.
   */
  private resolveDestinationFromTag(): void {
    if (!this.behaviorManager || !this.actorTransform) {
      return;
    }

    const taggingBB = this.behaviorManager.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      /* actorId */ undefined,
      /* groupId */ undefined,
      BlackboardScope.Global,
    );

    if (!taggingBB) {
      return;
    }

    const tagged = taggingBB.getTaggedEntities(this.destinationTag);
    if (tagged.length === 0) {
      console.warn(`[LeadBehavior] No entities found with tag "${this.destinationTag}"`);
      return;
    }

    const actorPos = this.actorTransform.worldPosition;
    const selfEntity = this.getEntity();

    let closestEntity: Entity | null = null;
    let closestDistSq = Infinity;

    for (const entry of tagged) {
      if (entry.entity === selfEntity) {
        continue;
      }
      const transform = entry.entity.getComponent(TransformComponent);
      if (!transform) {
        continue;
      }
      const diff = actorPos.sub(transform.worldPosition);
      const distSq = diff.x * diff.x + diff.z * diff.z;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closestEntity = entry.entity;
      }
    }

    if (closestEntity) {
      const transform = closestEntity.getComponent(TransformComponent);
      if (transform) {
        this.destination = transform.worldPosition;
      }
    }
  }

  // #endregion
}
