/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v16

import { TransformComponent, Vec3, type Maybe, type Entity } from 'meta/worlds';
import {ICharacterInitializable} from '../ICharacterInitializable';

const EPSILON = 1e-6;

/**
 * Abstract base class for character force controllers.
 *
 * Defines the public API for applying forces, velocities, and querying
 * physics state. Concrete implementations (e.g. KinematicForceController)
 * provide the actual physics integration.
 */
export abstract class CharacterForceControllerBase extends ICharacterInitializable {
  public enabled: boolean = true;
  public gravity: Vec3 = new Vec3(0, -9.8, 0);
  public maxFallSpeed: number = 50.0;
  public mass: number = 50.0;

  public characterRootEntity: Maybe<Entity> = null;
  public characterSimulatedEntity: Maybe<Entity> = null;
  public characterRootTransform: Maybe<TransformComponent> = null;
  public simulatedTransform: Maybe<TransformComponent> = null;

  public disableForcesForSingleFrame: boolean = false;
  public inputForce: Vec3 = Vec3.zero;
  public velocity: Vec3 = new Vec3(0, 0, 0);
  public desiredTranslation: Vec3 = Vec3.zero;
  public sampledVelocity: Vec3 = Vec3.zero;
  /**
   * World-space displacement added to this frame's move on top of the
   * integrated translation, then cleared by `update()`. A position offset, not
   * a velocity: it never enters `velocity`, so it does not accumulate or
   * survive takeoff. Set by `MovingPlatformRideComponent` to carry a rider on
   * a platform it cannot parent to.
   */
  public carryDisplacement: Vec3 = Vec3.zero;
  /**
   * Turn about world up (radians) added to this frame's facing, then cleared
   * by `update()`: the deck's yaw this frame when the ride carries a rider
   * without a parent, so a spinner turns its rider as a parent link would.
   */
  public carryYawRadians: number = 0;
  /** Whether `update()` applies `carryDisplacement`. */
  public readonly appliesCarryDisplacement: boolean = false;
  protected initialized: boolean = false;

  // Velocity sampling state. sampledVelocity is derived from the character
  // root transform's per-frame position delta (see sampleVelocityFromTransform).
  // Shared between the owner's update() and the remote proxy's remoteUpdate().
  private lastPosition: Vec3 = Vec3.zero;
  private hasLastPosition: boolean = false;
  // The dt spanning the last sampled position delta.
  private lastDt: number = 1;
  // The latest update's dt and the one before it (see syncedMoveDeltaSeconds);
  // 0 until two updates have run.
  private updateDt: number = 0;
  private previousUpdateDt: number = 0;

  /**
   * The timestep (seconds) of the move whose result `syncCharacterTransform`
   * copies to the root this frame: the previous update's dt, since the KCC
   * applies a move at the next physics step. Divide a root position delta
   * read after this frame's sync by it.
   */
  public get syncedMoveDeltaSeconds(): number {
    return this.previousUpdateDt;
  }

  /** Every per-frame update records its dt (see syncedMoveDeltaSeconds). */
  protected recordUpdateDeltaSeconds(dt: number): void {
    this.previousUpdateDt = this.updateDt;
    this.updateDt = dt;
  }

  public initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity) {
    this.characterRootEntity = characterRootEntity ?? this.entity;
    this.characterRootTransform = this.characterRootEntity.getComponent(TransformComponent);
    this.characterSimulatedEntity = characterSimulatedEntity ?? this.entity;
    this.simulatedTransform = this.characterSimulatedEntity.getComponent(TransformComponent);
    this.initialized = true;
  }

  public addForce(force: Vec3): void {
    this.inputForce = this.inputForce.add(force);
  }

  public addVelocity(deltaVelocity: Vec3): void {
    this.velocity = this.velocity.add(deltaVelocity);
  }

  abstract update(dt: number): void;

  /**
   * Remote (non-owner) per-frame update. The owner drives motion through
   * update(); on remote proxies only the transform is replicated, so the
   * default here just keeps sampledVelocity live for consumers that read it on
   * remote characters (e.g. soft collision). Subclasses may override to sample
   * from a more authoritative source.
   */
  public remoteUpdate(dt: number): void {
    this.sampleVelocityFromTransform(dt);
  }

  /**
   * Samples sampledVelocity from the replicated root transform's per-frame
   * position delta. Used on remote proxies where update() never runs.
   */
  protected sampleVelocityFromTransform(dt: number): void {
    if (this.characterRootTransform != null && dt > EPSILON) {
      // worldPosition returns a fresh Vec3 per read (native getTranslation() is
      // returned by value and marshalled into a newly-allocated JS object), and
      // sub()/mul() are non-mutating, so caching currentPosition into
      // lastPosition holds a detached snapshot — the next frame reads a new
      // instance and the delta below is real, not an aliased zero. The delta
      // spans the previous frame, so it is divided by lastDt (that frame's dt).
      const currentPosition = this.characterRootTransform.worldPosition;
      if (this.hasLastPosition) {
        this.sampledVelocity = currentPosition
          .sub(this.lastPosition)
          .mul(1.0 / this.lastDt);
      }
      this.lastPosition = currentPosition;
      this.hasLastPosition = true;
    }
    this.recordUpdateDeltaSeconds(dt);
    this.lastDt = dt;
  }

  // applies the simulated (child) entity's transform
  // back to the character entity.
  protected syncCharacterTransform(syncRotation: boolean = false): void {
    if (this.simulatedTransform == null || this.characterRootTransform == null) {
      return;
    }

    // Read the child's position before any root write: turning the root
    // swings its child around the root's pivot, which lags the child by the
    // last move until the position sync below.
    const worldPos = this.simulatedTransform.worldPosition;

    // This is for KinematicCharacter only.
    // if you need to sync the rotation for DynamicCharacter,
    // just make sure the PhysicsBodyComponent is on the CharacterEntity.
    // don't run this, it will break the physics.
    if (syncRotation) {
      const worldRot = this.simulatedTransform.worldRotation.normalize();
      this.characterRootTransform.worldRotation = worldRot;
      this.simulatedTransform.worldRotation = worldRot;
    }

    // just sync the position, the rotation must be handled by the physics engine.
    this.characterRootTransform.worldPosition = worldPos;
    // since the simulatedTransform is usually a child of the characterRootTransform,
    // we need to write the worldPos back to the simulatedTransform
    // after setting its parent's transform (the characterTransform) above.
    this.simulatedTransform.worldPosition = worldPos;
  }
}
