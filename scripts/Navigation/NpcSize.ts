/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Navigation Scripts v2

import {
  ActorSdkLogicComponent,
  CapsuleAxis,
  CharacterControllerBase,
  ColliderCapsuleComponent,
  PhysicsBodyComponent,
  PhysicsBodyType,
  Quaternion,
  TransformComponent,
  Vec3,
  type Entity,
} from 'meta/worlds';

/** The physical size of an NPC in meters. */
export interface NpcSize {
  radius: number;
  height: number;
}

// Colliders this close to vertical count as upright.
const UPRIGHT_DOT = 0.99;
// Relative size difference above which the KCC and the capsule are reported as disagreeing.
const DISAGREEMENT_RATIO = 0.1;

// A disabled child's controller or collider is not simulated, so it does not size the NPC.
const ENABLED_ONLY = {includeDisabled: false};

const checkedDisagreement = new WeakSet<Entity>();

/**
 * The size of an NPC, read from its character controller or, failing that,
 * from its largest upright non-trigger capsule collider.
 *
 * Returns null when the entity is not an NPC (no `ActorSdkLogicComponent`) or
 * has neither with a positive, finite size. Disabled children are skipped.
 * The controller size is used as authored, because the physics capsule built
 * from it ignores transform scale; a capsule collider's world scale is
 * applied, as physics does. Each call scans the hierarchy, so callers should
 * cache the result.
 */
export function getNpcSize(entity: Entity): NpcSize | null {
  if (entity.getComponent(ActorSdkLogicComponent) == null) {
    return null;
  }
  const fromController = findController(entity);
  // With a controller, the capsule is read only to report a disagreement once.
  const fromCapsule =
    fromController == null || !checkedDisagreement.has(entity) ? findLargestCapsule(entity) : null;
  if (fromController != null && fromCapsule != null) {
    checkedDisagreement.add(entity);
    if (
      differs(fromController.radius, fromCapsule.radius) ||
      differs(fromController.height, fromCapsule.height)
    ) {
      console.warn(
        `[NpcSize] ${entity.name}: character controller size ` +
          `(r=${fromController.radius}, h=${fromController.height}) differs from its ` +
          `capsule collider (r=${fromCapsule.radius}, h=${fromCapsule.height}); ` +
          'using the character controller.',
      );
    }
  }
  return fromController ?? fromCapsule;
}

function findController(entity: Entity): NpcSize | null {
  const candidates = [entity, ...entity.getChildrenWithComponent(CharacterControllerBase, true, ENABLED_ONLY)];
  for (const candidate of candidates) {
    const size = controllerSize(candidate);
    if (size != null) {
      return size;
    }
  }
  return null;
}

function controllerSize(candidate: Entity): NpcSize | null {
  let controller: CharacterControllerBase | null = null;
  try {
    controller = candidate.getComponent(CharacterControllerBase);
  } catch {
    // getComponent throws when one entity carries two controllers; that entity is ambiguous.
    return null;
  }
  if (controller == null) {
    return null;
  }
  return usable({radius: controller.radius, height: controller.height});
}

function findLargestCapsule(entity: Entity): NpcSize | null {
  let best: NpcSize | null = null;
  const candidates = [entity, ...entity.getChildrenWithComponent(ColliderCapsuleComponent, true, ENABLED_ONLY)];
  for (const candidate of candidates) {
    const size = capsuleSize(candidate);
    if (
      size != null &&
      (best == null ||
        size.height > best.height ||
        (size.height === best.height && size.radius > best.radius))
    ) {
      best = size;
    }
  }
  return best;
}

function capsuleSize(candidate: Entity): NpcSize | null {
  let capsule: ColliderCapsuleComponent | null = null;
  try {
    capsule = candidate.getComponent(ColliderCapsuleComponent);
  } catch {
    // getComponent throws when one entity carries two capsules; that entity is ambiguous.
    return null;
  }
  if (capsule == null || isTrigger(candidate)) {
    return null;
  }
  const transform = candidate.getComponent(TransformComponent);
  const rotation = transform?.worldRotation ?? Quaternion.identity;
  const scale = transform?.worldScale ?? Vec3.one;
  const localAxis = axisVector(capsule.axis);
  const worldAxis = Quaternion.mulVec3(localAxis, rotation).normalize();
  if (Math.abs(worldAxis.y) < UPRIGHT_DOT) {
    return null;
  }
  const capsuleAxis = capsule.axis;
  const axisScale = Math.abs(component(scale, capsuleAxis));
  const crossScale = Math.max(
    ...[CapsuleAxis.X, CapsuleAxis.Y, CapsuleAxis.Z]
      .filter(axis => axis !== capsuleAxis)
      .map(axis => Math.abs(component(scale, axis))),
  );
  return usable({
    radius: capsule.radius * crossScale,
    height: (capsule.length + 2 * capsule.radius) * axisScale,
  });
}

// findNavMesh throws on a non-positive or non-finite size, so such a size counts as unknown.
function usable(size: NpcSize): NpcSize | null {
  return Number.isFinite(size.radius) &&
    size.radius > 0 &&
    Number.isFinite(size.height) &&
    size.height > 0
    ? size
    : null;
}

// A collider belongs to the nearest physics body on its entity or an ancestor.
function isTrigger(entity: Entity): boolean {
  for (let current: Entity | null = entity; current != null; current = current.parent) {
    const body = current.getComponent(PhysicsBodyComponent);
    if (body != null) {
      return body.type === PhysicsBodyType.Trigger;
    }
  }
  return false;
}

function axisVector(axis: CapsuleAxis): Vec3 {
  switch (axis) {
    case CapsuleAxis.X:
      return new Vec3(1, 0, 0);
    case CapsuleAxis.Y:
      return new Vec3(0, 1, 0);
    case CapsuleAxis.Z:
      return new Vec3(0, 0, 1);
  }
}

function component(vector: Vec3, axis: CapsuleAxis): number {
  switch (axis) {
    case CapsuleAxis.X:
      return vector.x;
    case CapsuleAxis.Y:
      return vector.y;
    case CapsuleAxis.Z:
      return vector.z;
  }
}

function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > DISAGREEMENT_RATIO * Math.max(a, b);
}
