/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v5

import {CastMode, CollisionLayerMask, PhysicsService, Vec3, type Entity, type TemplateAsset} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import type {GASEffectData} from '../../gas/effects/GASEffectData';
import {spawnArea} from '../../gas_abilities/deployables/DeployableArea';
import {applyBlast, type BlastHit} from '../../gas_abilities/deployables/DeployableBlast';
import type {Aim} from '../../gas_abilities/weapons/core/AimProvider';
import type {WeaponFireConfigBase} from '../../gas_abilities/weapons/core/WeaponFireAbilityBase';
import type {WeaponAbilitySpec} from '../../gas_abilities/weapons/core/WeaponSetup';
import {
  HITSCAN_ABILITIES,
  type HitResult,
  type HitscanFireConfig,
} from '../../gas_abilities/weapons/hitscan/WeaponHitscanFireAbility';
import {
  MELEE_ABILITIES,
  type MeleeFireConfig,
  type MeleeHitResult,
} from '../../gas_abilities/weapons/melee/WeaponMeleeFireAbility';
import {
  PROJECTILE_ABILITIES,
  type ProjectileWeaponFireConfig,
} from '../../gas_abilities/weapons/projectile/WeaponProjectileFireAbility';
import {resolveGasEntity} from '../../gas_abilities/weapons/targeting/Targeting';
import {
  THROW_ABILITIES,
  type ThrowWeaponFireConfig,
} from '../../gas_abilities/weapons/throw/WeaponThrowFireAbility';

/** What a weapon hands its delivery for one activation. */
export interface WeaponShot {
  holder: Entity;
  aim: Aim;
  refreshAim(): Aim | null;
  /** Only targets carrying this GAS tag count; undefined hits any GAS entity. */
  targetTag: string | undefined;
  /** Applies the weapon's damage to the GAS entity that was hit. */
  damage(gasEntity: Entity): void;
  /**
   * Whether anything else the shot applies (an area's pulses) may affect this
   * GAS entity; `damage` already checks it. Absent: everything may.
   */
  mayAffect?(gasEntity: Entity): boolean;
  /** The entity the driver aims at (an NPC's combat target), when it aims at one. */
  aimTarget?: Entity;
  /** Tells the weapon a thrown shot went off: `deployable` is the networked thing that did. */
  detonated?(deployable: Entity): void;
}

/**
 * How a weapon delivers a shot: which fire ability it grants and that
 * ability's per-shot config. A new kind of weapon is a new delivery (plus a
 * fire ability if none fits); items, containers and equipment stay unchanged.
 */
export interface WeaponDelivery {
  readonly abilities: WeaponAbilitySpec;
  /** Meters a shot can reach; drivers use it to pick targets in range. */
  readonly reach: number;
  /** Cone half-angle, in degrees, a shot's pellets spread across before any bloom. Absent is 0. */
  readonly spreadDeg?: number;
  /** Meters around where a shot goes off that it still reaches (a blast, a lingering area). Absent is 0. */
  readonly splashRadius?: number;
  /** Seconds from activation until a shot leaves (its wind-up), at most. Absent is 0. */
  readonly windupSec?: number;
  /** Seconds from a shot's first round leaving to its last (a burst). Absent is 0. */
  readonly burstSec?: number;
  /**
   * How loud each round is as it leaves the weapon, for whatever listens on the
   * server (NPC hearing scales its range by it). Absent or 0 is silent: the
   * round is not reported.
   */
  readonly loudness?: number;
  /**
   * How loud a shot is when it goes off (a thrown charge), reported through
   * `WeaponShot.detonated`. Absent or 0 is silent.
   */
  readonly detonationLoudness?: number;
  buildFireConfig(shot: WeaponShot): WeaponFireConfigBase;
  validate(): string[];
  /** Once, when the item registers, on every machine: register any effect the delivery applies by id. */
  onRegistered?(): void;
}

function positiveInteger(name: string, value: number | undefined): string[] {
  return value == null || (Number.isInteger(value) && value >= 1) ? [] : [`${name} must be an integer >= 1, got ${String(value)}`];
}

