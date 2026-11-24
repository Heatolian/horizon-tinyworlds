/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v25

/**
 * Ranking for "select the interactable the camera faces": the native
 * screen-mode ranking (`HoverBestRankedProcessor` with Worlds'
 * `config/mode/screen/interactionConfig.json`), which is close to pure camera
 * angle.
 *
 * The SDK's built-in camera ranking (`InteractorComponent.cameraEntity`) is a
 * port of the same processor but with a distance weight of 1.0 (native screen
 * mode: 0.01) and a 0.15 bonus for the current candidate (native: none). With
 * an orbit camera several metres behind the player, objects within reach sit
 * close to the camera's view axis, so their angle scores differ by at most
 * about 0.1: under the bonus, so turning the camera never changes the pick.
 * `InteractionControlsBridge` installs this ranking through
 * `CandidateSelectionService.setCandidateSelector` instead.
 */

/** A world-space point or direction. */
export type Point3 = {readonly x: number; readonly y: number; readonly z: number};

/** One candidate to rank: an id (the interactable entity) and its position. */
export type FacingCandidate<T> = {readonly id: T; readonly position: Point3};

/** The camera ray, the player's position and the current pick. */
export type FacingView<T> = {
  /** The camera's world position. */
  readonly cameraPosition: Point3;
  /** The camera's world forward. */
  readonly cameraForward: Point3;
  /** The interactor's world position (the player's body), for the distance term. */
  readonly origin: Point3;
  /** The currently selected candidate, which keeps a small bonus. */
  readonly current: T | null;
};

/** Angle weight (native screen mode `angleRankWeight`). */
export const ANGLE_WEIGHT = 5;
/** Distance weight (native screen mode `distanceRankWeight`). */
export const DISTANCE_WEIGHT = 0.01;
/** Squared distance (m²) beyond which the distance term adds nothing (native default). */
export const DISTANCE_MAX_SQ = 1;
/**
 * Bonus for the current candidate. Native has none; this small one stops the
 * pick flickering while the camera rests between two objects. It costs about
 * 5 degrees of camera turn before the other object is picked.
 */
export const INCUMBENT_BONUS = 0.01;

function unit(v: Point3): Point3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 0 ? {x: v.x / len, y: v.y / len, z: v.z / len} : {x: 0, y: 0, z: 0};
}

/** Candidates best first: the one nearest the centre of the camera's view. */
export function rankByFacing<T>(candidates: ReadonlyArray<FacingCandidate<T>>, view: FacingView<T>): T[] {
  const forward = unit(view.cameraForward);
  const scored = candidates.map(c => {
    const toCandidate = unit({
      x: c.position.x - view.cameraPosition.x,
      y: c.position.y - view.cameraPosition.y,
      z: c.position.z - view.cameraPosition.z,
    });
    const cos = toCandidate.x * forward.x + toCandidate.y * forward.y + toCandidate.z * forward.z;
    const dx = c.position.x - view.origin.x;
    const dy = c.position.y - view.origin.y;
    const dz = c.position.z - view.origin.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    let score =
      ANGLE_WEIGHT * Math.max(0, cos) +
      DISTANCE_WEIGHT * (1 - Math.min(distSq, DISTANCE_MAX_SQ) / DISTANCE_MAX_SQ);
    if (c.id === view.current) {
      score += INCUMBENT_BONUS;
    }
    return {id: c.id, score};
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.id);
}

/** One candidate for `rankAlongHeading`: its position and the radius of its interaction sensor. */
export type HeadingCandidate<T> = FacingCandidate<T> & {readonly radius: number};

/** The interactor's position and the camera's forward; only its horizontal heading counts. */
export type HeadingView = {
  readonly origin: Point3;
  readonly cameraForward: Point3;
};

/**
 * Candidates best first, judged from the player rather than the camera, on the
 * ground plane: the first sensor the line from the player along the camera's
 * heading passes through, then those it misses in front of the player, the
 * nearest to the line first, then those behind, the nearest first.
 *
 * `rankByFacing` measures angles from the camera, which sits behind and above
 * the player; seen from there, of two objects in line ahead of the player the
 * farther one is nearer the centre of the view, so it wins over the one at the
 * player's feet. Here the nearer one wins, and turning the camera picks
 * whatever then lies on the line. Both use only what is authored: the sensor
 * radii, no angle or distance weights.
 */
export function rankAlongHeading<T>(candidates: ReadonlyArray<HeadingCandidate<T>>, view: HeadingView): T[] {
  const heading = unit({x: view.cameraForward.x, y: 0, z: view.cameraForward.z});
  // A camera looking straight down has no heading: everything ranks by distance.
  const hasHeading = heading.x !== 0 || heading.z !== 0;
  const scored = candidates.map(c => {
    const dx = c.position.x - view.origin.x;
    const dz = c.position.z - view.origin.z;
    const distance = Math.hypot(dx, dz);
    const along = dx * heading.x + dz * heading.z;
    const aside = Math.abs(dx * heading.z - dz * heading.x);
    if (distance <= c.radius) {
      // The player stands in its sensor.
      return {id: c.id, tier: 0, key: distance};
    }
    if (hasHeading && along >= 0 && aside <= c.radius) {
      // Where the line enters the sensor.
      return {id: c.id, tier: 1, key: along - Math.sqrt(c.radius * c.radius - aside * aside)};
    }
    return hasHeading && along >= 0 ? {id: c.id, tier: 2, key: aside - c.radius} : {id: c.id, tier: 3, key: distance};
  });
  scored.sort((a, b) => a.tier - b.tier || a.key - b.key);
  return scored.map(s => s.id);
}
