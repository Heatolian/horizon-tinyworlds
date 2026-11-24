/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v28

import type {ActorController, Vec3} from 'meta/worlds';

/**
 * Optional extension for a body that can dodge roll.
 *
 * Registered under `ActorMovementControllerTypeId`, for the reason `IActorJump` gives: a roll
 * is locomotion, so the behaviour that wins the movement axis owns it, and a DeathBehavior
 * winning movement also stops a corpse rolling. The cost is the same too: a behaviour that only
 * wants to dodge takes over steering for that frame.
 *
 * A body that cannot dodge does not implement this; feature-detect with
 * `controller as Partial<IActorDodge>` and a `typeof` check, as for `IActorJump`.
 */
export interface IActorDodge extends ActorController {
    /**
     * Request a roll along `worldDirection` (flattened), or along the body's facing when null.
     * Returns whether the roll started. Permission, cooldown and the roll itself are the
     * body's, and unlike `IActorJump` nothing is buffered: a refused request is dropped, and
     * the caller may request again on a later frame.
     */
    requestDodge(worldDirection: Vec3 | null): boolean;

    /**
     * True while a roll is under way and has not yet handed movement back (its blend-out).
     *
     * The roll moves the body by script and does not stop the other movers sharing the movement
     * axis: `ActorTransformMoveComponent` keeps walking to its last target. While this is true,
     * the caller should keep claiming the movement axis and call `stopMovement()` on those
     * movers. That hold lasts only while the caller wins arbitration: the roll runs to its end
     * regardless, so a higher-priority behaviour that takes the axis mid-roll and walks stacks
     * its walk on the roll.
     */
    isDodging(): boolean;
}
