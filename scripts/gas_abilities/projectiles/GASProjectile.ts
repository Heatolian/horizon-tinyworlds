/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v13

import {
  CastMode,
  ColliderSphereComponent,
  CollisionLayerMask,
  Component,
  component,
  OnWorldUpdateEvent,
  PhysicsBodyComponent,
  PhysicsBodyType,
  PhysicsService,
  subscribe,
  TransformComponent,
  Vec3,
} from 'meta/worlds';
import type {Entity, OnWorldUpdateEventPayload} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {homingAimOf, straightForward} from './Motion';
import type {MotionContext, MotionStep} from './Motion';

/**
 * What a swept step resolved to: the nearest valid target (hit), a wall in
 * front of any target (blocked), or nothing. Hits and blocks carry where the
 * shot stops, just short of the surface.
 */
export type SweepResult =
  | {kind: 'hit'; target: Entity; contact: Vec3}
  | {kind: 'blocked'; contact: Vec3}
  | {kind: 'miss'};

// Both ends of a sweep can sit inside character rigs (the shooter's at launch,
// the target's on arrival), and UnsortedHits returns an arbitrary subset once
// the buffer fills, so leave room for both rigs plus the scene between them.
// An overflowed buffer cannot prove a step clear (as in `Targeting.hasClearShot`).
const MAX_SWEEP_HITS: number = 32;

const PARENT_WALK_MAX_DEPTH: number = 32;

// How far short of the surface a stopped shot rests, so it never embeds.
const CONTACT_PULLBACK_M: number = 0.01;

/** Tag-based target filter (uses the target's GAS tags). */
export interface TagFilter {
  required?: string[]; // target must have ALL of these
  blocked?: string[]; // target must have NONE of these
}

/**
 * Configuration for a flying projectile. Hit detection has two modes:
 *  - Sweep mode (default): each step is cast before the projectile moves; the
 *    nearest valid target lands and a nearer wall stops it. Works in any 3D
 *    world whose targets are DynamicColliders with GAS tags.
 *  - Logic mode (override): supply `findHit` for worlds with no physics (grid /
 *    lane), and it is polled each frame instead of casting.
 * Everything else (motion, onHit effects, despawn) is shared.
 */
export interface ProjectileConfig {
  speed: number;
  step?: MotionStep; // default: straightForward
  homingTarget?: Entity; // if set, steer toward its body collider each frame
  targetFilter?: TagFilter; // sweep mode: which entities count as a hit
  instigator?: Entity; // the shooter — never counts as a hit (avoids self-hits in PvP)
  onHit: (hit: Entity) => void; // GAS effects applied here
  findHit?: (from: Vec3, to: Vec3) => Entity | null; // override -> logic mode
  lifetimeSec?: number; // despawn after this long (prevents leaks)
  isOutOfBounds?: (pos: Vec3) => boolean; // despawn predicate
}

/**
 * Generic projectile: attach to a projectile template. Moves each frame, detects
 * a hit (a swept cast by default, or a supplied findHit), applies onHit and
 * despawns. No game-specific logic lives here — it is all in config.
 *
 * Sweep mode casts first and moves after, with one cast in flight: each cast
 * covers speed × the time since the last move. On a hit or a wall the shot
 * moves to the contact and despawns; on a miss it moves the whole step; on a
 * failed cast it holds, and the next frame retries from the same start. The
 * first cast is a ray from the caster's pivot at muzzle height, so a wall
 * between the caster and the muzzle stops the shot too.
 *
 * For target-seeking motion (tower-defense), set `step: homing` + `homingTarget`;
 * homing steers at the target's body collider, so the sweep lands it like any
 * other motion.
 *
 * The template needs a PhysicsBody of type Trigger + a collider (the projectile
 * is moved kinematically, not by physics). Casts skip triggers, so neither its
 * own collider nor a sibling shot's ever stops it. A sphere collider sets the
 * sweep radius; any other shape sweeps a ray. Targets need a DynamicCollider +
 * a GASComponent with the filter tags. Anything else in the way blocks, a
 * collider with no body included; only a dynamic body without GAS (loot,
 * debris) lets the shot through.
 */
