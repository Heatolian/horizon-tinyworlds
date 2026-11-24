/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {
    ActorHealthControllerTypeId,
    type ActorHealthController,
} from "meta/worlds";
import { ActorCollisionControllerTypeId, type ActorCollisionController, ActorCollisionParams } from "meta/worlds";
import { ActorMovementControllerTypeId, ActorMoveParams, type ActorMovementController } from "meta/worlds";
import { ActorPickupItemControllerTypeId, type ActorPickupItemController, ActorRequestDropData, PickupItemSlot } from "meta/worlds";
import { ActorBehavior } from "meta/worlds";
import type { ActorController } from "meta/worlds";
import { ActorDeathReader } from "../../Utilities/ActorDeathReader";

/**
 * GUARD: claims axes while the actor is dead; owns no state.
 *
 * Behavior that takes over all controllers when the actor dies and can disable
 * collision on death.
 *
 * Death is the GAS `state.dead` tag on the actor's CharacterGASComponent. An
 * actor authored without one falls back to polling its ActorHealthController.
 */
export class DeathBehavior extends ActorBehavior {
    /**
     * If true, disables collision on death.
     * WARNING: This removes ground support and may cause the entity to sink.
     * Only enable if you want the entity to fall through the floor on death.
     */
    disableCollisionOnDeath: boolean = false;

    /** If true, drops all held items (both hands) when the actor dies. */
    dropItemsOnDeath: boolean = false;

    /**
     * Priority used when dead. Must be higher than all other behaviors to ensure
     * the dead actor stops moving, attacking, and animating.
     */
    private static readonly deadPriority = 1000;

    private isDead: boolean = false;
    private itemsDropped: boolean = false;
    private readonly deathReader = new ActorDeathReader();

    update(_deltaTime: number): void {
        if (!this.isDead) {
            this.isDead = this.detectDeath();
        }
    }

    private detectDeath(): boolean {
        return this.deathReader.read(
            this.behaviorManager ? this.getEntity() : null,
            this.behaviorManager?.getControllers<ActorHealthController>(ActorHealthControllerTypeId),
        );
    }

    override getControllerUsePriority(controllerType: string): number {
        if (this.isDead) {
            // Only claim the pickup controller if we need to drop items and haven't yet.
            // Once items are dropped (or dropItemsOnDeath is false), return -1 to release
            // the controller — no other behavior should need it post-death, but releasing
            // it keeps the priority model clean and avoids silently blocking cleanup behaviors.
            if (controllerType == ActorPickupItemControllerTypeId) {
                if (!this.dropItemsOnDeath || this.itemsDropped) {
                    return -1;
                }
            }
            return DeathBehavior.deadPriority;
        }

        return super.getControllerUsePriority(controllerType);
    }

    override useController(controllerType: string, controller: ActorController): void {
        if (controllerType == ActorCollisionControllerTypeId && this.disableCollisionOnDeath) {
            const params = new ActorCollisionParams();
            params.collisionEnabled = false;
            (controller as ActorCollisionController).setCollisionParams(params);
        }

        // Stop movement when dead — zero velocity prevents sliding/drifting
        if (controllerType == ActorMovementControllerTypeId) {
            (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
        }

        if (controllerType == ActorPickupItemControllerTypeId && this.isDead && this.dropItemsOnDeath && !this.itemsDropped) {
            const pickupController = controller as ActorPickupItemController;
            pickupController.dropItem(new ActorRequestDropData(PickupItemSlot.RightHand));
            pickupController.dropItem(new ActorRequestDropData(PickupItemSlot.LeftHand));
            this.itemsDropped = true;
        }
    }
}
