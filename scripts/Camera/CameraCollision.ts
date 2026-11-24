/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v8

/**
 * Camera collision avoidance, shared by every orbiting camera mode.
 *
 * Physics casts resolve asynchronously. A completed result is therefore applied
 * to the exact pivot and direction that produced it instead of being
 * transplanted onto a newer camera ray.
 */

import {
  CastMode,
  CollisionLayer,
  PhysicsBodyComponent,
  PhysicsBodyType,
  PhysicsService,
  Vec3,
} from 'meta/worlds';
import type {Entity, Quaternion, SceneHitData, SphereCastInput} from 'meta/worlds';

export interface CameraCollisionPose {
  position: Vec3;
  rotation: Quaternion;
}

export interface CameraCollisionQuery {
  pivotPosition: Vec3;
  desiredCameraPosition: Vec3;
  desiredCameraRotation: Quaternion;
  /** Target's largest world-scale axis; scales the camera probe radius. */
  scale: number;
  /**
   * Interpolation factor used only when a validated ray permits moving out;
   * 1 snaps straight back out.
   */
  releaseSmoothingFactor: number;
  /** Excluded from hits so the player's own body never pushes the camera in. */
  targetEntity: Entity | null;
}

export interface CameraCastRequest {
  origin: Vec3;
  direction: Vec3;
  distance: number;
  radius: number;
  collisionLayerMask: number;
  maxHits: number;
  targetEntity: Entity | null;
}

export interface CameraCastResult {
  hasCollision: boolean;
  hitDistance: number;
}

/** A null result means the cast failed and carries no obstruction data. */
export type CameraCaster = (
  request: CameraCastRequest,
  deliver: (result: CameraCastResult | null) => void,
) => void;

const CAMERA_PROBE_RADIUS = 0.1;
const MIN_CAST_DISTANCE = 0.001;

export class CameraCollision {
  private collisionLayerMask: number = 0;
  private resolvedCameraPose: CameraCollisionPose | null = null;
  private resolvedCameraDistance: number | null = null;
  private raycastGeneration: number = 0;
  private latestAppliedGeneration: number = 0;
  private epoch: number = 0;

  public numRaycastAttempts: number = 9;
  public collisionLayers: readonly CollisionLayer[] = [CollisionLayer.Layer2];

  constructor(private readonly caster: CameraCaster = castCamera) {
    this.rebuildLayerMask();
  }

  public rebuildLayerMask(): void {
    this.collisionLayerMask = 0;
    for (const layer of this.collisionLayers) {
      this.collisionLayerMask |= 1 << layer;
    }
  }

  public reset(): void {
    this.resolvedCameraPose = null;
    this.resolvedCameraDistance = null;
    this.latestAppliedGeneration = 0;
    this.epoch++;
  }

  /**
   * Returns the latest validated position and its matching requested rotation.
   * A null result leaves the entire rendered pose unchanged during startup.
   */
  public resolve(query: CameraCollisionQuery): CameraCollisionPose | null {
    const {pivotPosition, desiredCameraPosition, desiredCameraRotation} = query;
    if (this.collisionLayerMask === 0) {
      return {position: desiredCameraPosition, rotation: desiredCameraRotation};
    }

    const offset = desiredCameraPosition.sub(pivotPosition);
    const distance = offset.magnitude();
    if (distance < MIN_CAST_DISTANCE) {
      this.latestAppliedGeneration = ++this.raycastGeneration;
      this.resolvedCameraPose = {
        position: desiredCameraPosition,
        rotation: desiredCameraRotation,
      };
      this.resolvedCameraDistance = distance;
      return this.resolvedCameraPose;
    }

    const request: CameraCastRequest = {
      origin: pivotPosition,
      direction: offset.normalize(),
      distance,
      radius: CAMERA_PROBE_RADIUS * query.scale,
      collisionLayerMask: this.collisionLayerMask,
      maxHits: this.numRaycastAttempts,
      targetEntity: query.targetEntity,
    };
    const generation = ++this.raycastGeneration;
    const epoch = this.epoch;

    this.caster(request, result => {
      if (
        epoch !== this.epoch ||
        generation <= this.latestAppliedGeneration
      ) {
        return;
      }
      this.latestAppliedGeneration = generation;
      if (result === null) {
        return;
      }
      const priorDistance = this.resolvedCameraDistance ?? request.distance;
      const targetDistance = result.hasCollision
        ? result.hitDistance
        : request.distance;
      const clampedTarget = Math.max(
        0,
        Math.min(targetDistance, request.distance),
      );
      const previousDistance = Math.max(
        0,
        Math.min(priorDistance, request.distance),
      );
      const smoothingFactor = Math.max(
        0,
        Math.min(1, query.releaseSmoothingFactor),
      );
      const resolvedDistance =
        clampedTarget > previousDistance
          ? previousDistance +
            (clampedTarget - previousDistance) * smoothingFactor
          : clampedTarget;
      this.resolvedCameraDistance = resolvedDistance;
      this.resolvedCameraPose = {
        position: request.origin.add(request.direction.mul(resolvedDistance)),
        rotation: desiredCameraRotation,
      };
    });

    return this.resolvedCameraPose;
  }
}

const castCamera: CameraCaster = (request, deliver) => {
  const input: SphereCastInput = {
    center: request.origin,
    radius: request.radius,
    dir: request.direction,
    distance: request.distance,
    mode: CastMode.UnsortedHits,
    maxUnsortedHits: request.maxHits,
    collisionLayerMask: request.collisionLayerMask,
    excludeEntities: request.targetEntity ? [request.targetEntity] : undefined,
  };

  void PhysicsService.get()
    .sphereCast(input)
    .then(output => {
      let closestHit: SceneHitData | null = null;
      for (const hit of output.hits ?? []) {
        if (
          hit.actorEntity === request.targetEntity ||
          hit.shapeEntity === request.targetEntity
        ) {
          continue;
        }

        const physicsBody =
          hit.actorEntity?.getComponent(PhysicsBodyComponent);
        if (
          physicsBody &&
          physicsBody.type !== PhysicsBodyType.StaticCollision
        ) {
          continue;
        }

        if (closestHit === null || hit.distance < closestHit.distance) {
          closestHit = hit;
        }
      }

      deliver(
        closestHit
          ? {
              hasCollision: true,
              hitDistance: Math.min(closestHit.distance, request.distance),
            }
          : {hasCollision: false, hitDistance: 0},
      );
    })
    .catch(error => {
      console.error('[CameraCollision] sphere cast failed:', error);
      deliver(null);
    });
};
