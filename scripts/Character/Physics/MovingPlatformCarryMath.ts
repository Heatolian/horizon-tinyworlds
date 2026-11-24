/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v17

/**
 * Pure ride math for `MovingPlatformRideComponent` and the remote
 * deck-relative follow in `CharacterAnimationController`.
 *
 * Scalar helpers with no `meta/worlds` imports on purpose: hermetic and
 * identical on every endpoint.
 */

// Default speed bound for the deck-relative teleport guard (m/s). The ride
// exposes it as an inspector prop; remotes (which run no ride) use this.
export const DEFAULT_MAX_DECK_SPEED_METERS_PER_SECOND = 10.0;
// Default grace for mounts whose mover entry is missing (unregistered
// mid-ride by a destroy/recreate race). Movers normally register their own.
export const DEFAULT_GRACE_PERIOD_SECONDS = 0.5;
// Teleport-guard slack for deck-relative tracking: a single-frame relative
// jump larger than this + scaled expected motion is a rider teleport, not
// travel — detach instead of publishing. The speed bound mirrors the ride's
// deck-speed clamp (unbounded mounts assume 15 m/s); at defaults the
// threshold passes a 10 m/s deck with ~5.6x headroom at 72 Hz (0.78 m vs
// 0.14 m/frame) and still passes it across a 0.25 s hitch frame.
export const DECK_TELEPORT_SLACK_METERS = 0.5;
export const DECK_UNCLAMPED_SPEED_BOUND = 15;

/**
 * Single-frame relative travel above which a deck-relative delta is a rider
 * teleport, not motion: detach instead of publishing. Deck teleports never
 * trip the guard — the hierarchy preserves the relative position across them
 * by construction, so only the rider's own snap jumps the relative frame.
 */
export function deckTeleportThresholdMeters(
  maxDeckSpeedMetersPerSecond: number,
  dtSeconds: number,
): number {
  const speedBound =
    maxDeckSpeedMetersPerSecond > 0
      ? maxDeckSpeedMetersPerSecond
      : DECK_UNCLAMPED_SPEED_BOUND;
  return DECK_TELEPORT_SLACK_METERS + speedBound * dtSeconds * 2;
}

// Per-frame translation above which unregistered ground counts as moving:
// well above float noise on a still transform, well below one frame of the
// slowest platform worth riding (0.1 m/s at 60 Hz is 1.7 mm).
export const MOTION_EPSILON_METERS = 0.0005;
// Per-frame rotation above which it counts as moving (~0.03 deg; a 6 deg/s
// spinner turns 0.1 deg per 60 Hz frame).
export const ROTATION_EPSILON_RADIANS = 0.0005;

type XYZ = {readonly x: number; readonly y: number; readonly z: number};
type XYZW = XYZ & {readonly w: number};

/**
 * Whether a pose changed between two frames: translated more than
 * `MOTION_EPSILON_METERS` or rotated more than `ROTATION_EPSILON_RADIANS`.
 * The angle comes from the vector part of the relative rotation,
 * |vec(conj(a) * b)| / (|a| |b|) = sin(angle / 2): well conditioned for small
 * angles (a dot product near 1 is not) and immune to non-unit engine
 * quaternions and to the q / -q sign ambiguity.
 */
export function poseChanged(
  previousPosition: XYZ,
  position: XYZ,
  previousRotation: XYZW,
  rotation: XYZW,
): boolean {
  const dx = position.x - previousPosition.x;
  const dy = position.y - previousPosition.y;
  const dz = position.z - previousPosition.z;
  if (dx * dx + dy * dy + dz * dz > MOTION_EPSILON_METERS * MOTION_EPSILON_METERS) {
    return true;
  }
  const a = previousRotation;
  const b = rotation;
  // vec(conj(a) * b) = a.w * b.v - b.w * a.v - a.v x b.v
  const vx = a.w * b.x - b.w * a.x - (a.y * b.z - a.z * b.y);
  const vy = a.w * b.y - b.w * a.y - (a.z * b.x - a.x * b.z);
  const vz = a.w * b.z - b.w * a.z - (a.x * b.y - a.y * b.x);
  const normA = Math.hypot(a.x, a.y, a.z, a.w);
  const normB = Math.hypot(b.x, b.y, b.z, b.w);
  if (normA === 0 || normB === 0) {
    return false;
  }
  const sinHalf = Math.hypot(vx, vy, vz) / (normA * normB);
  return sinHalf > Math.sin(ROTATION_EPSILON_RADIANS / 2);
}

