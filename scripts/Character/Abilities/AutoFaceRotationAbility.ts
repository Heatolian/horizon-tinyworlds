/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v15

/**
 * AutoFaceRotationAbility — the STOCK third-person facing, extracted from MovementAbility.
 *
 * Turns the character toward movement by default, or toward camera-forward while moving and idle
 * in `strafeMode`, so the existing directional blend supplies strafe/backpedal animations. This
 * is the default facing for the character stack — the logic that used to live in
 * `MovementAbility.applyRotation`. `MovementAbility` now owns movement + physics only and exposes
 * `getMovementDirection()` / `getInputMagnitude()`, which this ability reads.
 *
 * Composition: this owns `worldRotation`, so anything else that writes it must not run at the
 * same time. The default `PlayerCharacter` template ships this ability.
 *
 * Attachment: character root (same entity as MovementAbility). Owner-only.
 */

import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  TransformComponent,
  Vec3,
  Quaternion,
  CameraService,
  ExecuteOn,
  property,
  editor,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';
import {MovementAbility} from './MovementAbility';

@component({
  description: 'Auto-face rotation: turns the character to face its movement direction (or the camera in strafeMode). The stock facing, extracted from MovementAbility.',
})
export class AutoFaceRotationAbility extends Component {
  /**
   * Runtime facing-mode switch, read on every owner update; no respawn or component swap needed.
   * false: face movement while travelling and preserve the heading at rest.
   * true: face horizontal camera-forward while travelling AND idle; lateral/reverse travel then
   * uses the existing strafe/backpedal animation blend. Movement input and speed are unchanged.
   *
   * Player GAS/pickup/weapon integration may set this on the owned character root: enable it
   * while a camera-aimed ranged weapon is held/aimed, keep it enabled through firing/reload,
   * and restore the desired movement-facing mode on drop, melee switch or leaving aim.
   * Rotation blocks and explicit setFacingOverride directions still take priority.
   *
   * @example
   * ```ts
   * const facing = player.getComponent(AutoFaceRotationAbility);
   * if (facing != null) facing.strafeMode = true; // enter camera-facing weapon stance
   * if (facing != null) facing.strafeMode = false; // return to movement-facing
   * ```
   */
  @editor({description: 'Runtime facing mode: false faces travel; true faces camera-forward while moving AND idle for strafe/backpedal. Player weapon integration may toggle this while held/aimed, then restore it on drop/switch. Read every frame; no respawn needed.'})
  @property()
  public strafeMode: boolean = false;

  /** Auto-face turn speed. */
  @property()
  public rotationSpeed: number = 2.0;

  private transform: Maybe<TransformComponent> = null;
  private movement: MovementAbility | null = null;
  private rotationBlocked: boolean = false;
  private facingOverride: Maybe<Vec3> = null;
  private facingOverrideMaxAngularSpeed: number | null = null;

