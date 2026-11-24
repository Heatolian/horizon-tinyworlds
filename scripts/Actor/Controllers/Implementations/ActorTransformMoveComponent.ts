/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
    component,
    subscribe,
    property,
    editor,
    Vec3,
    TransformComponent,
    OnNavMeshLinkEnterEvent,
    OnNavMeshLinkExitEvent,
    OnWorldUpdateEvent,
    OnWorldUpdateEventPayload,
    type OnNavMeshLinkEnterEventPayload,
    ExecuteOn,
    Quaternion,
    type Entity,
    CharacterControllerBase,
} from 'meta/worlds';

import {ActorControllerComponent} from '../ActorControllerComponent';
import {ActorFacingController} from './ActorFacingController';
import {ActorLocomotionController} from './ActorLocomotionController';
import {characterCapsuleOriginOffset} from '../../../Character/Physics/WorldsGroundInfoComponent';
import {ActorNavMeshAgentDriver, ActorNavMeshMoveParams} from './ActorNavMeshAgentDriver';
import { ActorMovementControllerTypeId, type ActorMovementController, ActorMoveParams } from 'meta/worlds';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';

@component({
    description: 'Walks the actor and turns its body. Registers as the movement controller and the body-direction controller, except for an axis that an adapter on the same entity already serves.',
})
export class ActorTransformMoveComponent extends ActorControllerComponent implements ActorMovementController, ActorBodyDirectionController {
    @property()
    @editor({ description: 'Optional entity containing a KinematicCharacterComponent. If null, TransformComponent is set directly instead.' })
    kinematicCharacterEntity: Entity | null = null;

    transformComponent: TransformComponent | null = null;
    kcc: CharacterControllerBase | null = null;

    protected targetPosition: Vec3 | null = null;
    protected desiredSpeed: number = 0;
    private isSteeringTarget: boolean = false;

    protected targetRotation: Quaternion | null = null;
    protected wantedAngularSpeed: number = 0;

    /** When true, all movement and rotation updates are skipped and new commands are rejected. */
    public frozen: boolean = false;

    /**
     * Resolution runs on EVERY endpoint (see ActorControllerComponent), so a client that
     * gains ownership later already holds these references; only registration is gated on
     * ownership, and the base re-syncs it on OnOwnershipTransferEvent. Before that base
     * existed this was a one-shot ExecuteOn.Owner handler, which left any later owner
     * permanently unregistered — arbitration succeeded and drove nothing.
     */
    protected override onResolveDependencies(): void {
        this.transformComponent = this.entity.getComponent(TransformComponent);
        this.kcc = this.kinematicCharacterEntity?.getComponent(CharacterControllerBase) ?? null;
        this.facingAdapterPresent =
            this.entity.getComponent(ActorFacingController) != null &&
            ActorFacingController.canServe(this.entity);
        this.locomotionAdapterPresent =
            this.entity.getComponent(ActorLocomotionController) != null &&
            ActorLocomotionController.canServe(this.entity);
    }

    /**
     * An axis served by a dedicated adapter is left to it. Winner-drives-all hands the winning
     * behavior every controller in a bucket, so registering beside the adapter would give the
     * body two writers. An adapter that cannot register does not count, or the axis
     * would be left with no controller at all.
     */
    private facingAdapterPresent: boolean = false;
    private locomotionAdapterPresent: boolean = false;

    protected override getControllerTypeIds(): readonly string[] {
        const typeIds: string[] = [];
        if (!this.locomotionAdapterPresent) {
            typeIds.push(ActorMovementControllerTypeId);
        }
        if (!this.facingAdapterPresent) {
            typeIds.push(ActorBodyDirectionControllerTypeId);
        }
        return typeIds;
    }

    /**
     * Movement and rotation intent is per-ownership state. Registration now follows
     * ownership, so this endpoint can register again after a previous stint; resuming the
     * target captured under that stint would drive the body toward a destination no
     * behavior asked for this frame. The base calls this on ownership loss and on destroy.
     * Pooled reuse is NOT covered: pools park entities rather than destroy them, so neither
     * lifecycle event re-fires and a caller that recycles must clear intent itself.
     */
    override unregisterActorController(): void {
        super.unregisterActorController();
        this.stopMovement();
        this.stopRotation();
    }

    /** Latched per failure mode: the base re-checks on every transfer, but the
     * misconfiguration it reports is a property of the scene, not of the handoff. The two
     * modes send the reader to opposite remediations, so a single latch would let whichever
     * fired first permanently suppress the other. */
    private reportedKccFailure: 'missing' | 'ambiguous' | null = null;

