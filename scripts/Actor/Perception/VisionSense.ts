/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v37

import {
  TransformComponent,
  Vec3,
  type Entity,
} from 'meta/worlds';
import {horizontalDistance, type RandomSource} from '../Utilities/ShooterComputations';
import {PhysicsSightQuery, type SightQuery} from './SightQuery';

/**
 * The visual sense: FOV cone, sight range and a physics line-of-sight ray,
 * polled on a cadence, plus the per-sighting attention (notice) delay.
 *
 * It answers whether one candidate is seen right now and how long it has
 * been continuously in view. What anyone does about that — memory, modes,
 * firing — lives elsewhere. A hearing sense later answers the same shape
 * (heard/last-heard) over noise instead of light; both feed PerceptionMemory.
 */
export class VisionSense {
  /** Farthest the observer can see (m). 0 = unlimited. */
  sightRange: number = 30;
  /**
   * Horizontal field of view (deg) the candidate must be inside to be noticed.
   * 120 reads as human peripheral vision. 0 or >= 360 disables the check.
   */
  fieldOfViewDeg: number = 120;
  /**
   * Seconds the candidate must stay visible before the first shot. Legacy fixed
   * delay, used only while both `reactionTimeMin` and `reactionTimeMax` are
   * unset.
   */
  reactionTime: number = 0.4;
  /**
   * Bounds (s) of the per-acquisition attention delay: each new sighting rolls
   * its own delay in [min, max]. Crossed bounds are ordered at roll time; both
   * unset falls back to `reactionTime`.
   */
  reactionTimeMin: number = 0.1;
  reactionTimeMax: number = 0.5;
  /**
   * Seconds between line-of-sight queries. What is seen lags the world by up
   * to this long; a weapon's own ray decides what a shot hits.
   */
  sightCheckInterval: number = 0.15;
  /** Height (m) above the observer's root the ray leaves from. */
  eyeHeight: number = 1.0;
  /** Height (m) above the candidate's root the ray is aimed at. */
  targetAimHeight: number = 1.0;
  /**
   * Seconds a seen candidate stays cone-exempt after dropping out of sight, so
   * one blocked ray does not end a sighting. Past it the cone gates again.
   */
  lostSightGraceSeconds: number = 0.5;
  /** Line-of-sight oracle. Replaced in tests. */
  sightQuery: SightQuery = new PhysicsSightQuery();
  /** Random source for attention rolls. Replaced in tests. */
  random: RandomSource = Math.random;

  /** True while the latest line-of-sight answer says the candidate is visible and in sight range. */
  visible: boolean = false;
  /** Seconds the candidate has been continuously visible. */
  visibleSeconds: number = 0;
  /** Seconds since the candidate was actually visible. Starts outside the lost-sight grace: a never-seen candidate gets no grace. */
  secondsSinceVisible: number = Number.POSITIVE_INFINITY;
  /** This sighting's rolled attention delay (s); re-rolled per sighting. */
  attentionDelay: number = 0.4;

  private selfTransform: TransformComponent | null = null;
  private targetVisibleRaw: boolean = false;
  private sightTimer: number = 0;
  private sightPending: boolean = false;
  private sightToken: number = 0;

  initialize(self: Entity): void {
    this.selfTransform = self.getComponent(TransformComponent);
  }