@component({
  description: 'Generic projectile — moves, detects a hit (physics or logic), applies effects.',
})
export class GASProjectile extends Component {
  private config: ProjectileConfig | null = null;
  private transform: TransformComponent | null = null;
  private ageSec: number = 0;
  // A hit or a wall ends the shot once; a verdict resolving after that is dropped.
  private hasHit: boolean = false;
  // Radius of the trigger sphere in world units, read on the first sweep; 0
  // when the trigger is not a sphere, and the sweep falls back to a ray.
  private sweepRadius: number | null = null;
  // Reused across frames: onUpdate runs per-frame per live projectile, so a
  // fresh context literal there allocates once per projectile per frame.
  private motionCtx: MotionContext | null = null;
  /** What homing steers at, resolved once from `homingTarget`. */
  private homingAim: Entity | undefined = undefined;
  /** Where the first cast starts; cleared once that cast resolves. */
  private firstCastFrom: Vec3 | null = null;
  /** Set while a cast is unresolved: the shot holds still and casts nothing new. */
  private castInFlight: boolean = false;
  /** Seconds since the shot last moved; the next cast spans speed × this. */
  private timeSinceMove: number = 0;
  /** The part of `timeSinceMove` the in-flight cast covers. */
  private castSpan: number = 0;
  /** Failed casts in a row, so a persistent failure warns once, not every frame. */
  private failedCasts: number = 0;

  // Called right after spawn. Until configured (config is null) the projectile
  // stays idle, avoiding a spawn/configure race where events fire before wiring.
  configure(config: ProjectileConfig): void {
    this.config = config;
    this.homingAim = config.homingTarget ? homingAimOf(config.homingTarget) : undefined;
    this.firstCastFrom = casterPivot(config.instigator, this.entity);
  }

  /**
   * Returns the per-frame motion context, allocating the backing object once
   * and mutating it thereafter. Lives outside `onUpdate` because the context
   * literal would otherwise allocate once per projectile per frame.
   */
  private motionContextFor(
    transform: TransformComponent,
    deltaTime: number,
    config: ProjectileConfig,
  ): MotionContext {
    const ctx = this.motionCtx ?? {transform, deltaTime, speed: config.speed};
    ctx.transform = transform;
    ctx.deltaTime = deltaTime;
    ctx.speed = config.speed;
    // A body collider removed mid-flight falls back to the target itself.
    const aim = this.homingAim;
    ctx.target = aim && !aim.isDestroyed() ? aim : config.homingTarget;
    this.motionCtx = ctx;
    return ctx;
  }