    protected override canRegisterController(): boolean {
        // Both axes taken by adapters. Vetoed rather than registered under nothing, which the
        // base reports as an error.
        if (this.getControllerTypeIds().length === 0) {
            return false;
        }
        if (!this.kinematicCharacterEntity) {
            return true;
        }
        // The base re-checks this on every ownership transfer, but onResolveDependencies ran
        // once at create. A kcc that was not resolvable on THIS endpoint then would stay null
        // forever, so a later ownership gain would veto registration and report a scene
        // misconfiguration that is really a resolution-order miss — the same silent
        // drives-nothing state this component was migrated to escape. Re-resolve first.
        // WHY: the catch below cannot replace `valid`. getComponent() returns a STALE
        // component off componentCache on a destroyed-but-finalized entity — no throw, no
        // isDeleted check on that path — so without this guard the re-resolve would adopt a
        // component of an entity that is gone. `valid` is created && !destroyed.
        let resolveError: unknown = null;
        if (this.kcc == null && this.kinematicCharacterEntity.valid) {
            try {
                this.kcc = this.kinematicCharacterEntity.getComponent(CharacterControllerBase) ?? null;
            } catch (e) {
                // getComponent throws rather than choose between two CharacterControllerBase
                // components; null routes that to the veto below instead of out of the handler.
                this.kcc = null;
                resolveError = e;
            }
        }
        if (this.kcc != null) {
            // A resolve that eventually succeeds proves any earlier miss was a
            // resolution-order artifact, not the scene misconfiguration the error below
            // claims. Drop the latch so the flag stops asserting a misconfiguration that
            // is not there.
            this.reportedKccFailure = null;
            return true;
        }
        const failureMode = resolveError != null ? 'ambiguous' : 'missing';
        if (this.reportedKccFailure !== failureMode) {
            this.reportedKccFailure = failureMode;
            // Don't register in an error case so it doesn't silently fall back to TransformComponent.
            if (resolveError != null) {
                // An ambiguous scene is the opposite misconfiguration from a missing one, and
                // reporting it as "must have a" sends the reader looking for an absent
                // component they would then add a second copy of.
                console.error(`ActorTransformMoveComponent: could not resolve a single CharacterControllerBase on kinematicCharacterEntity: ${String(resolveError)}`);
            } else {
                console.error('ActorTransformMoveComponent: kinematicCharacterEntity must have a KinematicCharacterComponent');
            }
        }
        return false;
    }

    @subscribe(OnWorldUpdateEvent, { execution: ExecuteOn.Owner })
    onUpdate(params: OnWorldUpdateEventPayload) {
        if (!this.locomotionAdapterPresent && ActorNavMeshAgentDriver.forEntity(this.entity).agent != null) {
            const position = this.kcc?.simulatedPosition ?? this.transformComponent?.worldPosition;
            if (position != null) {
                const driver = ActorNavMeshAgentDriver.forEntity(this.entity);
                driver.update(params.deltaTime, position);
                if (this.isSteeringTarget && driver.shouldHoldSteering) {
                    this.targetPosition = null;
                    this.desiredSpeed = 0;
                }
                if (this.frozen) {
                    driver.stop(position);
                }
                const linkTarget = driver.linkTarget;
                if (linkTarget != null) {
                    if (this.kcc) {
                        this.kcc.addMoveDelta(linkTarget.sub(position));
                    } else if (this.transformComponent) {
                        this.transformComponent.worldPosition = linkTarget;
                    }
                    this.targetPosition = null;
                }
            }
        }
        if (this.frozen) return;

        if (this.targetPosition && this.transformComponent) {
            this.updateMovement(params.deltaTime);
        }

        if (this.targetRotation && this.transformComponent) {
            this.updateBodyRotation(params.deltaTime);
        }
    }

