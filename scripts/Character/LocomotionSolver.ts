/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v15

import {Vec3} from 'meta/worlds';
import {AccelerationCurve, type AccelerationConfig} from './AccelerationCurve';

/** Per-frame inputs to the solver. All directions are WORLD space. */
export type LocomotionSolveParams = {
  /**
   * World-space XZ move direction, ALREADY passed through resolveDirection(). NOT camera-
   * or stick-relative: mapping input space to world space needs a camera, so it stays with
   * the caller.
   */
  worldMoveDirection: Vec3;
  /** Unclamped input magnitude, used for the slide-lock threshold and the damping gate. */
  inputMagnitude: number;
  /** Thumbstick noise threshold; programmatic world-space input uses zero. */
  inputDeadZone?: number;
  deltaTime: number;
  /** moveSpeed * speedMultiplier, resolved by the caller. */
  effectiveSpeed: number;
  isGrounded: boolean;
};

/**
 * The body-agnostic half of character locomotion: slide-direction lock, legacy stop
 * damping, and the acceleration curve. Takes a world-space direction and returns a
 * per-frame position delta.
 *
 * WHY THIS IS A SEPARATE UNIT. `MovementAbility` mixes two concerns — mapping stick input
 * to a world direction, which needs `CameraService` and therefore only works on a client,
 * and turning a direction into a delta, which needs nothing endpoint-specific. Only the
 * second half can run on a server-ticked body. Keeping them together is what makes the
 * capability client-only; splitting them is what lets one implementation serve both a
 * player and an NPC.
 *
 * This class must never reference `CameraService`, `PlayerInputService`, or any other
 * client-only service. There is a test asserting exactly that.
 *
 * It owns the state those three steps carry across frames — the lock, the damped velocity,
 * the curve — because that state is meaningless without them.
 */
export class LocomotionSolver {
  private readonly accelerationCurve: AccelerationCurve;

  private slideDirectionLocked: boolean = false;
  private lockedWorldDirection: Vec3 = Vec3.forward;
  private legacyVelocity: Vec3 = Vec3.zero;

  public slideDirectionLockEnabled: boolean = false;
  public slideDirectionLockThreshold: number = 0.3;
  public enableAcceleration: boolean = true;
  public stopDamping: number = 15.0;

  constructor(curveConfig: Partial<AccelerationConfig>) {
    this.accelerationCurve = new AccelerationCurve(curveConfig);
  }

  /**
   * Curve only. Matches what `MovementAbility.resetAcceleration()` did before the
   * extraction — it reset the curve and nothing else, so widening it here would silently
   * clear the damped velocity and the lock on every teleport and respawn.
   */
  public resetCurve(): void {
    this.accelerationCurve?.reset();
  }

  /** Damped velocity only; `stop()` cleared this and left the lock alone. */
  public resetVelocity(): void {
    this.legacyVelocity = Vec3.zero;
  }

  public setCurveConfig(config: Partial<AccelerationConfig>): void {
    this.accelerationCurve?.setConfig(config);
  }

  public getCurveConfig(): AccelerationConfig | null {
    return this.accelerationCurve?.getConfig() ?? null;
  }

  public isSlideDirectionLocked(): boolean {
    return this.slideDirectionLocked;
  }

  public unlockSlideDirection(): void {
    this.slideDirectionLocked = false;
  }

  /**
   * Slide-lock only. The force-input path needs the resolved DIRECTION but computes its
   * own velocity, so it cannot go through `solve()`; both paths must nonetheless share one
   * lock, because the lock carries state across frames and two copies would diverge the
   * moment a body switched paths.
   */
  public resolveDirection(worldMoveDirection: Vec3, inputMagnitude: number): Vec3 {
    return this.applySlideDirectionLock(worldMoveDirection, inputMagnitude);
  }

