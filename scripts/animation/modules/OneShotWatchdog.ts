/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v6

import type {AnimationContext} from './AnimationModule';

const GRACE_SEC = 1.0;
export const UNRESOLVED_CLIP_CAUSE = 'its clip is unresolved or not retargeted to this skeleton';

/**
 * Returns a layer to its rest state when a one-shot state outlives its expected duration.
 *
 * One-shot layer states leave on `__state_finished`. A clip that failed to resolve or was
 * skipped as skeleton-incompatible plays nothing, so on an override layer the state composites
 * the bind pose — and if it never finishes, the character holds that T-pose (upper body on a
 * masked layer) until something else transitions the layer. This bounds it to one action.
 *
 * Elapsed time is counted from frame deltas, not wall-clock time, so a paused or stalled
 * world does not cut a clip that has not advanced.
 */
export class OneShotWatchdog {
  private armed: boolean = false;
  private remainingSec: number = 0;
  private stateName: string = '';
  private likelyCause: string = UNRESOLVED_CLIP_CAUSE;
  private warned: boolean = false;

  constructor(
    private readonly owner: string,
    private readonly layerName: string,
    private readonly restState: string,
  ) {}

  arm(
    stateName: string,
    expectedDurationSec: number,
    likelyCause: string = UNRESOLVED_CLIP_CAUSE,
  ): void {
    this.armed = true;
    this.stateName = stateName;
    this.likelyCause = likelyCause;
    this.remainingSec = Math.max(0, expectedDurationSec) + GRACE_SEC;
  }

  disarm(): void {
    this.armed = false;
  }

  tick(context: AnimationContext, deltaTime: number): void {
    if (!this.armed) {
      return;
    }
    this.remainingSec -= Math.max(0, deltaTime);
    if (this.remainingSec > 0) {
      return;
    }
    const current = context.currentState(this.layerName);
    // An unreadable state is re-checked each frame for one more grace window, so a transient
    // read failure does not reset a layer that finished on its own; past that it counts as stuck.
    if (current === null && this.remainingSec > -GRACE_SEC) {
      return;
    }
    this.armed = false;
    if (current !== null && current !== this.stateName) {
      return;
    }
    if (!this.warned) {
      this.warned = true;
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- latched to fire at most once per layer
      console.warn(
        `[${this.owner}] '${this.layerName}' is still in '${this.stateName}' past its expected duration; returning it to '${this.restState}'. Likely cause: ${this.likelyCause}.`,
      );
    }
    context.playState(this.layerName, this.restState);
  }
}