function notNegative(name: string, value: number | undefined): string[] {
  return value == null || value >= 0 ? [] : [`${name} must be >= 0, got ${String(value)}`];
}

export interface HitscanConfig {
  /** Meters. Default 50. */
  range?: number;
  /** Targets one ray may damage; more than 1 pierces. Default 1. */
  maxHits?: number;
  /** Rays per round; more than 1 is a shotgun. Default 1. */
  pelletCount?: number;
  /** Cone half-angle in degrees. Default 0. */
  spreadDeg?: number;
  /** Rounds per trigger pull; more than 1 is a burst. Default 1. */
  burstCount?: number;
  burstIntervalSec?: number;
  /** How loud each round is; 0 is silent (a suppressed gun). Default 1. */
  loudness?: number;
}

/** Instant rays: pistols, rifles, shotguns, snipers. */
export class Hitscan implements WeaponDelivery {
  readonly abilities = HITSCAN_ABILITIES;

  constructor(readonly config: HitscanConfig = {}) {}

  get reach(): number {
    return this.config.range ?? 50;
  }

  get spreadDeg(): number {
    return this.config.spreadDeg ?? 0;
  }

  get burstSec(): number {
    return Math.max(0, (this.config.burstCount ?? 1) - 1) * Math.max(0, this.config.burstIntervalSec ?? 0);
  }

  get loudness(): number {
    return this.config.loudness ?? 1;
  }

  buildFireConfig(shot: WeaponShot): HitscanFireConfig {
    const {config} = this;
    return {
      origin: shot.aim.origin,
      direction: shot.aim.direction,
      range: this.reach,
      maxHits: config.maxHits ?? 1,
      pelletCount: config.pelletCount ?? 1,
      spreadDeg: this.spreadDeg,
      burstCount: config.burstCount ?? 1,
      burstIntervalSec: config.burstIntervalSec ?? 0,
      excludeEntities: [shot.holder],
      targetFilter: shot.targetTag != null ? {required: [shot.targetTag]} : undefined,
      refreshAim: (): Aim | null => shot.refreshAim(),
      onHit: (hit: HitResult): void => shot.damage(hit.gasEntity),
    };
  }

  validate(): string[] {
    const {config} = this;
    return [
      ...(config.range == null || config.range > 0 ? [] : [`range must be > 0, got ${String(config.range)}`]),
      ...positiveInteger('maxHits', config.maxHits),
      ...positiveInteger('pelletCount', config.pelletCount),
      ...positiveInteger('burstCount', config.burstCount),
      ...notNegative('loudness', config.loudness),
    ];
  }
}

export interface MeleeConfig {
  /** Reach in meters. */
  range: number;
  /** Half-angle of the swing arc in degrees; 180 is a full circle. */
  coneHalfAngleDeg: number;
  /** Targets one swing may damage; more than 1 cleaves. Default 1. */
  maxTargets?: number;
  /** Seconds before contact. Default 0. */
  windupSec?: number;
  /** Seconds the swing blocks re-entry after contact. Default 0. */
  recoverySec?: number;
  /** Strike only the entity the driver aims at, when it aims at one, instead of whatever is nearest in the arc. Default false. */
  directedAtAimTarget?: boolean;
}

/** A swing that hits targets in an arc in front of the holder: swords, knives, axes. Never reloads. */
export class Melee implements WeaponDelivery {
  readonly abilities = MELEE_ABILITIES;

  constructor(readonly config: MeleeConfig) {}

  get reach(): number {
    return this.config.range;
  }

  buildFireConfig(shot: WeaponShot): MeleeFireConfig {
    const {config} = this;
    return {
      origin: shot.aim.origin,
      direction: shot.aim.direction,
      refreshAim: (): Aim | null => shot.refreshAim(),
      range: config.range,
      coneHalfAngleDeg: config.coneHalfAngleDeg,
      maxTargets: config.maxTargets ?? 1,
      // A swing queries one arc; pellets and bursts would query the same one again.
      pelletCount: 1,
      spreadDeg: 0,
      burstCount: 1,
      burstIntervalSec: 0,
      windupSec: config.windupSec ?? 0,
      recoverySec: config.recoverySec ?? 0,
      targetFilter: shot.targetTag != null ? {required: [shot.targetTag]} : undefined,
      directedTarget: config.directedAtAimTarget === true ? shot.aimTarget : undefined,
      onHit: (hit: MeleeHitResult): void => shot.damage(hit.gasEntity),
    };
  }

