/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v27

import {ActorBehavior, ActorMovementControllerTypeId} from 'meta/worlds';
import type {ActorBehaviorManager, ActorController} from 'meta/worlds';
import type {IActorJump} from '../../Controllers/Definitions/IActorJump';

/**
 * Jumps the actor on a fixed interval. The point of this behaviour is to make the
 * capability-merge work OBSERVABLE: before it, "a behaviour can now jump an actor" was
 * provable only by unit test, because nothing in the tree ever commanded a jump.
 *
 * It is deliberately trivial. It claims the locomotion axis at a LOW priority so any real
 * behaviour — combat, death, a possessing player — outranks it and the actor stops jumping,
 * which is itself the arbitration property worth seeing demonstrated.
 */
export class PeriodicJumpBehavior extends ActorBehavior {
  /** Seconds between jump attempts. */
  public interval: number = 3.0;

  /**
   * Low on purpose. This must lose to anything real; a demo that outranked combat would be
   * a bug generator rather than a demo.
   */
  public override basePriority: number = 1;

  public override name: string = 'PeriodicJumpBehavior';

  private elapsed: number = 0;
  private jumpRequested: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.elapsed = 0;
    this.jumpRequested = false;
  }

  override update(deltaTime: number): void {
    // An undelivered request is dropped here, not carried to the next frame. The manager runs
    // every update() and then applyControllers() within one frame, so a request raised here
    // gets exactly one full frame to be delivered. Carrying it further would pin the priority
    // claim below ON FOREVER for a body that can move but cannot jump: ActorJumpController
    // refuses to register without a JumpAbility, so useController() never sees a requestJump
    // to clear the latch on, and the claim would starve the priority-0 movers this gate exists
    // to protect. A fresh request follows one interval later.
    this.jumpRequested = false;
    this.elapsed += deltaTime;
    if (this.elapsed >= this.interval) {
      this.elapsed = 0;
      this.jumpRequested = true;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType !== ActorMovementControllerTypeId) {
      return -1;
    }
    // Claimed ONLY on a frame with a jump pending. Arbitration drops negative claims and
    // awards the axis to the single highest claimant, so a standing claim at 1 outranks every
    // movement behaviour sitting at 0 — the `ActorBehavior` class default, and the effective
    // movement priority of `SimpleFetchBehavior`, which delegates movement to a nested
    // `GotoBehavior` it never assigns one. A standing claim therefore stops such an actor
    // walking, silently: 1 vs 0 is not a tie, so nothing warns. `IActorJump` accepts losing
    // steering "for that frame", not for every frame.
    return this.jumpRequested ? this.basePriority : -1;
  }

  override useController(_controllerType: string, controller: ActorController): void {
    if (!this.jumpRequested) {
      return;
    }
    // Feature-detected: a body with no jump implementation registered simply is not
    // jumpable, and this must be a no-op rather than an error.
    //
    // Duck-typed rather than via the SDK's supportsJump() guard, deliberately. The SDK
    // .d.ts generator flattens a type predicate to plain `boolean`
    // (`supportsJump(controller: ActorController): boolean`), so the guard does not narrow
    // for a world-package consumer reading the kit bundle. This is the same idiom
    // StaggerBehavior uses for IActorStaggerImpulseReceiver, and for the same reason.
    const jumper = controller as Partial<IActorJump>;
    if (typeof jumper.requestJump === 'function') {
      jumper.requestJump();
      // Cleared only on a controller that could actually take it, so within one frame a
      // non-jumpable controller handed over first does not swallow the request. Across frames
      // the request is not held — update() drops an undelivered one.
      this.jumpRequested = false;
    }
  }
}
