/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v9

/** Eye-level view driven entirely by look input. */

import {MeshComponent, Vec3} from 'meta/worlds';
import {CharacterAnimationController} from '../../animation/CharacterAnimationController';
import {FirstPersonBodyVisibility} from '../FirstPersonBodyVisibility';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  clampAngle,
  yawPitchRotation,
} from '../CameraModeTypes';

export class FirstPersonMode implements ICameraMode {
  public readonly type = CameraModeType.FirstPerson;

  public eyeHeight: number = 1.7;

  private readonly bodyVisibility = new FirstPersonBodyVisibility();
  private warnedNetworkedBody = false;

  public onActivate(ctx: CameraModeContext, tuning: CameraTuning): void {
    this.updateBodyVisibility(ctx);
    ctx.pitch = clampAngle(ctx.pitch, tuning.minPitch, tuning.maxPitch);
  }
  public onDeactivate(): void {
    this.bodyVisibility.restore();
    this.warnedNetworkedBody = false;
  }

  public retryBodyRestoration(): void {
    this.bodyVisibility.retryRestores();
  }

  private updateBodyVisibility(ctx: CameraModeContext): void {
    const body = ctx.targetEntity.getComponent(CharacterAnimationController)?.animatorEntity;
    const mesh = body && !body.isDestroyed() ? body.getComponent(MeshComponent) : null;
    if (!this.bodyVisibility.hide(mesh) && mesh?.entity.networked && !this.warnedNetworkedBody) {
      console.warn('[FirstPersonMode] Body mesh is networked; a client-local visibility API is required to hide it safely.');
      this.warnedNetworkedBody = true;
    }
  }

  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    _deltaTime: number,
  ): CameraModeResult {
    this.updateBodyVisibility(ctx);
    ctx.yaw += ctx.lookDeltaYaw;
    ctx.pitch = clampAngle(
      ctx.pitch + ctx.lookDeltaPitch,
      tuning.minPitch,
      tuning.maxPitch,
    );

    const playerPos = ctx.targetTransform.worldPosition;
    return {
      position: new Vec3(
        playerPos.x,
        playerPos.y + this.eyeHeight,
        playerPos.z,
      ),
      rotation: yawPitchRotation(ctx.yaw, ctx.pitch),
    };
  }
}