  validate(): string[] {
    const {config} = this;
    return [
      ...(config.range > 0 ? [] : [`range must be > 0, got ${String(config.range)}`]),
      ...(config.coneHalfAngleDeg > 0 ? [] : [`coneHalfAngleDeg must be > 0, got ${String(config.coneHalfAngleDeg)}`]),
      ...positiveInteger('maxTargets', config.maxTargets),
    ];
  }
}

export interface ProjectileConfig {
  /** Spawned once per shot: a template carrying `GASProjectile`, a collider and a trigger `PhysicsBody` (e.g. `Templates/Weapons/Fireball.hstf`). */
  template: TemplateAsset;
  /** Meters per second. */
  speed: number;
  /** Seconds before a projectile that hit nothing despawns. Default 5. */
  lifetimeSec?: number;
  /** Steer toward the driver's aim target. Default false. */
  homeOnTarget?: boolean;
  /** Seconds before release. Default 0. */
  windupSec?: number;
  /** Seconds the throw blocks re-entry after release. Default 0. */
  recoverySec?: number;
}

/** A thrown or launched projectile: fireballs, grenades, arrows. Never reloads. */
export class Projectile implements WeaponDelivery {
  readonly abilities = PROJECTILE_ABILITIES;

  constructor(readonly config: ProjectileConfig) {}

  /** No projectile travels farther than speed times lifetime before it despawns. */
  get reach(): number {
    return Math.max(0, this.config.speed * (this.config.lifetimeSec ?? 5));
  }

  get windupSec(): number {
    return this.config.windupSec ?? 0;
  }

  buildFireConfig(shot: WeaponShot): ProjectileWeaponFireConfig {
    const {config} = this;
    return {
      origin: shot.aim.origin,
      direction: shot.aim.direction,
      refreshAim: (): Aim | null => shot.refreshAim(),
      template: config.template,
      speed: config.speed,
      lifetimeSec: config.lifetimeSec ?? 5,
      pelletCount: 1,
      spreadDeg: 0,
      burstCount: 1,
      burstIntervalSec: 0,
      windupSec: config.windupSec ?? 0,
      recoverySec: config.recoverySec ?? 0,
      targetFilter: shot.targetTag != null ? {required: [shot.targetTag]} : undefined,
      homingTarget: config.homeOnTarget === true ? shot.aimTarget : undefined,
      onHit: (target: Entity): void => shot.damage(target),
    };
  }

  validate(): string[] {
    const {config} = this;
    return [
      ...(config.speed > 0 ? [] : [`speed must be > 0, got ${String(config.speed)}`]),
      ...(config.lifetimeSec == null || config.lifetimeSec > 0 ? [] : [`lifetimeSec must be > 0, got ${String(config.lifetimeSec)}`]),
    ];
  }
}

export interface ThrowAreaConfig {
  /** Spawned where it lands, on the ground below: a template carrying `DeployableArea` (e.g. `Templates/Weapons/FireArea.hstf`). */
  template: TemplateAsset;
  /** Meters. */
  radius: number;
  /** Seconds before it goes out. */
  durationSec: number;
  /** Seconds between pulses; each pulse re-checks who is inside. Default 0.5. */
  intervalSec?: number;
  /** Applied to everyone inside on each pulse. Needs an `effectId`; registered with the item. */
  effect: GASEffectData;
}

