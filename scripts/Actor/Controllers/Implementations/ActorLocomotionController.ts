/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
    component,
    subscribe,
    ExecuteOn,
    OnNavMeshLinkEnterEvent,
    OnNavMeshLinkExitEvent,
    OnWorldUpdateEvent,
    TransformComponent,
    type OnNavMeshLinkEnterEventPayload,
    Vec3,
    ActorMovementControllerTypeId,
    type ActorMovementController,
    type ActorMoveParams,
    type ActorPathSegment,
    type Entity,
} from 'meta/worlds';

import {ActorControllerComponent} from '../ActorControllerComponent';
import {MovementAbility} from '../../../Character/Abilities/MovementAbility';
import {ActorNavMeshAgentDriver, ActorNavMeshMoveParams} from './ActorNavMeshAgentDriver';

/** Ticks a command survives without being renewed; see ActorFacingController. */
const leaseTicks: number = 2;

/** Within this horizontal distance of the target the body is given no input. */
const arrivalEpsilon: number = 0.05;

/**
 * Approach speed per metre of remaining path (1/s). Caps speed near the end of the path so the
 * body slows into it rather than coasting past on MovementAbility's stop damping.
 */
const approachGain: number = 4.0;

/**
 * Smallest input fraction sent while still short of the target. `LocomotionSolver` treats input
 * at or below 0.1 as none, so anything smaller would stall the body short of the target.
 */
const minInputFraction: number = 0.12;

/**
 * Lets a behaviour walk a body through arbitration by feeding `MovementAbility` a world-space
 * input (`setWorldInput`), the counterpart of the player's stick. Acceleration, slopes and forces
 * are the ability's, so an NPC walks by the player's rules. It never calls CharacterStateMachine,
 * which the character team treats as legacy; a dead body is held by DeathBehavior winning the
 * movement axis.
 *
 * A behaviour commands a target position and a speed; the ability takes a direction and a
 * deflection. This adapter converts one to the other every tick: the direction to the target,
 * and `desiredSpeed / moveSpeed` as the deflection, so a speed above `moveSpeed` is clamped to
 * it. Arrival stays the behaviour's decision (GotoBehavior's stop distance); the adapter only
 * slows into the target and gives no input once within `arrivalEpsilon`.
 *
 * WHY A LEASE: see ActorFacingController. The last command lapses after `leaseTicks` without
 * renewal, where ActorTransformMoveComponent kept walking to it after its behaviour lost.
 */
