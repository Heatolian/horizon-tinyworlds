/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {Vec3} from 'meta/worlds';

/** Link `areaType` the engine reserves for jumps (0=Walkable, 1=NotWalkable, 2=Jump). */
export const NAV_MESH_LINK_AREA_JUMP = 2;

/** m/s², matching `CharacterForceControllerBase.gravity`. */
export const LINK_JUMP_GRAVITY = 9.8;

/** Lowest apex above the higher endpoint (m), so even a short or level link reads as a hop. */
export const LINK_JUMP_MIN_CLEARANCE = 0.5;

/** Extra apex height per metre of horizontal span, so long jumps do not skim the gap. */
export const LINK_JUMP_CLEARANCE_PER_METRE = 0.25;

/**
 * A deterministic crossing from `start` to `end` over `duration` seconds. Horizontal motion is
 * linear in time; height is `start.y + verticalSpeed * t - gravity * t² / 2`, a ballistic arc
 * for a jump (gravity > 0) or a straight ramp for a walk (gravity 0).
 */
export interface NavMeshLinkTrajectory {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly duration: number;
  readonly verticalSpeed: number;
  readonly gravity: number;
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Apex height above the higher endpoint for a jump spanning `horizontal` metres. */
export function linkJumpClearance(horizontal: number): number {
  return Math.max(LINK_JUMP_MIN_CLEARANCE, LINK_JUMP_CLEARANCE_PER_METRE * horizontal);
}

/**
 * Plans a jump whose apex sits `linkJumpClearance` above the higher endpoint. The rise to the
 * apex and the fall from it each take `sqrt(2 * drop / g)`, so the arc reaches `end.y` exactly
 * at `duration`, and the horizontal speed is the span over that total time.
 */
export function planLinkJump(
  start: Vec3,
  end: Vec3,
  gravity: number = LINK_JUMP_GRAVITY,
): NavMeshLinkTrajectory {
  const g = Number.isFinite(gravity) && gravity > 0 ? gravity : LINK_JUMP_GRAVITY;
  const apex = Math.max(start.y, end.y) + linkJumpClearance(horizontalDistance(start, end));
  const riseTime = Math.sqrt((2 * (apex - start.y)) / g);
  const fallTime = Math.sqrt((2 * (apex - end.y)) / g);
  return {start, end, duration: riseTime + fallTime, verticalSpeed: g * riseTime, gravity: g};
}

/** Plans a straight crossing at `speed` m/s; a non-positive speed crosses at once. */
export function planLinkWalk(start: Vec3, end: Vec3, speed: number): NavMeshLinkTrajectory {
  const duration =
    Number.isFinite(speed) && speed > 0 ? end.sub(start).magnitude() / speed : 0;
  return {
    start,
    end,
    duration,
    verticalSpeed: duration > 0 ? (end.y - start.y) / duration : 0,
    gravity: 0,
  };
}

/** Position at `t` seconds; `start` before the crossing and exactly `end` from `duration` on. */
export function sampleLinkTrajectory(trajectory: NavMeshLinkTrajectory, t: number): Vec3 {
  const {start, end, duration} = trajectory;
  if (!(t < duration)) {
    return end;
  }
  if (!(t > 0)) {
    return start;
  }
  const u = t / duration;
  return new Vec3(
    start.x + (end.x - start.x) * u,
    start.y + trajectory.verticalSpeed * t - 0.5 * trajectory.gravity * t * t,
    start.z + (end.z - start.z) * u,
  );
}