export interface ThrowConfig {
  /** Thrown: a template carrying `GASDeployable` and a DynamicCollider `PhysicsBody` (e.g. `Templates/Weapons/Grenade.hstf`). */
  template: TemplateAsset;
  /** Launch speed in m/s. Default 12. */
  speed?: number;
  /** Degrees the throw is pitched above the aim, so a level aim still arcs. Default 15. */
  loftDeg?: number;
  /** Seconds after the throw it goes off wherever it is; 0 leaves only `detonateOnImpact`. Default 3. */
  fuseSec?: number;
  /** Goes off on the first thing it touches instead of bouncing (a molotov). Default false. */
  detonateOnImpact?: boolean;
  /** Seconds the spent deployable stays so its detonation can play. Default 2. */
  despawnDelaySec?: number;
  /** Meters; the weapon's `damage` to every target inside. 0 is no blast. Default 0. */
  blastRadius?: number;
  /** Cover blocks the blast. Default true. */
  blastNeedsLineOfSight?: boolean;
  /** The blast and the area also hit the thrower. Default false. */
  hurtsThrower?: boolean;
  /** How loud it goes off, for whatever listens on the server (NPC hearing); 0 is silent. The throw itself is silent. Default 1. */
  detonationLoudness?: number;
  /** A lingering area left where it lands (fire, gas). */
  area?: ThrowAreaConfig;
  /** Seconds before release; with `releaseEvent`, the latest release. Default 0. */
  windupSec?: number;
  /** Animation event the throw leaves on, e.g. `release` on the throw clip; `windupSec` must cover it. */
  releaseEvent?: string;
  /** Seconds the throw blocks re-entry after release. Default 0. */
  recoverySec?: number;
}

/** How far down from where it went off the ground is searched for an area. */
const GROUND_SEARCH_DISTANCE = 4;
/** Raises an area's sphere so it is not buried in the floor. */
const AREA_HEIGHT_OFFSET = 0.5;
const GRAVITY = 9.81;

/**
 * Item tag every `Throw` weapon carries, so a container can refuse them all.
 * `BaseActor`'s loadout does: NPCs do not throw yet, since a throw is to leave
 * the hand on an animation event and the server receives none.
 */
export const THROWN_WEAPON_TAG = 'weapon.thrown';

/**
 * Thrown deployables: grenades, molotovs. The thrown template arcs under physics
 * and goes off on a fuse or on impact; then a blast deals the weapon's damage
 * around it, and an area may linger on the ground below. Pair it with
 * `Expendable` so each throw spends one, and tag the item `THROWN_WEAPON_TAG`.
 */
export class Throw implements WeaponDelivery {
  readonly abilities = THROW_ABILITIES;

  constructor(readonly config: ThrowConfig) {}

  /** The farthest a throw lands on flat ground. */
  get reach(): number {
    const speed = this.config.speed ?? 12;
    return (speed * speed) / GRAVITY;
  }

  get windupSec(): number {
    return this.config.windupSec ?? 0;
  }

  /** The blast's or the area's radius, whichever reaches farther. */
  get splashRadius(): number {
    return Math.max(this.config.blastRadius ?? 0, this.config.area?.radius ?? 0);
  }

  get detonationLoudness(): number {
    return this.config.detonationLoudness ?? 1;
  }

  onRegistered(): void {
    if (this.config.area != null) {
      GASComponent.registerEffect(this.config.area.effect);
    }
  }

  buildFireConfig(shot: WeaponShot): ThrowWeaponFireConfig {
    const {config} = this;
    return {
      origin: shot.aim.origin,
      direction: shot.aim.direction,
      refreshAim: (): Aim | null => shot.refreshAim(),
      pelletCount: 1,
      spreadDeg: 0,
      burstCount: 1,
      burstIntervalSec: 0,
      windupSec: config.windupSec ?? 0,
      windupEndEvent: config.releaseEvent,
      recoverySec: config.recoverySec ?? 0,
      template: config.template,
      throwSpeed: config.speed ?? 12,
      loftDeg: config.loftDeg ?? 15,
      fuseSeconds: config.fuseSec ?? 3,
      resolveOnImpact: config.detonateOnImpact === true,
      despawnDelaySeconds: config.despawnDelaySec ?? 2,
      onResolve: (at: Vec3, _hit: Entity | null, self: Entity): void => this.goOff(shot, at, self),
    };
  }

