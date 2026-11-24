/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Navigation Scripts v2

import {
  EntityService,
  NavMeshComponent,
  type Maybe,
  type NavMeshAgentSize,
  type NavMeshBounds,
  type Vec3,
} from 'meta/worlds';

// Native sizes are float32, which rounds either way (0.7f is 0.69999998), so an
// exact match can read slightly below the requested size; float32 error is ~6e-8.
const FLOAT32_SLACK = 1e-5;
const SCORE_EPSILON = 1e-6;

/**
 * The Actor Framework's NavMesh selection rule: the NavMesh in the world built
 * for an agent at least as large as the given size that covers the given
 * position, preferring the closest size. The editor tool
 * `assign_nav_mesh_to_agent` (`NavMeshProvisioningMath::selectBestFitNavMesh`)
 * applies the same rule; keep the two in sync.
 *
 * @remarks
 * A NavMesh is a candidate when:
 * - both the NavMesh's agent radius and agent height are at least the given
 *   size. A NavMesh built for a smaller agent is rejected because its paths
 *   run too close to walls and under ceilings too low for the given size. The
 *   bound allows float rounding (a relative 1e-5), so a size stored as a
 *   32-bit float still matches exactly.
 * - `agentPos` is inside the NavMesh's `getWorldBounds()` box (boundary
 *   included).
 * - the NavMesh entity is enabled.
 *
 * Among candidates, the NavMesh with the smallest relative size difference
 * (radius and height combined) wins. Candidates within a tiny tolerance of
 * that smallest difference tie, and the larger NavMesh wins. If tied
 * candidates still cannot be told apart, the first NavMesh returned by the
 * world query is used.
 *
 * A NavMesh built for a much larger agent is safe but may find few paths: its
 * walkable area keeps the larger agent's radius away from every wall, so
 * narrow passages close.
 *
 * Each call queries every NavMesh entity in the world; cache the result.
 * Before the NavMesh assets load, NavMeshes report the default size and
 * bounds.
 *
 * @param agentSize - The agent radius and height in meters. Both must be
 * positive.
 * @param agentPos - The world-space position of the agent.
 * @returns The best matching NavMesh, or `null` if no NavMesh qualifies.
 * @throws Error if `agentSize.radius` or `agentSize.height` is not positive.
 * @throws Error if a NavMesh's agent size or bounds cannot be read: its entity
 * was destroyed during the search, or pathfinding is unavailable in this world
 * (see `NavMeshComponent.getAgentSize()`).
 */
export function findNavMesh(agentSize: NavMeshAgentSize, agentPos: Vec3): Maybe<NavMeshComponent> {
  const agentRadius = agentSize.radius;
  const agentHeight = agentSize.height;
  if (!(agentRadius > 0)) {
    throw new Error('agentSize.radius must be positive');
  }
  if (!(agentHeight > 0)) {
    throw new Error('agentSize.height must be positive');
  }

  const candidates: Array<{
    navMesh: NavMeshComponent;
    radius: number;
    height: number;
    score: number;
  }> = [];
  let bestScore = Infinity;
  for (const entity of EntityService.findEntitiesWithComponent(NavMeshComponent, {includeDisabled: false})) {
    const navMesh = entity.getComponent(NavMeshComponent);
    if (!navMesh) {
      continue;
    }
    const {radius, height} = navMesh.getAgentSize();
    if (
      !isAtLeast(radius, agentRadius) ||
      !isAtLeast(height, agentHeight) ||
      !contains(navMesh.getWorldBounds(), agentPos)
    ) {
      continue;
    }
    const score = Math.abs(radius - agentRadius) / agentRadius + Math.abs(height - agentHeight) / agentHeight;
    candidates.push({navMesh, radius, height, score});
    bestScore = Math.min(bestScore, score);
  }

  // Ties are measured against the best score over all candidates, so the
  // result does not depend on query order.
  let best: Maybe<(typeof candidates)[number]> = null;
  for (const candidate of candidates) {
    if (candidate.score - bestScore > SCORE_EPSILON) {
      continue;
    }
    if (
      best == null ||
      candidate.radius > best.radius ||
      (candidate.radius === best.radius && candidate.height > best.height)
    ) {
      best = candidate;
    }
  }
  return best?.navMesh ?? null;
}

function isAtLeast(value: number, target: number): boolean {
  return value >= target * (1 - FLOAT32_SLACK);
}

function contains(bounds: NavMeshBounds, position: Vec3): boolean {
  return (
    position.x >= bounds.min.x &&
    position.x <= bounds.max.x &&
    position.y >= bounds.min.y &&
    position.y <= bounds.max.y &&
    position.z >= bounds.min.z &&
    position.z <= bounds.max.z
  );
}
