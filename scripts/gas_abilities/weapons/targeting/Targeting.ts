/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {CastMode, CollisionLayerMask, PhysicsService, TransformComponent} from 'meta/worlds';
import type {Entity, Maybe, Vec3} from 'meta/worlds';
import {GASComponent} from '../../../gas/core/GASComponent';

/** Tag-based target filter (uses the candidate's GAS tags). */
export interface TargetFilter {
  required?: string[]; // candidate must have ALL of these
  blocked?: string[]; // candidate must have NONE of these
}

/** Whether `gas` carries every `required` tag and none of the `blocked` ones. */
export function passesTagFilter(gas: GASComponent, filter: TargetFilter | undefined): boolean {
  if (filter?.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
    return false;
  }
  return !(filter?.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked));
}

export interface TargetQueryOptions {
  // Collision layers to search. Defaults to every layer: characters, props and
  // NPCs are routinely authored on different ones (a player capsule sits on
  // Layer1, a freshly created collider on Layer2), and the GAS + tag filtering
  // below is what decides who is a target. Narrow it only as an optimisation.
  collisionLayerMask?: CollisionLayerMask;
  exclude?: Entity; // skip this entity (e.g. the caster)
}

/**
 * The physics query reports colliders and physics bodies, which on a character
 * are child entities — a player's capsule and its KinematicCharacter body both
 * hang off the root that actually carries the GASComponent. Walk up to the
 * first ancestor that has one; that entity is the target.
 */
export function resolveGasEntity(
  hit: Entity,
): {entity: Entity; gas: GASComponent} | null {
  let current: Maybe<Entity> = hit;
  while (current != null && !current.isDestroyed()) {
    const gas = current.getComponent(GASComponent);
    if (gas) {
      return {entity: current, gas};
    }
    current = current.parent;
  }
  return null;
}

/**
 * Every GAS-bearing entity overlapping the sphere that passes `filter`, paired
 * with its squared distance from `origin` and sorted nearest-first.
 *
 * Both reported arrays are scanned: `overlappingActorEntities` misses a
 * collider whose physics body lives on a sibling, `overlappingShapeEntities`
 * misses a body with no collider of its own. Several hits routinely resolve to
 * one character, so results are deduplicated by the resolved entity.
 */
