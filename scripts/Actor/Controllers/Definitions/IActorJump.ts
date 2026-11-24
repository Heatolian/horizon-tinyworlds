/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v6

import type {ActorController} from 'meta/worlds';

/**
 * Optional extension for a body that can jump.
 *
 * Lives here beside `IActorStaggerImpulseReceiver` and the other world-local extension
 * interfaces, which is the established home for a behaviour-specific contract that is not
 * yet proven across packages.
 *
 * WHY THIS IS NOT ITS OWN CONTROLLER TYPE ID. Jump is locomotion on the vertical axis,
 * so it registers under `ActorMovementControllerTypeId` with the horizontal methods and
 * one arbitration winner owns both. Give jump its own type id and the two axes arbitrate
 * independently: a DeathBehavior winning movement at priority 1000 would stop the body
 * walking while a lower-priority behavior still won jump — the corpse jumps.
 *
 * The cost of that choice, accepted deliberately: a behavior that wants only to jump must
 * win the whole locomotion axis, so it takes over steering for that frame.
 *
 * A body that cannot jump — a turret, a rail-mounted puppet — simply does not implement
 * this, and a behavior feature-detecting it finds nothing. Capability presence is
 * expressed by what is registered, never by a no-op method.
 *
 * IMPLEMENTING ALONGSIDE A MOVER. Two controllers registered under one type id are both
 * driven by the same winning behavior in the same frame (winner-drives-all), so their
 * method sets must be disjoint. A jump implementation registered beside a separate
 * movement implementation is fine; two things that both implement `moveToPosition` are
 * not — the body would move twice per frame.
 */
export interface IActorJump extends ActorController {
    /**
     * Request a jump. Implementations own their own buffering, coyote time and cooldown,
     * so a request that cannot be honoured immediately may still be honoured shortly
     * after — callers must not implement their own retry.
     */
    requestJump(): void;

    /**
     * Cut a jump short — the variable-height idiom, called on input release. A no-op if
     * no jump is in flight.
     */
    abortJump(): void;
}

// NOTE: no `supportsJump()` type guard is exported. The SDK .d.ts generator flattens a type
// predicate to plain `boolean`, so such a guard does not narrow for a consumer reading the
// kit bundle. Feature-detect with `controller as Partial<IActorJump>` plus a `typeof` check,
// exactly as StaggerBehavior does for IActorStaggerImpulseReceiver.

// NOTE: no advisory `canJump()` either. These two methods are the whole contract because they
// are the whole of the player's input path — press and release, nothing else (see
// PlayerActionController's jump binding). An earlier revision carried a `canJump()`; it had no
// caller, and backing it meant adding a query to the state machine and another to the ability,
// which is exactly the ability-layer churn this design exists to avoid. Add it back with the
// first behaviour that genuinely must ask before committing.