  @subscribe(OnWorldUpdateEvent)
  onUpdate(payload: OnWorldUpdateEventPayload): void {
    const config = this.config;
    if (!config || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.ageSec += payload.deltaTime;
    if (config.lifetimeSec !== undefined && this.ageSec >= config.lifetimeSec) {
      this.entity.destroy();
      return;
    }
    if (!this.transform) {
      this.transform = this.entity.getComponent(TransformComponent);
    }
    const transform = this.transform;
    if (!transform) {
      return;
    }
    if (config.isOutOfBounds && config.isOutOfBounds(transform.worldPosition)) {
      this.entity.destroy();
      return;
    }

    // Logic mode: synchronous hit test (no physics).
    if (config.findHit) {
      const from = transform.worldPosition;
      const to = (config.step ?? straightForward)(
        this.motionContextFor(transform, payload.deltaTime, config),
      );
      transform.worldPosition = to;
      const hit = config.findHit(from, to);
      if (hit) {
        this.finish(config, hit);
      }
      return;
    }
    if (this.hasHit) {
      return;
    }
    this.timeSinceMove += payload.deltaTime;
    if (!this.castInFlight) {
      this.castNextStep(config, transform);
    }
  }

  /** Casts the step ahead; the shot moves only once the cast resolves. */
  private castNextStep(config: ProjectileConfig, transform: TransformComponent): void {
    const from = transform.worldPosition;
    const to = (config.step ?? straightForward)(
      this.motionContextFor(transform, this.timeSinceMove, config),
    );
    const delta = to.sub(from);
    if (delta.magnitude() <= 0) {
      // Parked on its target: nothing to cast, and no time banked toward a
      // jump once the target moves again.
      this.timeSinceMove = 0;
      return;
    }
    // A muzzle behind the caster (camera-aimed shots) skips the pivot: the
    // shot never travels that segment.
    const pivot = this.firstCastFrom;
    const fromPivot = pivot !== null && to.sub(pivot).dot(delta) > 0;
    this.castInFlight = true;
    this.castSpan = this.timeSinceMove;
    void sweepSegment(
      fromPivot ? pivot : from,
      to,
      config,
      fromPivot ? 0 : this.triggerRadius(),
    ).then(
      result => {
        this.onCastResolved(result, to);
      },
      (e: unknown) => {
        this.onCastFailed(e);
      },
    );
  }

  /** Lands a cast's verdict, unless the shot ended or changed owner while it flew. */
  private onCastResolved(result: SweepResult, to: Vec3): void {
    this.castInFlight = false;
    this.failedCasts = 0;
    const config = this.config;
    const transform = this.transform;
    if (!config || !transform || this.hasHit || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.firstCastFrom = null;
    if (result.kind === 'miss') {
      transform.worldPosition = to;
      // Time banked while the cast flew is still unflown; the next step covers it.
      this.timeSinceMove -= this.castSpan;
      return;
    }
    transform.worldPosition = result.contact;
    this.finish(config, result.kind === 'hit' ? result.target : null);
  }

  /** Holds the shot: the next frame retries from the same start over the longer span. */
  private onCastFailed(e: unknown): void {
    this.castInFlight = false;
    this.failedCasts += 1;
    if (this.failedCasts === 1 && !this.entity.isDestroyed()) {
      console.warn(`[GASProjectile] '${this.entity.name}' sweep cast failed, retrying: ${String(e)}`);
    }
  }

  private triggerRadius(): number {
    if (this.sweepRadius === null) {
      this.sweepRadius = this.entity.isDestroyed() ? 0 : sphereTriggerRadius(this.entity);
    }
    return this.sweepRadius;
  }

  /** Ends the shot once: a hit applies `onHit`, a wall (null) applies nothing. */
  private finish(config: ProjectileConfig, target: Entity | null): void {
    if (this.hasHit) {
      return;
    }
    this.hasHit = true;
    if (target) {
      config.onHit(target);
    }
    if (!this.entity.isDestroyed()) {
      this.entity.destroy();
    }
  }
}

/**
 * The caster's pivot raised to the muzzle's height, where the first cast
 * starts: a ray from inside the caster cannot start inside a wall the muzzle
 * is pressed against. Null without a locatable caster.
 */
function casterPivot(caster: Entity | undefined, projectile: Entity): Vec3 | null {
  const casterPos =
    caster && !caster.isDestroyed() ? caster.getComponent(TransformComponent)?.worldPosition : null;
  const muzzle = projectile.getComponent(TransformComponent)?.worldPosition;
  return casterPos && muzzle ? new Vec3(casterPos.x, muzzle.y, casterPos.z) : null;
}

/**
 * World-space radius of the projectile's sphere collider (on the entity or a
 * descendant), or 0 if it has none. Scaled like the trigger it describes.
 */
export function sphereTriggerRadius(entity: Entity): number {
  let holder: Entity | null = entity.getComponent(ColliderSphereComponent) ? entity : null;
  if (!holder) {
    const children = entity.getChildrenWithComponent(ColliderSphereComponent, true);
    holder = children.length > 0 ? children[0] : null;
  }
  const sphere = holder?.getComponent(ColliderSphereComponent);
  if (!holder || !sphere) {
    return 0;
  }
  const scale = holder.getComponent(TransformComponent)?.worldScale;
  const factor = scale ? Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) : 1;
  return sphere.radius * factor;
}

/**
 * Casts a sphere of `radius` from `from` to `to` (a ray when 0) and resolves it
 * by who the nearest hits belong to. A valid target lands. Anything else under
 * a GAS entity (the shooter's rig, a filtered or dead actor) passes through, so
 * allies never body-block. Everything else blocks unless its nearest body is
 * dynamic (loot, debris): a collider with no body is a wall. A target level
 * with a wall wins, so an enemy flush against cover is hittable.
 */
export async function sweepSegment(
  from: Vec3,
  to: Vec3,
  config: ProjectileConfig,
  radius: number = 0,
): Promise<SweepResult> {
  const delta = to.sub(from);
  const distance = delta.magnitude();
  if (distance <= 0) {
    return {kind: 'miss'};
  }
  const dir = delta.mul(1 / distance);
  const cast = {
    mode: CastMode.UnsortedHits,
    dir,
    distance,
    collisionLayerMask: CollisionLayerMask.AllLayers,
    includeTriggers: false,
    excludeEntities: config.instigator ? ([config.instigator] as [Entity]) : undefined,
    // One more than is read: a full extra slot is how an overflow shows.
    maxUnsortedHits: MAX_SWEEP_HITS + 1,
  };
  const physics = PhysicsService.get();
  const result =
    radius > 0
      ? await physics.sphereCast({...cast, center: from, radius})
      : await physics.rayCast({...cast, origin: from});
  const hits =
    result.hasHitSomething && result.hits
      ? [...result.hits].sort((a, b) => a.distance - b.distance)
      : [];
  let wallAt = Infinity;
  for (const hit of hits) {
    if (hit.distance > wallAt) {
      break;
    }
    // Some geometry has no Platform API actor, and a mid-teardown cast can
    // report a destroyed actor beside a live shape: fall back to the shape.
    const collider = liveOrNull(hit.actorEntity) ?? liveOrNull(hit.shapeEntity);
    if (!collider) {
      continue;
    }
    const gasEntity = findGasEntity(collider);
    if (gasEntity) {
      if (isTarget(gasEntity, config)) {
        return {kind: 'hit', target: gasEntity, contact: contactAt(from, dir, hit.distance)};
      }
    } else if (
      wallAt === Infinity &&
      findPhysicsBody(collider)?.type !== PhysicsBodyType.DynamicCollider
    ) {
      wallAt = hit.distance;
    }
  }
  if (wallAt < Infinity) {
    return {kind: 'blocked', contact: contactAt(from, dir, wallAt)};
  }
  // An overflowed buffer may have dropped a wall, so it never reads as a miss:
  // with no target or wall among the hits it returned, the shot ends in place.
  return hits.length > MAX_SWEEP_HITS ? {kind: 'blocked', contact: from} : {kind: 'miss'};
}

/** Whether a GAS entity is a valid target for this shot: not the shooter, and passing the tag filter. */
function isTarget(gasEntity: Entity, config: ProjectileConfig): boolean {
  if (gasEntity === config.instigator) {
    return false; // never hit the shooter that fired this projectile
  }
  const gas = gasEntity.getComponent(GASComponent);
  if (!gas) {
    return false;
  }
  const filter = config.targetFilter;
  if (filter?.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
    return false;
  }
  if (filter?.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked)) {
    return false;
  }
  return true;
}

