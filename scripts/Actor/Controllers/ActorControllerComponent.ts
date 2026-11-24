/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v7

import {
    component,
    Component,
    ExecuteOn,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    OnOwnershipTransferEvent,
    subscribe,
    ActorSdkLogicComponent,
} from 'meta/worlds';
import type { ActorController } from 'meta/worlds';

/**
 * Base for components that expose a capability to the Actor Framework.
 *
 * WHY THIS LIVES IN THE WORLD PACKAGE, NOT `worlds_actor`. Both consumers are in this one
 * package — `ActorTransformMoveComponent` and `ActorJumpController`. `worlds_actor` is Durable
 * and other worlds vendor copies of it, so promote only once a SECOND package needs this, not
 * merely a second consumer; by then it may want to be a composable helper rather than a base
 * class.
 *
 * A capability whose ability cannot extend this — `JumpAbility` must stay an
 * `ICharacterInitializable`, and TypeScript is single-inheritance — is not a reason to
 * hand-roll the lifecycle. Write a thin adapter component that extends this and forwards into
 * the ability's control layer; `ActorJumpController` is the worked example.
 *
 * Every controller needs the same four things: resolve its dependencies, register
 * itself while this endpoint owns the actor, re-register when ownership moves, and
 * unregister on destroy. Hand-writing that per controller has already produced one
 * silent bug class four separate times, because the failure mode is invisible —
 * arbitration still picks a winner, the winner's useController() still runs, and it
 * simply drives nothing.
 *
 * WHY RESOLUTION AND REGISTRATION ARE SPLIT. OnEntityCreateEvent is one-shot and is
 * never re-dispatched. Only the `@subscribe` execution filters are re-resolved on
 * transfer. So resolution has to happen on EVERY endpoint (a future owner must already
 * hold its component references by the time it gains ownership), while registration —
 * and only registration — is gated on ownership and re-synced on transfer.
 *
 * Subclasses override `getControllerTypeIds()` and, if they need them,
 * `onResolveDependencies()` and `canRegisterController()`. They do NOT re-declare the
 * lifecycle handlers: `@subscribe` metadata is inherited from a `@component()` base
 * (`getEventHandlers` in ComponentUtils seeds its handler map from the base class),
 * and a subclass method of the SAME NAME replaces the base's subscription rather than
 * adding to it. The handlers here are therefore named distinctively so an ordinary
 * `onCreate` / `onDestroy` in a subclass cannot silently displace them.
 */
@component({
    description:
        'Base class for Actor Framework controllers. Owns dependency resolution, ownership-gated registration, and re-registration on ownership transfer.',
})
export class ActorControllerComponent extends Component implements ActorController {
    /** Resolved on every endpoint, not just the owner. Null if the entity has no ActorSdkLogicComponent. */
    protected actorLogicComponent: ActorSdkLogicComponent | null = null;

    /**
     * Registration re-runs on every ownership transfer, but an empty type-id list is a
     * property of the class rather than of the handoff, so the report is latched. Each
     * console.error prints an APP ERROR line, which smoketest fails a run on.
     */
    private reportedNoTypeIds: boolean = false;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onActorControllerCreate(): void {
        this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
        this.onResolveDependencies();
        this.syncControllerRegistration();
    }

    @subscribe(OnOwnershipTransferEvent, { execution: ExecuteOn.Everywhere })
    onActorControllerOwnershipTransfer(): void {
        this.syncControllerRegistration();
    }

    @subscribe(OnEntityDestroyEvent)
    onActorControllerDestroy(): void {
        this.unregisterActorController();
    }

    /**
     * Type ids this controller registers under. A controller may serve several.
     *
     * Two controllers registered under one type id are driven by the SAME winning
     * behavior in the same frame (winner-drives-all), so their method sets must be
     * disjoint — two movement controllers under the movement type id move the body
     * twice per frame.
     */
    protected getControllerTypeIds(): readonly string[] {
        return [];
    }

    /** Resolve components this controller needs. Runs on every endpoint. */
    protected onResolveDependencies(): void {
        // Default: nothing beyond the logic component the base already resolved.
    }

    /**
     * Veto registration despite owning the actor — for a controller whose own
     * dependencies are missing or misconfigured. Registering anyway would let
     * arbitration hand the actor to something that cannot drive it.
     */
    protected canRegisterController(): boolean {
        return true;
    }

    /** Idempotent: safe to call on any endpoint, at any point after create. */
    protected syncControllerRegistration(): void {
        if (!this.entity.isOwned() || !this.canRegisterController()) {
            this.unregisterActorController();
            return;
        }
        this.registerActorController();
    }

    registerActorController(): void {
        const logic = this.actorLogicComponent;
        if (logic == null) {
            return;
        }
        const typeIds = this.getControllerTypeIds();
        if (typeIds.length === 0) {
            if (!this.reportedNoTypeIds) {
                this.reportedNoTypeIds = true;
                // Owned, un-vetoed, and registering under nothing: arbitration will
                // still pick a winner and drive no controller, which is silent in-world.
                console.error(
                    `${this.constructor.name}: getControllerTypeIds() returned no type ids, so this controller registers under nothing and arbitration can never drive it. Override getControllerTypeIds().`,
                );
            }
            return;
        }
        for (const typeId of typeIds) {
            logic.registerController(typeId, this);
        }
    }

    unregisterActorController(): void {
        this.actorLogicComponent?.unregisterController(this);
    }
}