  // Five scalar/reference params, not an args bag: this runs every frame and an
  // object literal per call would allocate into the 72 Hz loop, while the
  // params themselves allocate nothing.
  // eslint-disable-next-line mhs-linter/too-many-arguments
  update(dt: number, self: Entity, selfPos: Vec3, candidate: Entity | null, candidatePos: Vec3 | null): void {
    if (!candidate || !candidatePos) {
      this.visible = false;
      // A pending query from a prior candidate must not resolve into a
      // sighting no cone or ray confirms: same as out of range, it waits
      // for a fresh answer rather than reusing a stale clear.
      this.invalidate();
      this.noteUnseen(dt);
      return;
    }
    const inRange = this.sightRange <= 0 || horizontalDistance(selfPos, candidatePos) <= this.sightRange;
    if (!inRange) {
      // Re-entering range must wait for a fresh answer, not reuse the last one.
      this.invalidate();
      this.visible = false;
      this.noteUnseen(dt);
      return;
    }
    // The cone gates noticing, not keeping. While the candidate is visible —
    // or was seen within the lost-sight grace — the raycast alone decides, so
    // one blocked sample does not end the sighting. Past the grace the cone
    // gates again, and a long-lost candidate must re-enter the view.
    const keepKnownThreat =
      this.visible || this.secondsSinceVisible <= this.lostSightGraceSeconds;
    if (!keepKnownThreat && !this.inFieldOfView(selfPos, candidatePos)) {
      // Same as out of range: re-entering the cone waits for a fresh query
      // rather than reusing a stale clear.
      this.invalidate();
      this.visible = false;
      this.noteUnseen(dt);
      return;
    }
    this.sightTimer -= dt;
    if (this.sightTimer <= 0 && !this.sightPending) {
      this.sightTimer = this.sightCheckInterval;
      this.sightPending = true;
      const token = this.sightToken;
      const from = selfPos.add(new Vec3(0, this.eyeHeight, 0));
      const to = candidatePos.add(new Vec3(0, this.targetAimHeight, 0));
      this.sightQuery.hasClearShot(from, to, self, candidate).then(
        clear => {
          if (token === this.sightToken) {
            this.targetVisibleRaw = clear;
            this.sightPending = false;
          }
        },
        () => {
          // An unanswered query reads as blocked, never as the last answer.
          if (token === this.sightToken) {
            this.targetVisibleRaw = false;
            this.sightPending = false;
          }
        },
      );
    }
    this.visible = this.targetVisibleRaw;
    if (this.visible) {
      if (this.visibleSeconds === 0) {
        // A new sighting rolls its own delay. Flicker does not re-roll:
        // visibleSeconds only resets after lostSightGraceSeconds of continuous
        // invisibility (see noteUnseen).
        this.attentionDelay = this.rollAttentionDelay();
      }
      this.visibleSeconds += dt;
      this.secondsSinceVisible = 0;
    } else {
      this.noteUnseen(dt);
    }
  }

  /** Drops the current sighting. Nothing seen carries over a new target. */
  reset(): void {
    this.invalidate();
    this.visible = false;
    this.visibleSeconds = 0;
    // No lost-sight grace for a target that was never seen.
    this.secondsSinceVisible = Number.POSITIVE_INFINITY;
  }

  private noteUnseen(dt: number): void {
    this.secondsSinceVisible += dt;
    if (this.secondsSinceVisible > this.lostSightGraceSeconds) {
      this.visibleSeconds = 0;
    }
  }

  /** This sighting's attention delay: a roll in [min, max], else the legacy fixed delay. */
  private rollAttentionDelay(): number {
    if (this.reactionTimeMin <= 0 && this.reactionTimeMax <= 0) {
      return Math.max(0, this.reactionTime);
    }
    const lo = Math.max(0, this.reactionTimeMin);
    const hi = Math.max(lo, this.reactionTimeMax);
    return lo + (hi - lo) * this.random();
  }

  private invalidate(): void {
    this.sightToken++;
    this.sightPending = false;
    this.sightTimer = 0;
    this.targetVisibleRaw = false;
  }

  /**
   * Whether the candidate sits inside the observer's horizontal field of view.
   * Read off the body facing: no look controller is registered in this package,
   * so the body yaw is the only visible attention direction. Anything stacked
   * on the observer, or with no readable facing, counts as seen.
   */
  private inFieldOfView(selfPos: Vec3, candidatePos: Vec3): boolean {
    if (this.fieldOfViewDeg <= 0 || this.fieldOfViewDeg >= 360) {
      return true;
    }
    const forward = this.selfTransform?.worldForward;
    const dx = candidatePos.x - selfPos.x;
    const dz = candidatePos.z - selfPos.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < 1e-8 || !forward) {
      return true;
    }
    const flenSq = forward.x * forward.x + forward.z * forward.z;
    if (flenSq < 1e-8) {
      return true;
    }
    const cos = (dx * forward.x + dz * forward.z) / Math.sqrt(distSq * flenSq);
    return cos >= Math.cos((this.fieldOfViewDeg * Math.PI) / 360);
  }
}
