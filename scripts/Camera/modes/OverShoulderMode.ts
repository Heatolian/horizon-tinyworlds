/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v10

/**
 * ThirdPerson framed close over the player's right shoulder, the usual
 * mobile-shooter view: the player stands left of the screen centre, so the
 * crosshair sees past them. Look input, auto-rotate, smoothing and collision
 * are ThirdPerson's; only the orbit's distance, pivot and starting pitch come
 * from the `overShoulder*` tuning.
 */

import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  clampAngle,
} from '../CameraModeTypes';
import {ThirdPersonMode} from './ThirdPersonMode';

export class OverShoulderMode extends ThirdPersonMode {
  public override readonly type: CameraModeType = CameraModeType.OverShoulder;

  public override onActivate(ctx: CameraModeContext, tuning: CameraTuning): void {
    ctx.pitch = clampAngle(tuning.overShoulderPitch, tuning.minPitch, tuning.maxPitch);
    super.onActivate(ctx, overShoulderFraming(tuning));
  }

  public override update(ctx: CameraModeContext, tuning: CameraTuning, deltaTime: number): CameraModeResult {
    return super.update(ctx, overShoulderFraming(tuning), deltaTime);
  }
}

/** The tuning with the over-the-shoulder orbit in place of ThirdPerson's. */
export function overShoulderFraming(tuning: CameraTuning): CameraTuning {
  return {
    ...tuning,
    targetDistance: tuning.overShoulderDistance,
    shoulderHeight: tuning.overShoulderHeight,
    shoulderOffset: tuning.overShoulderOffset,
  };
}
