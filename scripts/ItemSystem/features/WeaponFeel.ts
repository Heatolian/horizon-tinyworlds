/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v2

/** How the camera kicks when a player fires (`WeaponConfig.recoil`). */
export interface RecoilConfig {
  /** Degrees the camera kicks up per shot. */
  pitchDeg: number;
  /** Most degrees each shot also kicks left or right, at random. Default 0. */
  yawDeg?: number;
  /** Degrees per second the kick settles back afterwards. Default 10. */
  recoverDegPerSec?: number;
}

/** How spread grows while a player fires (`WeaponConfig.bloom`). Added to the delivery's own `spreadDeg`. */
export interface BloomConfig {
  /** Degrees of spread at rest. Default 0. */
  baseDeg?: number;
  /** Degrees each shot adds. */
  perShotDeg: number;
  /** Most degrees the shots can add. */
  maxDeg: number;
  /** Degrees per second the added spread recovers. */
  recoverDegPerSec: number;
  /** Degrees added at the holder's full movement speed, in proportion to its speed. Default 0. */
  movingDeg?: number;
  /** Multiplies the whole spread while steadied (a scoped weapon aimed). Default 1. */
  steadyFactor?: number;
}

/** A weapon's spread right now: rest, plus what the last shots added, plus moving, times steadied. */
export class Bloom {
  private heat = 0;

  constructor(private readonly config: BloomConfig) {}

  shot(): void {
    this.heat = Math.min(this.config.maxDeg, this.heat + this.config.perShotDeg);
  }

  /** Recovers `dt` seconds' worth of the added spread. */
  tick(dt: number): void {
    this.heat = Math.max(0, this.heat - this.config.recoverDegPerSec * Math.max(0, dt));
  }

  /** `movement` is the holder's speed as a fraction of its full speed, 0 to 1. */
  spreadDeg(movement: number, steadied: boolean): number {
    const {config} = this;
    const spread = (config.baseDeg ?? 0) + this.heat + Math.max(0, Math.min(1, movement)) * (config.movingDeg ?? 0);
    return steadied ? spread * (config.steadyFactor ?? 1) : spread;
  }
}

/** The camera kick still to settle, in degrees; the camera follows its deltas. */
export class Recoil {
  private pitchOwed = 0;

  constructor(
    private readonly config: RecoilConfig,
    private readonly random: () => number = Math.random,
  ) {}

  /** One shot: the yaw and pitch to kick the camera by now. */
  kick(): {yaw: number; pitch: number} {
    const {config} = this;
    this.pitchOwed += config.pitchDeg;
    return {yaw: (this.random() * 2 - 1) * (config.yawDeg ?? 0), pitch: config.pitchDeg};
  }

  /** The pitch to bring the camera back by this frame (negative: down), never past where it started. */
  recover(dt: number): number {
    const step = Math.min(this.pitchOwed, (this.config.recoverDegPerSec ?? 10) * Math.max(0, dt));
    this.pitchOwed -= step;
    return -step;
  }
}