  /**
   * Direction -> delta, for the kinematic path. The order here is load-bearing and matches
   * the original inline sequence exactly: lock, then damping, then acceleration.
   */
  public solve(
    params: LocomotionSolveParams,
    onBeforeAcceleration?: (desiredDelta: Vec3) => void,
  ): Vec3 {
    // `worldMoveDirection` must ALREADY be lock-resolved by the caller via
    // resolveDirection(). Re-locking here would double-apply it: on the frame the lock
    // engages, the second call returns the locked vector instead of the base direction.
    const direction = params.worldMoveDirection;

    const hasInput = params.inputMagnitude > (params.inputDeadZone ?? 0.1);
    let desiredDelta: Vec3;
    if (hasInput) {
      desiredDelta = new Vec3(
        direction.x * params.effectiveSpeed * params.deltaTime,
        0,
        direction.z * params.effectiveSpeed * params.deltaTime,
      );
    } else {
      desiredDelta = Vec3.zero;
    }

    const dampedDelta = this.applyLegacyDamping(
      desiredDelta,
      hasInput,
      params.deltaTime,
      params.effectiveSpeed,
    );

    // The original sequence interleaves a side effect here — cancelling any in-plane
    // velocity opposing the input, so a slide can be stopped by pushing against it. It
    // writes a force controller, which is a substrate primitive this solver must not
    // depend on, so the caller supplies it and the ORDER is preserved. Dropping it would
    // silently remove ice-slide cancellation.
    onBeforeAcceleration?.(desiredDelta);

    if (!this.enableAcceleration) {
      // Reuse the cached result rather than damping twice.
      return dampedDelta;
    }

    const maxFrameTranslation = params.effectiveSpeed * params.deltaTime;
    return this.accelerationCurve.applyDirectionInterpolation(
      desiredDelta,
      params.deltaTime,
      maxFrameTranslation,
      params.isGrounded,
      dampedDelta.div(params.deltaTime),
    );
  }

  /**
   * Locks the travel direction to the one movement started in, so imprecise thumbstick
   * drift does not curve a straight line. The locked direction keeps the CURRENT
   * magnitude, so speed control still works while the heading is held.
   *
   * Takes an already-world-space base direction — the caller owns the mapping.
   */
  private applySlideDirectionLock(baseDirection: Vec3, inputMagnitude: number): Vec3 {
    if (!this.slideDirectionLockEnabled) {
      return baseDirection;
    }

    const isMoving = inputMagnitude > 0.01;

    if (!isMoving) {
      this.slideDirectionLocked = false;
      return baseDirection;
    }

    if (!this.slideDirectionLocked) {
      if (inputMagnitude >= this.slideDirectionLockThreshold) {
        this.slideDirectionLocked = true;

        const directionMagnitude = Math.sqrt(
          baseDirection.x * baseDirection.x + baseDirection.z * baseDirection.z,
        );

        if (directionMagnitude > 0.001) {
          this.lockedWorldDirection = new Vec3(
            baseDirection.x / directionMagnitude,
            0,
            baseDirection.z / directionMagnitude,
          );
        }
      }
      return baseDirection;
    }

    // Clamped to 1 so a locked direction matches the unlocked case, which uses a
    // normalized input.
    const clampedMagnitude = Math.min(inputMagnitude, 1);
    return new Vec3(
      this.lockedWorldDirection.x * clampedMagnitude,
      0,
      this.lockedWorldDirection.z * clampedMagnitude,
    );
  }

  /** Legacy damping behavior for backwards compatibility. */
  private applyLegacyDamping(
    desiredDelta: Vec3,
    hasInput: boolean,
    dt: number,
    effectiveSpeed: number,
  ): Vec3 {
    if (hasInput) {
      if (effectiveSpeed > 0 && dt > 0) {
        this.legacyVelocity = new Vec3(
          desiredDelta.x / (effectiveSpeed * dt),
          0,
          desiredDelta.z / (effectiveSpeed * dt),
        );
      }
      return desiredDelta;
    }

    const dampFactor = Math.max(0, 1 - this.stopDamping * dt);
    this.legacyVelocity = new Vec3(
      this.legacyVelocity.x * dampFactor,
      0,
      this.legacyVelocity.z * dampFactor,
    );

    // Zero out jitter
    if (
      this.legacyVelocity.x * this.legacyVelocity.x +
        this.legacyVelocity.z * this.legacyVelocity.z <
      0.0001
    ) {
      this.legacyVelocity = Vec3.zero;
    }

    return new Vec3(
      this.legacyVelocity.x * effectiveSpeed * dt,
      0,
      this.legacyVelocity.z * effectiveSpeed * dt,
    );
  }
}
