/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v13

import {ColliderBoxComponent, ColliderCapsuleComponent, ColliderSphereComponent, TransformComponent} from 'meta/worlds';
import type {AbstractClass, Component, Entity, Vec3} from 'meta/worlds';

/**
 * Context handed to a motion strategy each frame. Most motions only need the
 * transform/speed; target-seeking motions (e.g. homing) also read `target`,
 * the entity they steer at (see {@link homingAimOf}).
 */
export interface MotionContext {
  transform: TransformComponent;
  deltaTime: number;
  speed: number;
  target?: Entity;
}

/**
 * A motion strategy returns the projectile's next world position. Games pick a
 * strategy (or pass their own). Keep this palette driven by real needs — add
 * arc / wave / boomerang here only when a game actually requires them.
 */
export type MotionStep = (ctx: MotionContext) => Vec3;

/** Travels straight along the projectile's own forward direction. */
export const straightForward: MotionStep = (ctx) =>
  ctx.transform.worldPosition.add(ctx.transform.worldForward.mul(ctx.speed * ctx.deltaTime));

/**
 * Seeks `ctx.target`, steering toward its current position each frame (does not
 * overshoot on the arrival frame). Falls back to straight flight if the target
 * is gone. The hit itself is handled by the sweep, same as any motion.
 * Homing moves the projectile without turning it, so that fallback resumes the
 * launch heading: a target destroyed mid-flight leaves a sharp corner in the path.
 */
export const homing: MotionStep = (ctx) => {
  const target = ctx.target;
  if (target && !target.isDestroyed()) {
    const targetTransform = target.getComponent(TransformComponent);
    if (targetTransform) {
      const toTarget = targetTransform.worldPosition.sub(ctx.transform.worldPosition);
      const stepLen = ctx.speed * ctx.deltaTime;
      if (toTarget.magnitude() <= stepLen) {
        return targetTransform.worldPosition; // reach exactly, no overshoot
      }
      return ctx.transform.worldPosition.add(toTarget.normalize().mul(stepLen));
    }
  }
  return straightForward(ctx); // target gone -> fly straight
};

/**
 * The entity homing should steer at: the target's body collider (capsule, then
 * sphere, then box; its own or its first descendant's), else the target itself.
 * A collider is centered on its entity, while a character's root sits at its
 * feet, so steering at the root dives every arrival into the ground. Resolved
 * once per shot, not per frame.
 */
export function homingAimOf(target: Entity): Entity {
  return (
    colliderHolder(target, ColliderCapsuleComponent) ??
    colliderHolder(target, ColliderSphereComponent) ??
    colliderHolder(target, ColliderBoxComponent) ??
    target
  );
}

function colliderHolder<T extends Component>(target: Entity, cls: AbstractClass<T>): Entity | null {
  if (target.getComponent(cls)) {
    return target;
  }
  return target.getChildrenWithComponent(cls, true)[0] ?? null;
}
