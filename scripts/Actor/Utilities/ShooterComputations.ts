/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v34

import {Vec3} from 'meta/worlds';

/** Returns a number in [0, 1). Injected so tests can pin every random choice. */
export type RandomSource = () => number;

/** Ceiling (deg) on the vertical-speed contribution: a finite-difference velocity spike (teleport, respawn) widens the cone, never inverts it. */
const MAX_VERTICAL_AIM_ERROR_DEG = 15;

/** Inputs to {@link computeAimErrorDeg}. */
export interface AimErrorModel {
  /** Cone half-angle (deg) on first sight. */
  maxAimErrorDeg: number;
  /** Cone half-angle (deg) once fully settled on a still target. */
  minAimErrorDeg: number;
  /** Time constant (s) of the settle from max to min while the target stays visible. */
  aimSettleSeconds: number;
  /** Extra half-angle (deg) per m/s of target speed across the line of fire. */
  aimErrorPerTargetSpeedDeg: number;
  /**
   * Extra half-angle (deg) per m/s of target vertical speed. Crossing speed is
   * measured on the ground plane, so a jumping target reads as easy to hit
   * without this; vertical motion is screen-space motion too.
   */
  aimErrorPerVerticalSpeedDeg: number;
  /** Extra half-angle (deg) while the shooter itself is moving. */
  movingAimPenaltyDeg: number;
}

/** The shot being taken, for {@link computeAimErrorDeg}. */
export interface AimErrorShot {
  /** Seconds the target has been continuously visible. */
  visibleSeconds: number;
  /** Shooter-to-target vector. */
  shooterToTarget: Vec3;
  /** Target velocity (m/s), or null when unknown. */
  targetVelocity: Vec3 | null;
  /** Whether the shooter is moving. */
  shooterMoving: boolean;
}

/**
 * Deliberate aim error for a bot: wide on first sight, settling toward
 * `minAimErrorDeg` the longer the target stays visible, and widened by the
 * target's crossing speed, its vertical speed, and by the shooter's own
 * movement. A target that keeps breaking line of sight, strafing, or jumping
 * is therefore harder to hit.
 */
export function computeAimErrorDeg(model: AimErrorModel, shot: AimErrorShot): number {
  const {visibleSeconds, shooterToTarget, targetVelocity, shooterMoving} = shot;
  const settle =
    model.aimSettleSeconds > 0 ? Math.exp(-Math.max(0, visibleSeconds) / model.aimSettleSeconds) : 0;
  const lo = Math.max(0, Math.min(model.minAimErrorDeg, model.maxAimErrorDeg));
  const hi = Math.max(lo, model.maxAimErrorDeg);
  let error = lo + (hi - lo) * settle;

  if (targetVelocity) {
    error += crossingSpeed(shooterToTarget, targetVelocity) * Math.max(0, model.aimErrorPerTargetSpeedDeg);
    // Only the part of vertical motion perpendicular to the line of fire
    // matters: a target rising straight toward the muzzle is not harder to
    // hit. Scales by the horizontal share of the line, matching the ground
    // plane the crossing term is measured on.
    const lineLen = shooterToTarget.magnitude();
    const horizontalLen = Math.sqrt(
      shooterToTarget.x * shooterToTarget.x + shooterToTarget.z * shooterToTarget.z,
    );
    const horizontalShare = lineLen > 1e-4 ? horizontalLen / lineLen : 1;
    const vertical =
      Math.abs(targetVelocity.y) * horizontalShare * Math.max(0, model.aimErrorPerVerticalSpeedDeg);
    error += Math.min(vertical, MAX_VERTICAL_AIM_ERROR_DEG);
  }
  if (shooterMoving) {
    error += Math.max(0, model.movingAimPenaltyDeg);
  }
  return error;
}

/** Horizontal speed of `velocity` perpendicular to `lineOfFire`. */
export function crossingSpeed(lineOfFire: Vec3, velocity: Vec3): number {
  const lx = lineOfFire.x;
  const lz = lineOfFire.z;
  const len = Math.sqrt(lx * lx + lz * lz);
  if (len < 1e-4) {
    return Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  }
  // |l x v| / |l| on the ground plane.
  return Math.abs(lx * velocity.z - lz * velocity.x) / len;
}