function contactAt(from: Vec3, dir: Vec3, distance: number): Vec3 {
  return from.add(dir.mul(Math.max(0, distance - CONTACT_PULLBACK_M)));
}

function liveOrNull(entity: Entity | null | undefined): Entity | null {
  return !entity || entity.isDestroyed() ? null : entity;
}

// The nearest physics body at or above `entity`. A collider usually hangs off
// the body that drives it (a capsule under a kinematic character), and the
// nearest body owns it, so a dynamic body nested under a static root is found
// first. A destroyed entity answers getComponent with null but throws from
// `parent`, so validity gates both walks.
function findPhysicsBody(entity: Entity): PhysicsBodyComponent | null {
  let current: Entity | null = entity;
  for (let depth = 0; current !== null && current.valid && depth < PARENT_WALK_MAX_DEPTH; depth++) {
    const body = current.getComponent(PhysicsBodyComponent);
    if (body) {
      return body;
    }
    current = current.parent;
  }
  return null;
}

// Resolve the entity carrying the GASComponent, starting at `entity` and walking
// up its ancestors. Colliders are frequently on descendants of the entity that
// owns the GAS state (e.g. a player capsule under the avatar root), so a direct
// getComponent on the collider entity would miss it.
function findGasEntity(entity: Entity): Entity | null {
  let current: Entity | null = entity;
  for (let depth = 0; current !== null && current.valid && depth < PARENT_WALK_MAX_DEPTH; depth++) {
    if (current.getComponent(GASComponent)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}
