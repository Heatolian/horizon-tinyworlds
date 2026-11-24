/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {
  NetworkMode,
  PhysicsBodyComponent,
  Quaternion,
  WorldService,
  type AbstractClass,
  type Component,
  type Entity,
  type Maybe,
  type TemplateAsset,
  type Vec3,
} from 'meta/worlds';
import {GASDeployable} from './GASDeployable';

/** What one throw launches, and what the thing does once it goes off. */
export interface ThrowConfig {
  /** The deployable. Needs `GASDeployable` and a DynamicCollider `PhysicsBody`. */
  template: Maybe<TemplateAsset>;

  /** Whoever threw it; never counts as an impact. */
  instigator: Entity;

  /** Where it leaves the hand. */
  origin: Vec3;

  /** Which way it goes. Need not be normalized. */
  direction: Vec3;

  /** Launch speed in m/s. Gravity and bounce are the engine's from there. */
  throwSpeed: number;

  /** Seconds before it goes off in place. 0 leaves impact as the only trigger. */
  fuseSeconds: number;

  /** Go off on the first collision instead of bouncing. */
  resolveOnImpact: boolean;

  /** Seconds between going off and despawning, so the detonation can play. */
  despawnDelaySeconds: number;

  /** What it does when it goes off; `hit` is null when the fuse set it off in mid-air. */
  onResolve(at: Vec3, hit: Entity | null, self: Entity): void;
}

/**
 * Spawn a deployable, arm it, and hand it to physics.
 *
 * A free function so anything can deploy without a weapon: a trap dropping a
 * mine, a script planting a charge.
 */
export async function throwDeployable(config: ThrowConfig): Promise<void> {
  const template = config.template;
  if (!template) {
    return;
  }
  const direction = config.direction.normalize();
  const entity = await WorldService.get().spawnTemplate({
    templateAsset: template,
    networkMode: NetworkMode.Networked,
    position: config.origin,
    rotation: Quaternion.lookRotation(direction),
  });

  const deployable = findInTemplate(entity, GASDeployable);
  const body = findInTemplate(entity, PhysicsBodyComponent);
  if (!deployable || !body) {
    console.error(
      `[Deployable] template has no ${deployable ? 'PhysicsBody (give it a DynamicCollider body)' : 'GASDeployable component'}; not thrown.`,
    );
    entity.destroy();
    return;
  }
  deployable.configure({
    fuseSeconds: config.fuseSeconds,
    resolveOnImpact: config.resolveOnImpact,
    despawnDelaySeconds: config.despawnDelaySeconds,
    instigator: config.instigator,
    onResolve: (at: Vec3, hit: Entity | null, self: Entity): void => config.onResolve(at, hit, self),
  });

  // Velocity last: the body has to be armed before it moves, or a fast throw can
  // collide against an unconfigured deployable.
  body.linearVelocity = direction.mul(config.throwSpeed);
}

/** Templates nest the collider and logic on a child of the spawned root as often as not. */
function findInTemplate<T extends Component>(root: Entity, componentClass: AbstractClass<T>): Maybe<T> {
  const onRoot = root.getComponent<T>(componentClass);
  if (onRoot) {
    return onRoot;
  }
  return root.getChildrenWithComponent<T>(componentClass, true)[0]?.getComponent<T>(componentClass) ?? null;
}