type MutableXYZ = {x: number; y: number; z: number};

/** `v` rotated by `q` (normalized first, so a slightly non-unit engine
 * rotation does not scale the result). */
export function rotateVector(q: XYZW, v: XYZ): MutableXYZ {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const x = q.x / n;
  const y = q.y / n;
  const z = q.z / n;
  const w = q.w / n;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** The rider's seat in a deck pose: the rider's offset from the deck, in the
 * deck's own (rotation) frame. */
export function seatInDeck(
  deckPosition: XYZ,
  deckRotation: XYZW,
  rider: XYZ,
): MutableXYZ {
  const inverse = {x: -deckRotation.x, y: -deckRotation.y, z: -deckRotation.z, w: deckRotation.w};
  return rotateVector(inverse, {
    x: rider.x - deckPosition.x,
    y: rider.y - deckPosition.y,
    z: rider.z - deckPosition.z,
  });
}

/** World position of a seat in a deck pose (inverse of `seatInDeck`). */
export function seatToWorld(
  deckPosition: XYZ,
  deckRotation: XYZW,
  seat: XYZ,
): MutableXYZ {
  const offset = rotateVector(deckRotation, seat);
  return {
    x: deckPosition.x + offset.x,
    y: deckPosition.y + offset.y,
    z: deckPosition.z + offset.z,
  };
}

/** conj(a) * b: rotation `b` expressed in rotation `a`'s frame. */
export function conjugateMultiply(a: XYZW, b: XYZW): XYZW {
  const x = -a.x;
  const y = -a.y;
  const z = -a.z;
  const w = a.w;
  return {
    x: w * b.x + x * b.w + y * b.z - z * b.y,
    y: w * b.y - x * b.z + y * b.w + z * b.x,
    z: w * b.z + x * b.y - y * b.x + z * b.w,
    w: w * b.w - x * b.x - y * b.y - z * b.z,
  };
}

/** A child pose expressed in a base pose's frame (offset and rotation). */
export function relativePose(
  basePosition: XYZ,
  baseRotation: XYZW,
  position: XYZ,
  rotation: XYZW,
): {position: MutableXYZ; rotation: XYZW} {
  return {
    position: seatInDeck(basePosition, baseRotation, position),
    rotation: conjugateMultiply(baseRotation, rotation),
  };
}

/**
 * How far a body turned about world up between two orientations, in radians
 * in (-pi, pi]: the twist of the world-frame delta current * conj(previous)
 * about the up axis. A tilt with no turn (a rocking boat) yields 0.
 */
export function yawDeltaRadians(previous: XYZW, current: XYZW): number {
  // delta = current * conj(previous); only its y and w enter the twist.
  const px = -previous.x;
  const py = -previous.y;
  const pz = -previous.z;
  const pw = previous.w;
  const c = current;
  const dy = c.w * py - c.x * pz + c.y * pw + c.z * px;
  const dw = c.w * pw - c.x * px - c.y * py - c.z * pz;
  if (Math.abs(dy) < 1e-12 && Math.abs(dw) < 1e-12) {
    return 0;
  }
  let angle = 2 * Math.atan2(dy, dw);
  if (angle > Math.PI) {
    angle -= 2 * Math.PI;
  } else if (angle <= -Math.PI) {
    angle += 2 * Math.PI;
  }
  return angle;
}

/**
 * A step measured in a parent's local frame (a change of the child's local
 * position) in world axes: scaled by the parent's world scale, then turned by
 * its world rotation.
 */
export function parentStepToWorld(
  parentRotation: XYZW,
  parentScale: XYZ,
  localStep: XYZ,
): MutableXYZ {
  return rotateVector(parentRotation, {
    x: localStep.x * parentScale.x,
    y: localStep.y * parentScale.y,
    z: localStep.z * parentScale.z,
  });
}

// Most shear a parent link may give its rider (how far two of its axes that
// should be square lean together, as the cosine of the angle between them):
// about 3 degrees when it mounts, below what reads on a character, and twice
// that while it rides before the ride hands it to the carry. The band keeps a
// deck authored a fraction of a degree off level, or wobbling slightly, from
// unparenting its rider (other players would see it walk in place).
export const MAX_RIDER_SHEAR = 0.05;
export const MAX_RIDER_SHEAR_WHILE_RIDING = 0.1;

const UP: XYZ = {x: 0, y: 1, z: 0};

/**
 * How much a rider parented under a platform root with this world scale and
 * rotation shears (see `MAX_RIDER_SHEAR`; infinite under a mirrored axis).
 * The rider stays upright and turns about world up, which in the root's
 * frame is the axis `u`; its turn composes with the root's scale S without
 * shear when `u` is an axis of S and S is even across the plane square to
 * `u` (the deck's floor). With M = S², the shear is the larger of how uneven
 * the floor is (its two stretches differ by sqrt(T² − 4D) / T, T and D the
 * trace and determinant of M across the floor) and how much up couples to the
 * floor (|Mu − (u·Mu)u| over the geometric mean of the up and mean floor
 * stretches). Upright, that is |z² − x²| / (z² + x²); a root scaled s across
 * its floor and y along up, tilting slightly, shears about |s/y − y/s| ·
 * sin(tilt). A uniform scale never shears, nor does a turned root whose
 * floor is even (a Z-up deck turned upright). Two negative axes are a half
 * turn, not a mirror; one or three mirror the rider.
 */
export function riderShear(scale: XYZ, rotation: XYZW): number {
  if (!(scale.x * scale.y * scale.z > 0)) {
    return Infinity;
  }
  const u = rotateVector({x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w}, UP);
  const mx = scale.x * scale.x;
  const my = scale.y * scale.y;
  const mz = scale.z * scale.z;
  const upStretch = mx * u.x * u.x + my * u.y * u.y + mz * u.z * u.z;
  const floorTrace = mx + my + mz - upStretch;
  const floorDet = u.x * u.x * my * mz + u.y * u.y * mx * mz + u.z * u.z * mx * my;
  const uneven = Math.sqrt(Math.max(0, floorTrace * floorTrace - 4 * floorDet)) / floorTrace;
  const coupling =
    Math.hypot(
      (mx - upStretch) * u.x,
      (my - upStretch) * u.y,
      (mz - upStretch) * u.z,
    ) / Math.sqrt((upStretch * floorTrace) / 2);
  return Math.max(uneven, coupling);
}

/** Whether a parent link keeps its rider within `maxShear` (see `riderShear`). */
export function parentKeepsRiderUndistorted(
  scale: XYZ,
  rotation: XYZW,
  maxShear: number = MAX_RIDER_SHEAR,
): boolean {
  return riderShear(scale, rotation) <= maxShear;
}

/** Degrees a rotation turns world up off vertical. */
export function tiltDegrees(rotation: XYZW): number {
  const up = rotateVector(rotation, UP);
  return (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
}

/** A rotation's up vector (world up turned by it). */
export function upOf(rotation: XYZW): MutableXYZ {
  return rotateVector(rotation, UP);
}

/**
 * `rotation` turned by the shortest arc that takes its up vector onto `up`,
 * keeping its heading; `rotation` itself when they already agree (or point
 * opposite ways, which no arc settles).
 */
export function withUp(rotation: XYZW, up: XYZ): XYZW {
  const a = upOf(rotation);
  const n = Math.hypot(up.x, up.y, up.z) || 1;
  const b = {x: up.x / n, y: up.y / n, z: up.z / n};
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  if (dot >= 1 - UP_MATCH_SLACK || dot <= -1 + UP_MATCH_SLACK) {
    return rotation;
  }
  const swing = {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
    w: 1 + dot,
  };
  const sn = Math.hypot(swing.x, swing.y, swing.z, swing.w);
  const q = {x: swing.x / sn, y: swing.y / sn, z: swing.z / sn, w: swing.w / sn};
  return {
    x: q.w * rotation.x + q.x * rotation.w + q.y * rotation.z - q.z * rotation.y,
    y: q.w * rotation.y - q.x * rotation.z + q.y * rotation.w + q.z * rotation.x,
    z: q.w * rotation.z + q.x * rotation.y - q.y * rotation.x + q.z * rotation.w,
    w: q.w * rotation.w - q.x * rotation.x - q.y * rotation.y - q.z * rotation.z,
  };
}

// Up vectors closer than this (1 - cosine, about 0.01 degrees) already agree.
const UP_MATCH_SLACK = 1e-8;
