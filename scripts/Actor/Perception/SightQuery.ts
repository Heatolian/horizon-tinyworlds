/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v37

import {CastMode, CollisionLayerMask, PhysicsService, type Entity, type Vec3} from 'meta/worlds';
import {hasClearShot, isUnderAny, resolveGasEntity} from '../../gas_abilities/weapons/targeting/Targeting';

/**
 * Roots whose colliders a cover ray skips. `rayCast` excludes at most four
 * entities, so the type allows no more and none is silently dropped.
 */
export type IgnoredRoots =
  | readonly [Entity]
  | readonly [Entity, Entity]
  | readonly [Entity, Entity, Entity]
  | readonly [Entity, Entity, Entity, Entity];

/**
 * The two line-of-sight questions the shooter behaviors ask. Asynchronous
 * because the physics queries are; callers keep the last answer and re-ask on
 * a cadence rather than awaiting inside an update.
 */
export interface SightQuery {
  /**
   * Whether a round fired from `from` toward `to` (a point on `target`) would
   * strike `target` first. Anything else, other characters included, blocks.
   */
  hasClearShot(from: Vec3, to: Vec3, shooter: Entity, target: Entity): Promise<boolean>;
  /**
   * Whether world geometry (Layer2) leaves the line open. Colliders under
   * `ignoreRoots`, and any character (anything carrying a GASComponent), do
   * not block: for cover, a character in the line is not cover, it moves.
   */
  isWorldClear(from: Vec3, to: Vec3, ignoreRoots: IgnoredRoots): Promise<boolean>;
}

// A cover ray starts and ends at points near character rigs whose colliders
// are skipped by hierarchy, so leave room for them before a blocker.
const MAX_COVER_HITS = 32;

const MIN_SIGHT_DISTANCE = 0.01;

type ExcludeEntities =
  | [Entity]
  | [Entity, Entity]
  | [Entity, Entity, Entity]
  | [Entity, Entity, Entity, Entity];

/** Physics implementation. The shot question is the weapons' own `hasClearShot`. */
export class PhysicsSightQuery implements SightQuery {
  hasClearShot(from: Vec3, to: Vec3, shooter: Entity, target: Entity): Promise<boolean> {
    const delta = to.sub(from);
    const distance = delta.magnitude();
    if (distance < MIN_SIGHT_DISTANCE) {
      return Promise.resolve(true);
    }
    return hasClearShot({origin: from, direction: delta, distance, shooter, target, clearIfNothingHit: true});
  }

  async isWorldClear(from: Vec3, to: Vec3, ignoreRoots: IgnoredRoots): Promise<boolean> {
    const delta = to.sub(from);
    const distance = delta.magnitude();
    if (distance < MIN_SIGHT_DISTANCE) {
      return true;
    }
    const result = await PhysicsService.get().rayCast({
      mode: CastMode.UnsortedHits,
      origin: from,
      dir: delta.mul(1 / distance),
      distance,
      collisionLayerMask: CollisionLayerMask.Layer2,
      includeTriggers: false,
      excludeEntities: [...ignoreRoots] as ExcludeEntities,
      maxUnsortedHits: MAX_COVER_HITS,
    });
    if (!result.hasHitSomething || !result.hits) {
      return true;
    }
    for (const hit of result.hits) {
      const hitEntity = hit.actorEntity;
      if (!hitEntity || hitEntity.isDestroyed()) {
        continue;
      }
      if (!isUnderAny(hitEntity, ignoreRoots) && resolveGasEntity(hitEntity) == null) {
        return false;
      }
    }
    // A full buffer of skipped hits may have crowded out a blocker: never call that clear.
    return result.hits.length < MAX_COVER_HITS;
  }
}
