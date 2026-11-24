/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {CameraService, TransformComponent, Vec3, type Entity} from 'meta/worlds';

/** The ray a weapon fires along this shot. */
export interface Aim {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Produces the ray a weapon fires along — crosshair, muzzle, auto-target, cursor.
 * Resolved on the shooting client, so drive firing owner-only.
 */
export interface AimProvider {
  getAim(owner: Entity): Aim | null;
}

/** Aims from the camera along its optical axis — the screen-center crosshair. */
export class CameraAimProvider implements AimProvider {
  getAim(_owner: Entity): Aim | null {
    const cam = CameraService.get();
    return {origin: cam.position, direction: cam.forward};
  }
}

/** Muzzle offset in the owner's local frame: x = right, y = up, z = forward. */
export const DEFAULT_MUZZLE_OFFSET: Vec3 = new Vec3(0, 1.0, 0.33);

/**
 * Aims along the owner's facing from a muzzle offset off its pivot, so the ray
 * clears the owner's own body. For turrets, top-down shooters, and NPCs.
 */
export class ForwardAimProvider implements AimProvider {
  constructor(private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET) {}

  getAim(owner: Entity): Aim | null {
    const t = owner.getComponent(TransformComponent);
    if (!t) {
      return null;
    }
    const origin = t.worldPosition
      .add(t.worldRight.mul(this.muzzleOffset.x))
      .add(t.worldUp.mul(this.muzzleOffset.y))
      .add(t.worldForward.mul(this.muzzleOffset.z));
    return {origin, direction: t.worldForward};
  }
}

/**
 * Aims along the camera's optical axis but from a muzzle offset off the owner's
 * pivot, so the shot leaves the body while still going where the player looks.
 */
export class MuzzleAimProvider implements AimProvider {
  constructor(private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET) {}

  getAim(owner: Entity): Aim | null {
    const t = owner.getComponent(TransformComponent);
    if (!t) {
      return null;
    }
    const origin = t.worldPosition
      .add(t.worldRight.mul(this.muzzleOffset.x))
      .add(t.worldUp.mul(this.muzzleOffset.y))
      .add(t.worldForward.mul(this.muzzleOffset.z));
    return {origin, direction: CameraService.get().forward};
  }
}

/** Least horizontal distance from the owner's pivot a shot from the hand starts at, clear of its capsule. */
export const HAND_CLEARANCE_M = 0.5;

/** Below this horizontal length an aim is straight up or down and has no heading of its own. */
const MIN_HEADING = 0.01;

/**
 * `hand`, moved along the horizontal of `direction` until it is `clearance`
 * from `pivot` horizontally, if it is closer; otherwise `hand` itself.
 */
export function clearOfBody(hand: Vec3, pivot: Vec3, direction: Vec3, clearance: number = HAND_CLEARANCE_M): Vec3 {
  const offset = new Vec3(hand.x - pivot.x, 0, hand.z - pivot.z);
  const flat = new Vec3(direction.x, 0, direction.z);
  if (offset.magnitude() >= clearance || flat.magnitude() < MIN_HEADING) {
    return hand;
  }
  const along = flat.normalize();
  // The s >= 0 with |offset + along * s| = clearance.
  const dot = offset.x * along.x + offset.z * along.z;
  const s = -dot + Math.sqrt(dot * dot - offset.magnitude() ** 2 + clearance * clearance);
  return hand.add(along.mul(s));
}

/**
 * Aims along the camera's optical axis from the owner's hand socket, so a throw
 * leaves where the hand lets go. The socket follows the animation on the
 * machine that plays it. A hand too close to the owner's pivot is moved out
 * along the aim ({@link clearOfBody}), or along the owner's facing for an aim
 * straight up or down, so the shot clears the owner's capsule; with no socket
 * the shot leaves from the muzzle offset instead.
 */
export class HandAimProvider implements AimProvider {
  constructor(
    private readonly socketName: string,
    private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET,
  ) {}

  getAim(owner: Entity): Aim | null {
    const socket =
      owner.findChildrenWithName(this.socketName, true)[0] ??
      owner.findChildrenWithName(`${this.socketName}_Socket`, true)[0] ??
      null;
    const hand = socket?.getComponent(TransformComponent)?.worldPosition ?? null;
    const body = owner.getComponent(TransformComponent);
    if (hand == null || body == null) {
      return new MuzzleAimProvider(this.muzzleOffset).getAim(owner);
    }
    const direction = CameraService.get().forward;
    const heading = Math.hypot(direction.x, direction.z) >= MIN_HEADING ? direction : body.worldForward;
    return {origin: clearOfBody(hand, body.worldPosition, heading), direction};
  }
}

/** Legal `aimSource` values, for warnings and editor descriptions. */
export const AIM_SOURCES: readonly string[] = ['camera', 'forward', 'muzzle', 'hand'];

/**
 * Build the provider named by `source`; the muzzle offset applies to 'forward'
 * and 'muzzle', and to 'hand' when `handSocket` is missing. The editor has no
 * enum property, so an unknown value warns and falls back rather than silently
 * aiming the wrong way.
 */
export function createAimProvider(source: string, muzzleOffset: Vec3, handSocket: string = 'RightHand'): AimProvider {
  if (source === 'forward') {
    return new ForwardAimProvider(muzzleOffset);
  }
  if (source === 'muzzle') {
    return new MuzzleAimProvider(muzzleOffset);
  }
  if (source === 'hand') {
    return new HandAimProvider(handSocket, muzzleOffset);
  }
  if (source !== 'camera') {
    console.warn(
      `[Weapon] unknown aimSource '${source}'; expected ${AIM_SOURCES.join(' or ')}. Using 'camera'.`,
    );
  }
  return new CameraAimProvider();
}