async function collectTargets(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Array<{entity: Entity; distSq: number}>> {
  const exclude = options?.exclude;
  const output = await PhysicsService.get().sphereOverlapQuery({
    center: origin,
    radius,
    collisionLayerMask: options?.collisionLayerMask ?? CollisionLayerMask.AllLayers,
    reportOverlappingEntities: true,
    includeTriggers: true,
    excludeEntities: exclude ? ([exclude] as [Entity]) : undefined,
  });

  const seen = new Set<Entity>();
  const matches: Array<{entity: Entity; distSq: number}> = [];
  for (const hit of [...output.overlappingActorEntities, ...output.overlappingShapeEntities]) {
    if (!hit || hit.isDestroyed()) {
      continue;
    }
    const resolved = resolveGasEntity(hit);
    if (!resolved) {
      continue;
    }
    const {entity, gas} = resolved;
    // The query's excludeEntities only drops the caster's own entity; its
    // collider and body children still come back and resolve up to it here.
    if (entity === exclude || seen.has(entity)) {
      continue;
    }
    seen.add(entity);
    if (!passesTagFilter(gas, filter)) {
      continue;
    }
    const transform = entity.getComponent(TransformComponent);
    if (!transform) {
      continue;
    }
    matches.push({entity, distSq: transform.worldPosition.distanceSquared(origin)});
  }
  matches.sort((a, b) => a.distSq - b.distSq);
  return matches;
}

/**
 * Shared, cross-ability target selection. Returns the nearest entity within
 * `radius` of `origin` that has a GASComponent matching `filter` (by GAS tags).
 * That is the GAS-owning entity, not the collider that was hit — see
 * {@link resolveGasEntity}.
 *
 * Genre-agnostic: any ability (projectile homing, melee, aura) can use it.
 * Async because it runs a physics overlap query — await it before acting (e.g.
 * pick the target, then launch a homing projectile at it).
 */
export async function nearestTargetInRadius(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Entity | null> {
  const matches = await collectTargets(origin, radius, filter, options);
  return matches.length > 0 ? matches[0].entity : null;
}

/**
 * Like {@link nearestTargetInRadius}, but returns every matching entity within
 * `radius` of `origin`, sorted nearest-first.
 */
export async function allTargetsInRadius(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Entity[]> {
  const matches = await collectTargets(origin, radius, filter, options);
  return matches.map(m => m.entity);
}

// Both ends of a shot ray sit inside character rigs (capsule, held weapon, rig
// shapes), and UnsortedHits returns an arbitrary subset once the buffer fills,
// so leave room for both rigs plus the scene between them.
const MAX_SHOT_HITS = 32;

const PARENT_WALK_MAX_DEPTH = 32;

export interface ClearShotQuery {
  origin: Vec3;
  /** Ray direction; normalized here. */
  direction: Vec3;
  distance: number;
  /** Its colliders and its descendants' never block. */
  shooter: Entity;
  /** The shot is clear when the first collider hit past the shooter is under this entity. */
  target: Entity;
  /**
   * What reaching `distance` with nothing hit means. True when the ray ends at
   * a point on the target (a sight line): nothing was in the way. False when it
   * probes along an aim that must strike the target.
   */
  clearIfNothingHit: boolean;
}

/**
 * Whether a round fired along the ray would strike `target` first. Casts what
 * a hitscan round stops on (`WeaponHitscanFireAbility.deliver`): every layer,
 * no triggers. Hits are matched to the shooter and target by hierarchy, so
 * colliders on child entities count as theirs.
 *
 * A full hit buffer may have dropped a closer blocker, so it never reads as
 * clear. Rejects when the physics query does.
 */
export async function hasClearShot(query: ClearShotQuery): Promise<boolean> {
  const {shooter, target} = query;
  const result = await PhysicsService.get().rayCast({
    mode: CastMode.UnsortedHits,
    origin: query.origin,
    dir: query.direction.normalize(),
    distance: query.distance,
    collisionLayerMask: CollisionLayerMask.AllLayers,
    includeTriggers: false,
    excludeEntities: [shooter] as [Entity],
    // One more than is read: a full extra slot is how an overflow shows.
    maxUnsortedHits: MAX_SHOT_HITS + 1,
  });
  const hits = result.hasHitSomething && result.hits ? result.hits : [];
  if (hits.length > MAX_SHOT_HITS) {
    return false;
  }
  const ordered = [...hits].sort((a, b) => a.distance - b.distance);
  for (const hit of ordered) {
    const collider = hit.actorEntity;
    if (!collider || collider.isDestroyed()) {
      continue;
    }
    if (isUnderAny(collider, [shooter])) {
      continue;
    }
    return isUnderAny(collider, [target]);
  }
  return query.clearIfNothingHit;
}

/** One hit of a cast: the collider's entity and how far along the ray it was. */
export interface RayHit {
  actorEntity: Maybe<Entity>;
  distance: number;
}

/**
 * The target a ray strikes first, or null when the first thing past the
 * shooter is not one (a wall, a teammate, a corpse). Colliders under the
 * shooter are skipped; the rest resolve to their GAS owner like
 * {@link resolveGasEntity}.
 */
export function firstTargetHit(hits: readonly RayHit[], shooter: Entity, filter: TargetFilter): Entity | null {
  const ordered = [...hits].sort((a, b) => a.distance - b.distance);
  for (const hit of ordered) {
    const collider = hit.actorEntity;
    if (collider == null || collider.isDestroyed() || isUnderAny(collider, [shooter])) {
      continue;
    }
    const resolved = resolveGasEntity(collider);
    return resolved != null && passesTagFilter(resolved.gas, filter) ? resolved.entity : null;
  }
  return null;
}

/** Whether `entity` is one of `roots` or sits below one of them. */
export function isUnderAny(entity: Entity, roots: readonly Entity[]): boolean {
  let current: Maybe<Entity> = entity;
  for (let depth = 0; current != null && depth < PARENT_WALK_MAX_DEPTH; depth++) {
    if (roots.indexOf(current) >= 0) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
