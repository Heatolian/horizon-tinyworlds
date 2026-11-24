/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
    component,
    ActorMovementControllerTypeId,
    type ActorMovementController,
    type ActorMoveParams,
} from 'meta/worlds';

import {ActorControllerComponent} from '../ActorControllerComponent';
import type {IActorJump} from '../Definitions/IActorJump';
import type {IActorMovementOccupant} from '../Definitions/IActorMovementOccupant';
import {CharacterStateMachine} from '../../../Character/State/CharacterStateMachine';
import {JumpAbility} from '../../../Character/Abilities/JumpAbility';

/**
 * Lets a behaviour jump a body through arbitration, by entering jump the same way player input
 * does: `CharacterStateMachine.handleJumpClick()` / `handleJumpRelease()`.
 *
 * WHY AN ADAPTER RATHER THAN `JumpAbility implements IActorJump`. An ability must not know
 * whether an actor behaviour or player input is driving it. Commanding the ability directly also
 * desynchronises it from the state machine that drives it: a self-activated jump trips the
 * `Movement -> Jumping` rule, `transitionTo()` skips `canEnter`, and `onEnter` activates a second
 * time. Measured in world at four `JumpStartedEvent` raises per jump, which is what made an NPC
 * jump look jerky. The player never saw it because `requestStateChange()` lets the state machine
 * drive rather than follow.
 *
 * No initialization gate is needed, unlike the direct implementation this replaces. Before
 * `CharacterUpdateManager` has initialized the character, `handleJumpClick()` is inert on its own
 * terms: `this.jump?.recordInput()` is null-safe and `requestStateChange('Jumping')` finds no
 * registered state and returns false.
 */
@component({
    description:
        'Exposes a body\'s jump to the Actor Framework by driving CharacterStateMachine, the same seam player input uses.',
})
export class ActorJumpController
    extends ActorControllerComponent
    implements IActorJump, ActorMovementController, IActorMovementOccupant
{
    private stateMachine: CharacterStateMachine | null = null;
    private jumpAbility: JumpAbility | null = null;

    protected override onResolveDependencies(): void {
        this.stateMachine = this.entity.getComponent(CharacterStateMachine);
        this.jumpAbility = this.entity.getComponent(JumpAbility);
    }

    /**
     * Registered under the MOVEMENT type id, not one of its own: jump is locomotion on the
     * vertical axis, so one arbitration winner must own both axes. A separate id would let a
     * DeathBehavior win movement and stop the body walking while a lower-priority behaviour
     * still won jump — the corpse jumps.
     */
    protected override getControllerTypeIds(): readonly string[] {
        return [ActorMovementControllerTypeId];
    }

    /**
     * Capability presence is expressed by what is registered, never by a no-op method. Without
     * this veto a body with no jump would still register, `requestJump` would feature-detect
     * successfully, and the behaviour would believe it jumped a body that cannot.
     */
    protected override canRegisterController(): boolean {
        return this.stateMachine != null && this.jumpAbility != null;
    }

    //// IActorJump
    requestJump(): void {
        this.stateMachine?.handleJumpClick();
    }

    abortJump(): void {
        this.stateMachine?.handleJumpRelease();
    }

    //// ActorMovementController — inert, and required.
    // Sharing the movement type id means winner-drives-all hands the winning behaviour every
    // controller in the bucket, and all five mover-driving behaviours (Goto, Lead,
    // AttackEntityInRange, Stagger, Death) do `(controller as ActorMovementController)
    // .moveToPosition(...)` with no feature check. Without these the cast throws the first time
    // any of them wins the axis. The `implements` clause makes deleting one a compile error.
    // Inert is the point: the real mover in the same bucket does the moving.

    /**
     * Occupies the locomotion bucket WITHOUT being able to move the body.
     * `BehaviorStarterComponent` warns when a locomotion behaviour is seeded onto an actor with
     * no mover and detects that by counting controllers under `ActorMovementControllerTypeId` —
     * a count this inflates. Without the opt-out, a jump-only actor that genuinely cannot walk
     * looks correctly configured and the warning goes silent.
     */
    public readonly providesLocomotion = false as const;

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    moveToPosition(_params: ActorMoveParams): void {}

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stopMovement(): void {}
}
