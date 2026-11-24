/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v28

import {
    component,
    subscribe,
    type Entity,
    ExecuteOn,
    OnWorldUpdateEvent,
    ActorBodyDirectionControllerTypeId,
    type ActorBodyDirectionController,
    type ActorBodyDirectionParams,
} from 'meta/worlds';

import {ActorControllerComponent} from '../ActorControllerComponent';
import {AutoFaceRotationAbility} from '../../../Character/Abilities/AutoFaceRotationAbility';

/**
 * Ticks a command survives without being renewed. Two rather than one so a frame in which this
 * component ticks before the behaviour manager does not drop a command that is still current.
 */
const leaseTicks: number = 2;

/**
 * Lets a behaviour turn a body through arbitration by driving `AutoFaceRotationAbility`'s
 * facing override, the same slot auto-targeting uses. The ability stays the only writer of
 * `worldRotation`, and faces the movement direction again whenever no override is held.
 *
 * WHY A LEASE. The behaviour manager calls only the arbitration winner and never tells a loser
 * it lost, and the override holds until cleared. A behaviour that stops winning would otherwise
 * keep the body pinned to its last heading for good. Every turning behaviour re-issues
 * `rotateBodyTo` each frame it wins, so an override that is not renewed is released.
 */
@component({
    description:
        'Exposes a body\'s facing to the Actor Framework through AutoFaceRotationAbility, which stays the only writer of the body rotation.',
})
export class ActorFacingController
    extends ActorControllerComponent
    implements ActorBodyDirectionController
{
    private facing: AutoFaceRotationAbility | null = null;
    private holdingOverride: boolean = false;
    private ticksSinceCommand: number = 0;

    protected override onResolveDependencies(): void {
        this.facing = this.entity.getComponent(AutoFaceRotationAbility);
    }

    protected override getControllerTypeIds(): readonly string[] {
        return [ActorBodyDirectionControllerTypeId];
    }

    /**
     * Whether an adapter on `entity` can register. ActorTransformMoveComponent yields body
     * direction on the same condition, so the axis is never left with no controller.
     */
    static canServe(entity: Entity): boolean {
        return entity.getComponent(AutoFaceRotationAbility) != null;
    }

    protected override canRegisterController(): boolean {
        return ActorFacingController.canServe(this.entity);
    }

    override unregisterActorController(): void {
        super.unregisterActorController();
        this.releaseOverride();
    }

    @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
    onActorFacingLeaseTick(): void {
        if (!this.holdingOverride) {
            return;
        }
        this.ticksSinceCommand++;
        if (this.ticksSinceCommand > leaseTicks) {
            this.releaseOverride();
        }
    }

    private releaseOverride(): void {
        if (!this.holdingOverride) {
            return;
        }
        this.holdingOverride = false;
        this.facing?.setFacingOverride(null);
    }

    //// ActorBodyDirectionController
    rotateBodyTo(params: ActorBodyDirectionParams): void {
        if (this.facing == null) {
            return;
        }
        this.facing.setFacingOverride(params.desiredBodyDirection, params.angularSpeed);
        this.holdingOverride = true;
        this.ticksSinceCommand = 0;
    }

    stopRotation(): void {
        this.releaseOverride();
    }
}
