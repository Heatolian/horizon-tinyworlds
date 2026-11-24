/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {Vec3, type Entity} from 'meta/worlds';
import {horizontalDistance} from '../Utilities/ShooterComputations';
import {NoiseService, type Noise, type NoiseKind, type NoiseListener} from './NoiseService';
import {hearWeapons} from './WeaponNoise';

export type HeardKind = NoiseKind;

/** Who is listening, where, and whom it can hunt. */
export interface ListenArgs {
  self: Entity;
  selfPos: Vec3;
  /** The entity's tagged root when it is huntable, else null. */
  rootOf: (entity: Entity) => Entity | null;
  /** Heard from this root, a noise wins over fresher ones from others. */
  prefer: Entity | null;
}

/** What a sense heard this frame. */
export interface Heard {
  readonly kind: HeardKind;
  /** Where the noise is: the shooter, or where the charge went off. */
  readonly position: Vec3;
  /** The instigator's tagged root: the entity to hunt. */
  readonly instigatorRoot: Entity;
}

/** Where a sense hears noise from: `NoiseService`, unless replaced (tests). */
export interface NoiseSource {
  onNoise(listener: NoiseListener): () => void;
}

/** Head height (m) above the listener's root: where a passing round is heard. */
const EAR_HEIGHT = 1.0;

/** A ray, and how close (m) and how far along it (m) a point must be. */
export interface PassArgs {
  origin: Vec3;
  direction: Vec3;
  at: Vec3;
  radius: number;
  reach: number;
}

/**
 * True when the ray from `origin` along `direction` passes within `radius` of
 * `at` at a point ahead of the origin and within `reach` of it.
 */
export function passesWithin({origin, direction, at, radius, reach}: PassArgs): boolean {
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (len < 1e-6) {
    return false;
  }
  const wx = at.x - origin.x;
  const wy = at.y - origin.y;
  const wz = at.z - origin.z;
  const along = (wx * direction.x + wy * direction.y + wz * direction.z) / len;
  if (along <= 0 || along > reach) {
    return false;
  }
  return wx * wx + wy * wy + wz * wz - along * along <= radius * radius;
}

/**
 * The hearing sense: gunfire and explosions the observer cannot see. Flat
 * per-kind radii (no propagation or occlusion), plus a near-miss test so a
 * shot that passes close is heard from any distance. Heard noises become
 * knowledge, never sight: the caller records them in PerceptionMemory.
 *
 * Push-based: from its first poll the sense subscribes to its source and keeps
 * what is reported until the next poll, which judges each noise once, against
 * whom the caller hunts then. Hears only instigators the caller can hunt
 * (`rootOf` returns their tagged root), and never itself. What is loud is the
 * weapon's to say (its delivery's `loudness`): by default gun rounds and
 * detonations; a sword swing, a projectile or the throw itself is silent.
 */
export class HearingSense {
  /** Off: noises are skipped, and none is replayed when turned back on. */
  enabled: boolean = true;
  /** Scales every radius. */
  rangeScale: number = 1;
  /** Heard within this distance (m) of a shooter. */
  gunshotRadius: number = 30;
  /** Heard within this distance (m) of a detonation. */
  explosionRadius: number = 60;
  /** A shot whose path passes within this distance (m) of the head is heard from any range. */
  nearMissRadius: number = 3;
  /** Farthest along the path (m) a near miss counts. */
  nearMissReach: number = 100;
  /** Where noise comes from; `NoiseService`, with weapons wired in, when null. Set before the first poll. */
  source: NoiseSource | null = null;

  private pending: Noise[] = [];
  /** The buffer the last poll judged, emptied and swapped back in by the next, so polling allocates nothing. */
  private judging: Noise[] = [];
  private unsubscribe: (() => void) | null = null;

  /** Drops what was reported since the last poll; listening goes on. */
  reset(): void {
    this.pending.length = 0;
  }

  /** Stops listening and drops what was not heard yet; the next poll starts again. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending.length = 0;
  }

  /**
   * Takes every noise reported since the last poll and returns the one to act
   * on: the freshest heard from `prefer`, else the freshest heard at all, else
   * null. The first poll only starts listening: nothing reported before it is
   * heard.
   */
  poll(args: ListenArgs): Heard | null {
    if (this.unsubscribe == null) {
      this.listen(args.self);
      return null;
    }
    // Noises reported while judging go to the other buffer.
    const noises = this.pending;
    this.pending = this.judging;
    this.judging = noises;
    let freshest: Heard | null = null;
    let preferred: Heard | null = null;
    if (this.enabled) {
      for (const noise of noises) {
        const heard = this.judge(noise, args);
        if (heard) {
          freshest = heard;
          if (heard.instigatorRoot === args.prefer) {
            preferred = heard;
          }
        }
      }
    }
    noises.length = 0;
    return preferred ?? freshest;
  }

  /** Whether `noise` is loud enough at `at`, ignoring who made it. */
  audible(noise: Noise, at: Vec3): boolean {
    const scale = Math.max(0, this.rangeScale);
    const radius = (noise.kind === 'explosion' ? this.explosionRadius : this.gunshotRadius) * scale * Math.max(0, noise.loudness ?? 1);
    if (horizontalDistance(at, noise.position) <= radius) {
      return true;
    }
    const ray = noise.ray;
    return (
      noise.kind === 'gunshot' &&
      ray != null &&
      passesWithin({
        origin: ray.origin,
        direction: ray.direction,
        at: new Vec3(at.x, at.y + EAR_HEIGHT, at.z),
        radius: this.nearMissRadius * scale,
        reach: this.nearMissReach,
      })
    );
  }

  private listen(owner: Entity): void {
    if (this.source == null) {
      hearWeapons();
    }
    this.unsubscribe = (this.source ?? NoiseService.get()).onNoise(noise => {
      // Destroying an actor does not remove its behaviors, so its sense stops here.
      if (owner.isDestroyed()) {
        this.stop();
        return;
      }
      this.pending.push(noise);
    });
  }

  private judge(noise: Noise, {self, selfPos, rootOf}: ListenArgs): Heard | null {
    if (noise.instigator.isDestroyed()) {
      return null;
    }
    const root = rootOf(noise.instigator);
    if (root == null || root === self) {
      return null;
    }
    if (!this.audible(noise, selfPos)) {
      return null;
    }
    return {kind: noise.kind, position: noise.position, instigatorRoot: root};
  }
}