  // Last valid heading for upward or invalid camera projections.
  private lastValidHorizontalForward: Vec3 = Vec3.forward;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    this.transform = this.entity.getComponent(TransformComponent);
    this.movement = this.entity.getComponent(MovementAbility);
  }

  /**
   * The start handler runs only on the endpoint that owns the body at start. An endpoint that
   * gains ownership later must resolve too, or it updates with no transform and turns nothing.
   */
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer() {
    if (this.entity.isOwned()) {
      this.onStart();
    }
  }

  /**
   * Suspend facing. Zeroing the movement input is not enough: with no input this ability
   * takes its idle branch, which still writes `worldRotation` every frame.
   */
  public setRotationBlocked(blocked: boolean): void {
    this.rotationBlocked = blocked;
  }

  /**
   * Temporarily face a world-space direction supplied by gameplay such as
   * auto-targeting. Pass null to return control to movement/camera facing.
   * This component remains the sole writer of the character rotation.
   *
   * `maxAngularSpeed` (rad/s) turns at a constant, frame-rate-independent rate instead of the
   * default per-frame ease. Omitted keeps the default ease; zero or negative holds the current
   * heading, as `ActorBodyDirectionParams.angularSpeed` does on ActorTransformMoveComponent.
   */
  public setFacingOverride(direction: Maybe<Vec3>, maxAngularSpeed?: number): void {
    if (direction == null) {
      this.facingOverride = null;
      this.facingOverrideMaxAngularSpeed = null;
      return;
    }
    const flat = new Vec3(direction.x, 0, direction.z);
    this.facingOverride =
      flat.magnitudeSquared() > 0.0001 ? flat.normalize() : null;
    this.facingOverrideMaxAngularSpeed =
      maxAngularSpeed != null ? Math.max(0, maxAngularSpeed) : null;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(payload: OnWorldUpdateEventPayload) {
    if (this.rotationBlocked || !this.transform) {
      return;
    }
    if (this.facingOverride != null) {
      if (this.facingOverrideMaxAngularSpeed != null) {
        this.rotateTowardsAtRate(
          this.facingOverride,
          this.facingOverrideMaxAngularSpeed,
          payload.deltaTime ?? 0,
        );
      } else {
        this.rotateTowards(this.facingOverride);
      }
      return;
    }
    // A body with no MovementAbility (an NPC moved by something else) has only the override to
    // face. The idle branch below would otherwise rewrite its rotation every frame.
    if (!this.movement) {
      return;
    }
    if (this.strafeMode) {
      this.rotateTowards(this.getCameraHorizontalForward());
      return;
    }

    const inputMagnitude = this.movement.getInputMagnitude();
    const movementDirection = this.movement.getMovementDirection();

    if (inputMagnitude > 0.01 && movementDirection.magnitudeSquared() > 0.01) {
      this.rotateTowards(movementDirection.normalize());
    } else {
      // Idle: keep the character upright, preserving current heading.
      const currentForward = this.transform.worldRotation.mulVec3(Vec3.forward);
      // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- Vec3 is immutable; flattening must not mutate the transform-derived vector.
      const flatForward = new Vec3(currentForward.x, 0, currentForward.z);
      if (flatForward.magnitudeSquared() > 0.0001) {
        this.transform.worldRotation = Quaternion.lookRotation(flatForward.normalize(), Vec3.up);
      }
    }
  }

  private rotateTowards(targetDirection: Vec3): void {
    if (!this.transform) {
      return;
    }
    const targetRotation = Quaternion.lookRotation(targetDirection, Vec3.up);
    const rotationLerp = 0.1 * this.rotationSpeed;
    this.transform.worldRotation = this.transform.worldRotation
      .slerp(targetRotation, rotationLerp)
      .normalize();
  }

  private rotateTowardsAtRate(targetDirection: Vec3, maxAngularSpeed: number, dt: number): void {
    if (!this.transform) {
      return;
    }
    const current = this.transform.worldRotation;
    const lookTarget = Quaternion.lookRotation(targetDirection, Vec3.up);
    const signedDot =
      current.x * lookTarget.x +
      current.y * lookTarget.y +
      current.z * lookTarget.z +
      current.w * lookTarget.w;
    // q and -q are the same orientation. Slerp toward the one in the current hemisphere, or it
    // takes the long arc and turns the body the wrong way round.
    const target =
      signedDot < 0
        ? new Quaternion(-lookTarget.x, -lookTarget.y, -lookTarget.z, -lookTarget.w)
        : lookTarget;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(signedDot)));
    const step = maxAngularSpeed * dt;
    if (angle <= step || angle < 0.0001) {
      this.transform.worldRotation = target;
      return;
    }
    this.transform.worldRotation = current.slerp(target, step / angle).normalize();
  }

  private getCameraHorizontalForward(): Vec3 {
    const camera = CameraService.get();
    let camFwd = camera.forward;
    let flatMagSq = camFwd.x * camFwd.x + camFwd.z * camFwd.z;
    if (flatMagSq < 0.01 && camFwd.y < 0) {
      camFwd = camera.up;
      flatMagSq = camFwd.x * camFwd.x + camFwd.z * camFwd.z;
    }
    if (flatMagSq < 0.01) {
      return this.lastValidHorizontalForward;
    }
    const invMag = 1 / Math.sqrt(flatMagSq);
    const x = camFwd.x * invMag;
    const z = camFwd.z * invMag;
    if (x !== this.lastValidHorizontalForward.x || z !== this.lastValidHorizontalForward.z) {
      this.lastValidHorizontalForward = new Vec3(x, 0, z);
    }
    return this.lastValidHorizontalForward;
  }
}
