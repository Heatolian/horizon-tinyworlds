/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
    component,
    ActorMovementControllerTypeId,
    type ActorMovementController,
    type ActorMoveParams,
    type Vec3,
} from 'meta/worlds';

import {ActorControllerComponent} from '../ActorControllerComponent';
import type {IActorDodge} from '../Definitions/IActorDodge';
import type {IActorMovementOccupant} from '../Definitions/IActorMovementOccupant';
import {DodgeRollAbility} from '../../../Character/Abilities/DodgeRollAbility';
import {GASComponent} from '../../../gas/core/GASComponent';

/**
 * Lets a behaviour dodge a body through arbitration by starting DodgeRollAbility's roll, the
 * call the dodge button makes. The roll, its GAS permission and its cooldown are the ability's.
 */
@component({
    description:
        'Exposes a body\'s dodge roll to the Actor Framework by starting DodgeRollAbility, the call the dodge button makes.',
})
export class ActorDodgeController
    extends ActorControllerComponent
    implements IActorDodge, ActorMovementController, IActorMovementOccupant
{
    private dodgeAbility: DodgeRollAbility | null = null;
    private hasGas: boolean = false;

    protected override onResolveDependencies(): void {
        this.dodgeAbility = this.entity.getComponent(DodgeRollAbility);
        this.hasGas = this.entity.getComponent(GASComponent) != null;
    }

    protected override getControllerTypeIds(): readonly string[] {
        return [ActorMovementControllerTypeId];
    }

    protected override canRegisterController(): boolean {
        // DodgeRollAbility refuses every roll on a body without GAS.
        return this.dodgeAbility != null && this.hasGas;
    }

    //// IActorDodge
    requestDodge(worldDirection: Vec3 | null): boolean {
        return this.dodgeAbility?.activate(worldDirection ?? undefined) ?? false;
    }

    isDodging(): boolean {
        return !(this.dodgeAbility?.hasReleasedMovement() ?? true);
    }

    //// ActorMovementController — inert, and required; see ActorJumpController.

    /** Occupies the locomotion bucket without moving the body; see ActorJumpController. */
    public readonly providesLocomotion = false as const;

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    moveToPosition(_params: ActorMoveParams): void {}

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stopMovement(): void {}
}
