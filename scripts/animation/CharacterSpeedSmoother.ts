/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v5

import {Vec3} from 'meta/worlds';

const SMOOTHING_FRAME_COUNT = 10;
const MAX_SPEED = 10;
const VELOCITY_EPSILON = 1e-5;

/** Fixed-window velocity average for remote transform replication jitter. */
export class CharacterSpeedSmoother {
  private readonly samples: Vec3[] = new Array<Vec3>(SMOOTHING_FRAME_COUNT).fill(Vec3.zero);
  private index: number = 0;
  private sum: Vec3 = Vec3.zero;
  private smoothed: Vec3 = Vec3.zero;

  public update(sampledVelocity: Vec3): void {
    this.sum = this.sum.sub(this.samples[this.index]).add(sampledVelocity);
    this.samples[this.index] = sampledVelocity;
    this.index = (this.index + 1) % this.samples.length;

    const mean = this.sum.mul(1 / this.samples.length);
    const magnitude = mean.magnitude();
    this.smoothed =
      magnitude < VELOCITY_EPSILON
        ? Vec3.zero
        : magnitude > MAX_SPEED
          ? mean.normalize().mul(MAX_SPEED)
          : mean;
  }

  public get averagedVelocity(): Vec3 {
    return this.smoothed;
  }
}
