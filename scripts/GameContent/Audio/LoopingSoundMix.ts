/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v4

export interface LoopingSoundOutput {
  playVolume: number;
  play(): void;
  stop(): void;
}

export function unitValue(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function approach(current: number, target: number, deltaTime: number, seconds: number): number {
  const dt = Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0;
  const step = Number.isFinite(seconds) && seconds > 0 ? dt / seconds : 1;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** A persistent loop whose volume can change without restarting playback. */
export class LoopingSoundMix {
  private volume = 0;
  private playing = false;

  constructor(private readonly sound: LoopingSoundOutput) {
    this.sound.playVolume = 0;
  }

  public update(target: number, deltaTime: number, fadeSeconds: number): void {
    this.volume = approach(this.volume, unitValue(target), deltaTime, fadeSeconds);
    this.sound.playVolume = this.volume;
    if (this.volume > 0 && !this.playing) {
      this.sound.play();
      this.playing = true;
    } else if (this.volume === 0 && this.playing) {
      this.sound.stop();
      this.playing = false;
    }
  }

  public stop(): void {
    if (this.playing) {
      this.sound.stop();
      this.playing = false;
    }
    this.volume = 0;
    this.sound.playVolume = 0;
  }
}