@component({
    description:
        'Walks a body for the Actor Framework by feeding MovementAbility a world-space input, the counterpart of the player stick.',
})
export class ActorLocomotionController
    extends ActorControllerComponent
    implements ActorMovementController
{
    private movement: MovementAbility | null = null;
    private transform: TransformComponent | null = null;

    private target: Vec3 | null = null;
    /** Path length beyond `target`, so the approach cap brakes for the path's end, not corners. */
    private pathBeyondTarget: number = 0;
    private desiredSpeed: number = 0;
    private isSteeringTarget: boolean = false;
    private ticksSinceCommand: number = 0;
    private inputActive: boolean = false;

    protected override onResolveDependencies(): void {
        this.movement = this.entity.getComponent(MovementAbility);
        this.transform = this.entity.getComponent(TransformComponent);
    }

    protected override getControllerTypeIds(): readonly string[] {
        return [ActorMovementControllerTypeId];
    }

    /**
     * Whether an adapter on `entity` can register. ActorTransformMoveComponent yields the
     * movement axis on the same condition, so the body is never left with no mover.
     */
    static canServe(entity: Entity): boolean {
        return entity.getComponent(MovementAbility) != null;
    }

    protected override canRegisterController(): boolean {
        return ActorLocomotionController.canServe(this.entity);
    }

    override unregisterActorController(): void {
        super.unregisterActorController();
        this.stopMovement();
    }

    @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
    onActorLocomotionLeaseTick(payload?: {deltaTime: number}): void {
        if (this.movement == null) {
            return;
        }
        const driver = ActorNavMeshAgentDriver.forEntity(this.entity);
        if (driver.agent != null) {
            const position = this.currentPosition();
            if (position != null) {
                driver.update(payload?.deltaTime ?? 0, position);
                const linkTarget = driver.linkTarget;
                if (linkTarget != null) {
                    this.hold();
                    this.movement?.placeBody(linkTarget);
                    return;
                }
                if (this.isSteeringTarget && driver.shouldHoldSteering) {
                    this.hold();
                }
            }
        }
        if (this.target == null) {
            return;
        }
        this.ticksSinceCommand++;
        if (this.ticksSinceCommand > leaseTicks) {
            this.hold();
            return;
        }
        this.steer();
    }

    @subscribe(OnNavMeshLinkEnterEvent, {execution: ExecuteOn.Owner})
    onActorLocomotionLinkEnter(payload: OnNavMeshLinkEnterEventPayload): void {
        if (this.movement == null) {
            return;
        }
        const position = this.currentPosition();
        if (position != null) {
            const bodyOriginOffset = this.movement.getBodyOriginHeightOffset();
            if (bodyOriginOffset == null) {
                console.warn('Cannot cross NavMesh link: character capsule pose or world scale is unavailable.');
                return;
            }
            ActorNavMeshAgentDriver.forEntity(this.entity).enterLink(
                payload.areaType,
                payload.linkStartPosition,
                payload.linkEndPosition,
                {position, originOffset: bodyOriginOffset},
            );
        }
    }

    @subscribe(OnNavMeshLinkExitEvent, {execution: ExecuteOn.Owner})
    onActorLocomotionLinkExit(): void {
        if (this.movement != null) {
            ActorNavMeshAgentDriver.forEntity(this.entity).exitLink();
        }
    }

    /** The body MovementAbility moves, so steering and locomotion agree on where it is. */
    private currentPosition(): Vec3 | null {
        return this.movement?.getBodyPosition() ?? this.transform?.worldPosition ?? null;
    }

    private steer(): void {
        const target = this.target;
        const position = this.currentPosition();
        const movement = this.movement;
        if (target == null || position == null || movement == null) {
            return;
        }
        const dx = target.x - position.x;
        const dz = target.z - position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const moveSpeed = movement.moveSpeed * movement.getSpeedMultiplier();
        if (distance <= (this.isSteeringTarget ? 1e-6 : arrivalEpsilon) || moveSpeed <= 0) {
            this.sendInput(Vec3.zero);
            return;
        }
        const approachSpeed = this.isSteeringTarget
            ? this.desiredSpeed
            : Math.min(this.desiredSpeed, (distance + this.pathBeyondTarget) * approachGain);
        const fraction = this.isSteeringTarget
            ? Math.min(1, approachSpeed / moveSpeed)
            : Math.min(1, Math.max(minInputFraction, approachSpeed / moveSpeed));
        // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- Vec3 is immutable; the input changes every tick the body moves.
        this.sendInput(new Vec3((dx / distance) * fraction, 0, (dz / distance) * fraction));
    }

    private sendInput(input: Vec3): void {
        this.movement?.setWorldInput(input);
        this.inputActive = input.x !== 0 || input.z !== 0;
    }

    /** Stop driving: drop the target and, if this adapter was moving the body, zero its input. */
    private hold(): void {
        this.target = null;
        this.pathBeyondTarget = 0;
        this.desiredSpeed = 0;
        if (this.inputActive) {
            this.sendInput(Vec3.zero);
        }
    }

    //// ActorMovementController
    moveToPosition(params: ActorMoveParams): void {
        if (this.movement == null) {
            return;
        }
        if (!(params instanceof ActorNavMeshMoveParams)) {
            const position = this.currentPosition();
            if (position != null) {
                ActorNavMeshAgentDriver.forEntity(this.entity).stop(position);
            }
        }
        this.isSteeringTarget = params instanceof ActorNavMeshMoveParams;
        // A null speed holds the body in place, as it did on ActorTransformMoveComponent
        // (LeadBehavior holds with `moveToPosition(currentPos, null)`).
        if (params.desiredPosition == null || params.desiredSpeed == null || params.desiredSpeed <= 0) {
            this.hold();
            return;
        }
        this.target = params.desiredPosition;
        this.pathBeyondTarget = ActorLocomotionController.pathLengthBeyond(
            params.desiredPosition,
            params.desiredPath,
        );
        this.desiredSpeed = params.desiredSpeed;
        this.ticksSinceCommand = 0;
        this.steer();
    }

    stopMovement(): void {
        if (this.movement != null) {
            const driver = ActorNavMeshAgentDriver.forEntity(this.entity);
            if (driver.agent != null) {
                const position = this.currentPosition();
                if (position != null) {
                    driver.stop(position);
                }
            }
        }
        this.hold();
    }

    /**
     * Horizontal length of `path` after the first point at `target`. GotoBehavior sends the path
     * from the waypoint it is steering toward to the end; with no path, or a target not on it,
     * the target is treated as the end.
     */
    private static pathLengthBeyond(target: Vec3, path: ActorPathSegment[] | null): number {
        if (path == null) {
            return 0;
        }
        const start = path.findIndex(
            (segment) =>
                Math.abs(segment.position.x - target.x) < 0.001 &&
                Math.abs(segment.position.z - target.z) < 0.001,
        );
        if (start < 0) {
            return 0;
        }
        let length = 0;
        for (let i = start; i + 1 < path.length; i++) {
            const dx = path[i + 1].position.x - path[i].position.x;
            const dz = path[i + 1].position.z - path[i].position.z;
            length += Math.sqrt(dx * dx + dz * dz);
        }
        return length;
    }
}