    @subscribe(OnNavMeshLinkEnterEvent, { execution: ExecuteOn.Owner })
    onNavMeshLinkEnter(payload: OnNavMeshLinkEnterEventPayload): void {
        const position = this.kcc?.simulatedPosition ?? this.transformComponent?.worldPosition;
        if (!this.locomotionAdapterPresent && !this.frozen && position != null) {
            const bodyOriginOffset = characterCapsuleOriginOffset(this.kcc);
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

    @subscribe(OnNavMeshLinkExitEvent, { execution: ExecuteOn.Owner })
    onNavMeshLinkExit(): void {
        if (!this.locomotionAdapterPresent) {
            ActorNavMeshAgentDriver.forEntity(this.entity).exitLink();
        }
    }

    protected updateBodyRotation(deltaTime: number): void {
        if (!this.transformComponent || !this.targetRotation) {
            return;
        }

        const currentRotation = this.transformComponent.worldRotation;
        const angularDistance = this.getAngularDistance(currentRotation, this.targetRotation);

        if (angularDistance < 0.01) {
            this.transformComponent.worldRotation = this.targetRotation;
            this.targetRotation = null;
            return;
        }

        const rotationAmount = Math.min(this.wantedAngularSpeed * deltaTime, angularDistance);
        const t = rotationAmount / angularDistance;
        const newRotation = Quaternion.slerp(currentRotation, this.targetRotation, t);
        this.transformComponent.worldRotation = newRotation;
    }

    protected getAngularDistance(from: Quaternion, to: Quaternion): number {
        const dot = Math.abs(from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w);
        const clampedDot = Math.min(1.0, dot);
        return 2 * Math.acos(clampedDot);
    }

    protected directionToQuaternion(direction: Vec3): Quaternion {
        // Engine forward is local -Z, so a yaw rotation θ produces world
        // forward (-sin θ, 0, -cos θ). Solving forward = direction gives
        // yaw = atan2(-direction.x, -direction.z).
        const normalizedDirection = direction.normalize();
        const yawAngle = Math.atan2(-normalizedDirection.x, -normalizedDirection.z);
        return Quaternion.fromAxisAngle(Vec3.up, yawAngle);
    }

    protected updateMovement(deltaTime: number): void {
        if (!this.transformComponent || !this.targetPosition) {
            return;
        }

        // The KCC integrates its own entity's transform during kPrePhysics; this
        // entity's transform only catches up on the next frame's
        // syncCharacterTransform. Differencing against the stale transform makes
        // the position error satisfy e[n] = e[n-1] - e[n-2] — an undamped
        // oscillation that never converges on the target.
        const currentPosition = this.kcc
            ? this.kcc.simulatedPosition
            : this.transformComponent.worldPosition;

        const up = this.transformComponent.worldUp;
        let toTarget = this.targetPosition.sub(currentPosition);
        if (this.kcc) {
            // Remove vertical component if KCC is enabled, since it will be handled by gravity / stair stepping.
            toTarget = toTarget.sub(up.mul(toTarget.dot(up)));
        }

        const distanceToTarget = toTarget.magnitude();
        const maxMovement = this.desiredSpeed * deltaTime;

        if (distanceToTarget <= maxMovement) {
            if (this.kcc) {
                this.kcc.addMoveDelta(toTarget);
            } else {
                this.transformComponent.worldPosition = this.targetPosition;
            }
            this.targetPosition = null;
        } else {
            const direction = toTarget.normalize();
            const displacement = direction.mul(maxMovement);
            if (this.kcc) {
                this.kcc.addMoveDelta(displacement);
            } else {
                this.transformComponent.worldPosition = currentPosition.add(displacement);
            }
        }
    }

    //// ActorMovementController
    moveToPosition(params: ActorMoveParams): void {
        if (this.frozen || !this.transformComponent) {
            return;
        }

        if (!params.desiredPosition) {
            this.stopMovement();
            return;
        }

        if (!(params instanceof ActorNavMeshMoveParams)) {
            ActorNavMeshAgentDriver.forEntity(this.entity).stop(
                this.kcc?.simulatedPosition ?? this.transformComponent.worldPosition,
            );
        }
        this.isSteeringTarget = params instanceof ActorNavMeshMoveParams;
        this.targetPosition = params.desiredPosition;
        this.desiredSpeed = params.desiredSpeed ?? 0;
    }

    stopMovement(): void {
        const driver = ActorNavMeshAgentDriver.forEntity(this.entity);
        if (driver.agent != null) {
            const position = this.kcc?.simulatedPosition ?? this.transformComponent?.worldPosition;
            if (position != null) {
                driver.stop(position);
            }
        }
        this.isSteeringTarget = false;
        this.targetPosition = null;
        this.desiredSpeed = 0;
    }

    //// ActorBodyDirectionController
    rotateBodyTo(params: ActorBodyDirectionParams): void {
        if (this.frozen || !this.transformComponent) {
            return;
        }

        const direction = params.desiredBodyDirection.normalize();
        this.targetRotation = this.directionToQuaternion(direction);
        this.wantedAngularSpeed = params.angularSpeed ?? 0;
    }

    stopRotation(): void {
        this.targetRotation = null;
        this.wantedAngularSpeed = 0;
    }

}