/** Inputs to {@link computeStrafePoint}. */
export interface RangeBand {
  /** Closer than this (m, centre to centre) the shooter backs off. */
  minRange: number;
  /** Distance (m) the shooter drifts toward while inside the band. */
  preferredRange: number;
  /** Farther than this (m) the shooter closes in. */
  maxRange: number;
  /** Sideways step (m) per reposition. */
  strafeDistance: number;
}

/** Inputs to {@link computeStrafePoint}. */
export interface StrafeRequest {
  self: Vec3;
  target: Vec3;
  band: RangeBand;
  /** +1 or -1: which side of the target line to step to. */
  side: number;
  random: RandomSource;
}

/**
 * The next point a shooter moves to while it can see its target: a sideways
 * step of `strafeDistance` along the arc around the target on side `side` (+1
 * or -1), at a radius pulled back into the range band — straight to
 * `preferredRange` from outside the band, halfway toward it plus up to 1 m of
 * jitter from inside. The point is exactly that radius from the target. Y is
 * the shooter's.
 */
export function computeStrafePoint(request: StrafeRequest): Vec3 {
  const {self, target, band, side, random} = request;
  const dx = self.x - target.x;
  const dz = self.z - target.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const rx = distance > 0.01 ? dx / distance : 1;
  const rz = distance > 0.01 ? dz / distance : 0;

  // A preferred range authored outside the band is pulled into it, so no
  // branch lands past maxRange.
  const preferred = Math.min(band.maxRange, Math.max(band.minRange, band.preferredRange));
  let radius: number;
  if (distance > band.maxRange || distance < band.minRange) {
    radius = preferred;
  } else {
    radius = distance + (preferred - distance) * 0.5 + (random() * 2 - 1);
    radius = Math.min(band.maxRange, Math.max(band.minRange, radius));
  }

  // Step sideways along the arc of `radius`, so the point stays exactly that far
  // from the target: a straight tangent step would land at hypot(radius, step),
  // past maxRange at the outer edge of the band.
  const angle = (Math.sign(side || 1) * band.strafeDistance) / Math.max(radius, 0.01);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ux = rx * cos - rz * sin;
  const uz = rx * sin + rz * cos;
  return new Vec3(target.x + ux * radius, self.y, target.z + uz * radius);
}

/** Ring radii, as fractions of the search radius, that cover candidates are sampled on. */
const COVER_RING_FRACTIONS: readonly number[] = [0.35, 0.65, 1.0];
const COVER_DIRECTIONS = 12;

/**
 * Candidate positions to test for cover, nearest first, sampled on three rings
 * around `self`. With `awayFromThreat` (retreating), only candidates on the far
 * side of the shooter from the threat are kept (the step from `self` points
 * away from the threat), so a retreat never runs toward or past the threat. A
 * threat on top of the shooter keeps every candidate. Y is the shooter's.
 */
export function generateCoverCandidates(
  self: Vec3,
  threat: Vec3,
  searchRadius: number,
  awayFromThreat: boolean,
): Vec3[] {
  const candidates: Vec3[] = [];
  if (searchRadius <= 0) {
    return candidates;
  }
  const towardX = threat.x - self.x;
  const towardZ = threat.z - self.z;
  // A threat on top of the shooter gives no direction to retreat away from.
  const away = awayFromThreat && towardX * towardX + towardZ * towardZ > 1e-6;
  for (const fraction of COVER_RING_FRACTIONS) {
    const radius = searchRadius * fraction;
    for (let i = 0; i < COVER_DIRECTIONS; i++) {
      const angle = (i / COVER_DIRECTIONS) * Math.PI * 2;
      const candidate = new Vec3(
        self.x + Math.cos(angle) * radius,
        self.y,
        self.z + Math.sin(angle) * radius,
      );
      const stepTowardThreat = (candidate.x - self.x) * towardX + (candidate.z - self.z) * towardZ;
      if (away && stepTowardThreat >= 0) {
        continue;
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * A point on the threat-to-self line, `distance` metres from `threat` but never
 * closer to it than `self` already is, for a retreat that found no cover. Y is
 * the shooter's.
 */
export function computeFleePoint(self: Vec3, threat: Vec3, distance: number): Vec3 {
  const dx = self.x - threat.x;
  const dz = self.z - threat.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ux = len > 0.01 ? dx / len : 1;
  const uz = len > 0.01 ? dz / len : 0;
  const reach = Math.max(distance, len);
  return new Vec3(threat.x + ux * reach, self.y, threat.z + uz * reach);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
