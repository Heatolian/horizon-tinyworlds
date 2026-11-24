/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {
  CastMode,
  CollisionLayerMask,
  PhysicsService,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';

/** Which entities in range count as targets. Omit a list to skip that check. */
export interface BlastFilter {
  /** Target must carry ALL of these GAS tags. */
  required?: string[];
  /** Target must carry NONE of these GAS tags. */
  blocked?: string[];
}

/** One target the blast reached, and how far it was from the centre. */
export interface BlastHit {
  gasEntity: Entity;
  distance: number;
}

export interface BlastConfig {
  /** Metres from the resolve point. Everything inside is considered. */
  radius: number;

  /** The deployable itself, so its own collider is never a target or cover. */
  source: Entity;

  /** The thrower, when it should be immune to its own grenade. */
  instigator?: Entity;

  /** Omit to reach any entity with a GASComponent, including teammates. */
  targetFilter?: BlastFilter;

  /**
   * Skip targets behind cover. Costs one raycast per candidate, so leave it off
   * for a blast that should reach through walls.
   */
  requireLineOfSight?: boolean;

  /**
   * Meters above a target's root the sight line aims at. A character's root is
   * at its feet, where any curb would read as cover. Default 1.
   */
  targetHeightOffset?: number;

  /** Invoked once per distinct target, on the machine that resolved the blast. */
  onTarget(hit: BlastHit): void;
}

/**
 * Hits read on the line-of-sight trace. UnsortedHits returns an arbitrary subset
 * once its buffer fills, which may drop the nearest blocker, so one extra slot is
 * requested and a full buffer reads as cover (as `Targeting.hasClearShot` does).
 */
const MAX_COVER_HITS = 16;

/**
 * Sphere query around a point, filtered down to distinct GAS-bearing targets.
 *
 * Split out from any one deployable so a grenade, a mine, a healing pulse and an
 * exploding barrel share the "who is in range" question and differ only in what
 * they do about it — `onTarget` is the whole difference.
 */
export async function applyBlast(config: BlastConfig, at: Vec3): Promise<void> {
  const output = await PhysicsService.get().sphereOverlapQuery({
    center: at,
    radius: config.radius,
    collisionLayerMask: CollisionLayerMask.AllLayers,
    reportOverlappingEntities: true,
    excludeEntity: config.source,
  });
  if (!output.hasFoundOverlap) {
    return;
  }

  // One target can host several colliders and the query reports each of them.
  // De-duplicate by the GAS-owning entity rather than by collider, or a blast
  // deals its damage once per body part.
  const reached = new Set<Entity>();
  const candidates: Array<{gasEntity: Entity; to: Vec3}> = [];
  for (const overlapping of output.overlappingActorEntities) {
    const gasEntity = overlapping ? findGasEntity(overlapping) : null;
    if (!gasEntity || reached.has(gasEntity)) {
      continue;
    }
    reached.add(gasEntity);

    if (config.instigator && gasEntity === config.instigator) {
      continue;
    }
    if (!passesFilter(gasEntity, config.targetFilter)) {
      continue;
    }
    const to = worldPositionOf(gasEntity);
    if (to) {
      candidates.push({gasEntity, to});
    }
  }

  // The sight lines are traced together, so every target in range is struck on
  // the same frame rather than one per trace.
  const heightOffset = Vec3.up.mul(config.targetHeightOffset ?? 1);
  const inSight =
    config.requireLineOfSight === true
      ? await Promise.all(candidates.map(({gasEntity, to}) => hasLineOfSight(at, to.add(heightOffset), gasEntity, config)))
      : candidates.map(() => true);
  candidates.forEach(({gasEntity, to}, index) => {
    if (inSight[index]) {
      config.onTarget({gasEntity, distance: to.distance(at)});
    }
  });
}

/**
 * True when nothing solid sits between the blast and the target.
 *
 * Decided by WHO the nearest hit belongs to rather than by excluding the
 * target: `excludeEntities` covers a root entity but never its collider
 * children, so a trace aimed at a character would otherwise be blocked by that
 * character's own capsule and never reach anyone.
 */
async function hasLineOfSight(
  from: Vec3,
  to: Vec3,
  target: Entity,
  config: BlastConfig,
): Promise<boolean> {
  const delta = to.sub(from);
  const distance = delta.magnitude();
  if (distance <= 0) {
    return true;
  }
  const result = await PhysicsService.get().rayCast({
    mode: CastMode.UnsortedHits,
    origin: from,
    dir: delta.normalize(),
    distance,
    collisionLayerMask: CollisionLayerMask.AllLayers,
    includeTriggers: false,
    excludeEntities: [config.source],
    maxUnsortedHits: MAX_COVER_HITS + 1,
  });
  if (!result.hasHitSomething || !result.hits || result.hits.length === 0) {
    return true;
  }
  if (result.hits.length > MAX_COVER_HITS) {
    return false;
  }

  for (const hit of [...result.hits].sort((a, b) => a.distance - b.distance)) {
    const collider = hit.actorEntity;
    if (!collider || collider.isDestroyed()) {
      continue;
    }
    // Geometry has no GAS root, so it falls back to itself and reads as cover.
    const root = findGasEntity(collider) ?? collider;
    if (root === config.source) {
      continue;
    }
    return root === target;
  }
  return true;
}

function worldPositionOf(entity: Entity): Maybe<Vec3> {
  return entity.getComponent(TransformComponent)?.worldPosition ?? null;
}

/** Copy of the tag check GASProjectile applies; kept local while the two shapes settle. */
function passesFilter(gasEntity: Entity, filter: BlastFilter | undefined): boolean {
  const gas = gasEntity.getComponent(GASComponent);
  if (!gas) {
    return false;
  }
  if (filter?.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
    return false;
  }
  if (filter?.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked)) {
    return false;
  }
  return true;
}

/**
 * Copy of GASProjectile's resolver: colliders usually hang off descendants of
 * the entity that owns the GAS state, so a direct getComponent on whatever the
 * query returned would miss it.
 */
function findGasEntity(entity: Entity): Entity | null {
  let current: Entity | null = entity;
  while (current) {
    if (current.getComponent(GASComponent)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}
