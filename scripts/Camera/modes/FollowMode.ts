/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v10

/**
 * Orbit that eases back behind the player's facing direction once look input
 * stops, with an optional pitch return to the horizon.
 *
 * Differs from ThirdPerson's auto-rotate: this tracks where the player is
 * FACING (so it also re-centres while turning on the spot), whereas
 * ThirdPerson tracks where the player is MOVING.
 *
 * The return eases out: each frame closes a share of the remaining angle, so a
 * small heading error is corrected slowly and an off-axis stick bends the path
 * gently instead of locking the camera to the facing.
 */

import {
  type CameraModeContext,
  CameraModeType,
  type CameraTuning,
  clampAngle,
  facingYawDegrees,
  shortestAngleDelta,
} from '../CameraModeTypes';
import {OrbitCameraModeBase} from './OrbitCameraModeBase';

// Minimum squared XZ movement per frame to count as moving; filters out
// positional jitter while standing still.
const MIN_MOVE_SQ = 0.000001;

export class FollowMode extends OrbitCameraModeBase {
  public readonly type = CameraModeType.Follow;
  protected override readonly acceptsLookInput = true;

  /** Re-centre even when the player is standing still. */
  public continuousTurn: boolean = false;
  /** Also return pitch toward `horizonLevelingPitch`. */
  public horizonLeveling: boolean = false;
  public horizonLevelingPitch: number = 0;
  /**
   * Share of the remaining angle closed per second (1.0 ≈ the engine follow
   * camera). Higher re-centres faster.
   */
  public rotationRate: number = 1.0;
  /** Seconds for the return rate to ramp to full; 0 disables the ramp. */
  public rotationRateAccelerationTime: number = 0;
  /**
   * No re-centring while the player moves more than this many degrees away
   * from camera-forward. Backing toward the camera turns the character to face
   * it; chasing that facing swings the camera, which re-maps the stick and
   * swings the character again.
   */
  public maxRecenterMoveAngle: number = 135;

  private noInputTimer: number = 0;
  private horizontalTimePassed: number = 0;
  private verticalTimePassed: number = 0;
  private previousTargetPosition: {x: number; z: number} | null = null;
  private suppressUntilMoving: boolean = false;

  public override onActivate(
    ctx: CameraModeContext,
    tuning: CameraTuning,
  ): void {
    super.onActivate(ctx, tuning);
    ctx.pitch = clampAngle(ctx.pitch, tuning.minPitch, tuning.maxPitch);
    this.noInputTimer = 0;
    this.horizontalTimePassed = 0;
    this.verticalTimePassed = 0;
    this.previousTargetPosition = null;
    this.suppressUntilMoving = false;
  }

  protected updateAngles(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): void {
    const position = ctx.targetTransform.worldPosition;
    let isMoving = false;
    let movingTowardCamera = false;
    if (this.previousTargetPosition !== null) {
      const dx = position.x - this.previousTargetPosition.x;
      const dz = position.z - this.previousTargetPosition.z;
      isMoving = dx * dx + dz * dz > MIN_MOVE_SQ;
      if (isMoving) {
        const moveYaw = Math.atan2(-dx, -dz) * (180 / Math.PI);
        movingTowardCamera =
          Math.abs(shortestAngleDelta(ctx.yaw, moveYaw)) >
          this.maxRecenterMoveAngle;
      }
    }
    this.previousTargetPosition = {x: position.x, z: position.z};

    if (isMoving) {
      this.suppressUntilMoving = false;
    }

    const hasInput = ctx.lookDeltaYaw !== 0 || ctx.lookDeltaPitch !== 0;

    if (hasInput) {
      ctx.yaw += ctx.lookDeltaYaw;
      ctx.pitch = clampAngle(
        ctx.pitch + ctx.lookDeltaPitch,
        tuning.minPitch,
        tuning.maxPitch,
      );
      this.noInputTimer = 0;
      this.horizontalTimePassed = 0;
      this.verticalTimePassed = 0;
      // Aiming while stationary is a deliberate look-around; don't yank it back
      // until the player actually moves again.
      if (this.continuousTurn && !isMoving) {
        this.suppressUntilMoving = true;
      }
      return;
    }

    if (!this.suppressUntilMoving && this.noInputTimer < tuning.autoRotateDelay) {
      this.noInputTimer += deltaTime;
    }

    if (movingTowardCamera || !this.canAutoRotate(tuning, isMoving)) {
      this.horizontalTimePassed = 0;
      this.verticalTimePassed = 0;
      return;
    }

    this.horizontalTimePassed += deltaTime;
    const facingYaw = facingYawDegrees(ctx.targetTransform);
    ctx.yaw +=
      shortestAngleDelta(ctx.yaw, facingYaw) *
      this.rotationFraction(deltaTime, this.horizontalTimePassed);

    if (this.horizonLeveling) {
      this.verticalTimePassed += deltaTime;
      ctx.pitch = clampAngle(
        ctx.pitch +
          (this.horizonLevelingPitch - ctx.pitch) *
            this.rotationFraction(deltaTime, this.verticalTimePassed),
        tuning.minPitch,
        tuning.maxPitch,
      );
    } else {
      this.verticalTimePassed = 0;
    }
  }

  private canAutoRotate(tuning: CameraTuning, isMoving: boolean): boolean {
    if (!tuning.autoRotateEnabled) return false;
    if (this.suppressUntilMoving) return false;
    if (!isMoving && !this.continuousTurn) return false;
    return (
      tuning.autoRotateDelay === 0 || this.noInputTimer >= tuning.autoRotateDelay
    );
  }

  /** Share of the remaining angle to close this frame, in [0, 1]. */
  private rotationFraction(deltaTime: number, timePassed: number): number {
    const fraction = Math.min(1.0, Math.max(0, this.rotationRate) * deltaTime);
    if (this.rotationRateAccelerationTime <= 0) {
      return fraction;
    }
    return fraction * Math.min(1.0, timePassed / this.rotationRateAccelerationTime);
  }
}