  validate(): string[] {
    const {config} = this;
    const {area} = config;
    return [
      ...(config.speed == null || config.speed > 0 ? [] : [`speed must be > 0, got ${String(config.speed)}`]),
      ...((config.fuseSec ?? 3) > 0 || config.detonateOnImpact === true ? [] : ['needs a fuseSec > 0 or detonateOnImpact']),
      ...(area == null || area.effect.effectId !== '' ? [] : ['area.effect needs an effectId so a remote target can resolve it']),
      ...(area == null || area.radius > 0 ? [] : [`area.radius must be > 0, got ${String(area.radius)}`]),
      // An area with no duration never goes out.
      ...(area == null || area.durationSec > 0 ? [] : [`area.durationSec must be > 0, got ${String(area.durationSec)}`]),
      ...(area?.intervalSec == null || area.intervalSec > 0 ? [] : [`area.intervalSec must be > 0, got ${String(area.intervalSec)}`]),
      ...(config.releaseEvent == null || (config.windupSec ?? 0) > 0 ? [] : ['releaseEvent needs a windupSec > 0 to wait for it']),
      ...notNegative('detonationLoudness', config.detonationLoudness),
    ];
  }

  private goOff(shot: WeaponShot, at: Vec3, self: Entity): void {
    const {config} = this;
    if (this.detonationLoudness > 0) {
      shot.detonated?.(self);
    }
    const targetFilter = shot.targetTag != null ? {required: [shot.targetTag]} : undefined;
    const instigator = config.hurtsThrower === true ? undefined : shot.holder;
    if ((config.blastRadius ?? 0) > 0) {
      void applyBlast(
        {
          radius: config.blastRadius ?? 0,
          source: self,
          instigator,
          targetFilter,
          requireLineOfSight: config.blastNeedsLineOfSight !== false,
          onTarget: (hit: BlastHit): void => shot.damage(hit.gasEntity),
        },
        at,
      ).catch((error: unknown): void => {
        console.error('[Throw] blast failed:', error);
      });
    }
    const area = config.area;
    if (area != null) {
      void groundBelow(at, self)
        .then(ground =>
          spawnArea(area.template, ground.add(Vec3.up.mul(AREA_HEIGHT_OFFSET)), {
            radius: area.radius,
            durationSeconds: area.durationSec,
            intervalSeconds: area.intervalSec ?? 0.5,
            instigator,
            targetFilter,
            onPulse: (hit: BlastHit): void => {
              if (shot.mayAffect?.(hit.gasEntity) !== false) {
                applyEffect(shot.holder, hit.gasEntity, area.effect);
              }
            },
          }),
        )
        .catch((error: unknown): void => {
          console.error('[Throw] area failed to spawn:', error);
        });
    }
  }
}

/** The thrower's GAS applies `effect` to `target`'s; nothing once the thrower is gone. */
function applyEffect(holder: Entity, target: Entity, effect: GASEffectData): void {
  const sourceGas = holder.isDestroyed() ? null : holder.getComponent(GASComponent);
  const targetGas = target.getComponent(GASComponent);
  if (sourceGas != null && targetGas != null) {
    sourceGas.applyEffectToTarget(targetGas, effect);
  }
}

/**
 * The floor below `at`, so a molotov that breaks on a wall burns at its foot.
 * Characters are skipped: one hit on the head burns around its feet.
 */
async function groundBelow(at: Vec3, self: Entity): Promise<Vec3> {
  const result = await PhysicsService.get().rayCast({
    mode: CastMode.UnsortedHits,
    origin: at.add(Vec3.up.mul(0.1)),
    dir: Vec3.down,
    distance: GROUND_SEARCH_DISTANCE,
    collisionLayerMask: CollisionLayerMask.AllLayers,
    includeTriggers: false,
    excludeEntities: [self],
    maxUnsortedHits: 8,
  });
  const floor = (result.hits ?? [])
    .filter(hit => hit.actorEntity != null && !hit.actorEntity.isDestroyed() && resolveGasEntity(hit.actorEntity) == null)
    .sort((a, b) => a.distance - b.distance)[0];
  return floor?.position ?? at;
}
