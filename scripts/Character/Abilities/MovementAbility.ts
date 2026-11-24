/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v16

/**
 * MovementAbility - Self-contained movement ability
 *
 * Handles ground movement with acceleration curves, legacy damping,
 * and either camera-relative stick input or world-space input.
 */

import {
  CharacterControllerBase,
  component,
  property,
  Vec2,
  Vec3,
  TransformComponent,
  CameraService,
  type Maybe,
  type Entity,
} from 'meta/worlds';
import {CharacterForceControllerBase} from '../Force/CharacterForceControllerBase';
import { WorldsGroundInfoComponent, characterCapsuleOriginOffset } from '../Physics/WorldsGroundInfoComponent';
import {LocomotionSolver, type LocomotionSolveParams} from '../LocomotionSolver';
import {type AccelerationConfig} from '../AccelerationCurve';
import {ICharacterInitializable} from '../ICharacterInitializable';

@component({
  description: 'Movement ability: camera-relative ground locomotion + physics. Facing is owned by a separate rotation ability (AutoFaceRotationAbility), not here.',
})
export class MovementAbility extends ICharacterInitializable {
  @property()
  public moveSpeed: number = 5.0;

  // ============================================================================
  // Acceleration Properties
  // ============================================================================

  /** Enable smooth acceleration/deceleration */
  @property()
  public enableAcceleration: boolean = true;

  /** Time to accelerate from 0 to max speed (seconds) */
  @property()
  public accelerationTime: number = 0.1;

  /** Multiplier for acceleration time when in air (higher = slower) */
  @property()
  public airControlFactor: number = 2.0;

  /** Factor applied when changing direction >90 degrees or stopping */
  @property()
  public decelerationFactor: number = 2.0;

  // ============================================================================
  // Force-Based Movement
  // ============================================================================

  /**
   * When true, use CharacterForceControllerBase.addForce instead of
   * KinematicCharacterComponent.addMoveDelta.
   * Set to False if you need a Kinematic controller.
   *
   * This should be True when you want simulated acceleration/momentum. But it will try to be responsive by default:
   * * the added input force will instantly set the character to move at the max walking/sprinting speed without any acceleration.
   * * work natively with the friction model.
   * * it works with any added velocity from other sources.
   * Downside: when you move (add velocity) and suddenly become airborne, that velocity will carry on and shoot you forward,
   * unlike the kinematic movement (which sends moveDelta) that doesn't have a momentum and will stop instantly (feel more responsive)
   * -- while you are on the ground, the friction will kill the momentum quickly so it feels like a kinematic movement.
   */
  @property()
  public useForceAsInputs: boolean = false;

  // ============================================================================
  // Slide Direction Lock Properties
  // ============================================================================

  /**
   * Enable slide direction lock.
   * When enabled, movement direction is locked to the initial direction
   * when movement starts, preventing drift from imprecise thumbstick input.
   */
  @property()
  public slideDirectionLockEnabled: boolean = false;

  /**
   * Minimum input magnitude to lock direction (0-1).
   * Direction won't lock until input exceeds this threshold.
   */
  @property()
  public slideDirectionLockThreshold: number = 0.3;

  private kcc: Maybe<CharacterControllerBase> = null;
  private cfc!: CharacterForceControllerBase;
  private groundInfoComponent!: WorldsGroundInfoComponent;
  private transformComponent!: TransformComponent;

  public currentInput: Vec2 = Vec2.zero;

  /**
   * World-space XZ input, |d| <= 1 as a fraction of moveSpeed. While set it replaces the
   * camera-mapped stick, so a caller that already knows the world direction never touches
   * `CameraService`, which exists only on a client.
   */
  private worldInput: Vec3 | null = null;

  private readonly stopDamping: number = 15.0;

  private lastValidHorizontalForward: Vec3 = Vec3.forward;

  private movementBlocked: boolean = false;
  private initialized: boolean = false;
  private speedMultiplier: number = 1.0;

  // Acceleration system
  /** Body-agnostic half: lock + damping + curve. This class keeps only the camera mapping. */
  private solver!: LocomotionSolver;

  /** Reused across frames; `solve()` reads it and does not retain it. */
  private readonly solveParams: LocomotionSolveParams = {
    worldMoveDirection: Vec3.zero,
    inputMagnitude: 0,
    deltaTime: 0,
    effectiveSpeed: 0,
    isGrounded: false,
  };

  /**
   * Reused across frames so the per-frame curve sync in `syncSolverConfig()` does not allocate.
   *
   * WHY LITERALS AND NOT THE `@property` FIELDS: a field initializer runs during component
   * CONSTRUCTION, and reading a `@property` there hits the entity's property store before the
   * entity is finalized — which the platform rejects outright ("Cannot retrieve component ...
   * before the entity is finalized as this can lead to race conditions"). These three values are
   * never observed anyway: `syncSolverConfig()` overwrites all of them from the properties at the
   * top of every `applyMovement()`, before the only read. They match the declared defaults so a
   * hypothetical pre-sync reader still sees a sane curve rather than zeros.
   */
  private readonly solverCurveConfig: AccelerationConfig = {
    accelerationTime: 0.1,
    airControlFactor: 2.0,
    decelerationFactor: 2.0,
  };

  /** Bound once so the hot path does not allocate a closure per frame. */
  private readonly cancelOpposingVelocityHook = (desiredDelta: Vec3): void =>
    this.cancelOpposingVelocity(desiredDelta);

  // Stores the last requested velocity based on current input
  private lastDesiredVelocity: Vec3 = Vec3.zero;

  // Last camera-relative movement direction (pre-physics). Exposed via getMovementDirection()
  // so a separate facing ability can auto-face it; not used for movement itself.
  private lastMovementDirection: Vec3 = Vec3.zero;

  public setSpeedMultiplier(multiplier: number) {
    this.speedMultiplier = multiplier;
  }

  public getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  /**
   * Idempotent. `CharacterUpdateManager.swapSimulatedEntity()` calls this again on every
   * runtime body swap. Re-binds to the new entity and resets the acceleration curve, but
   * deliberately PRESERVES the solver's slide lock and damped stop velocity.
   */
  public initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity) {
    this.kcc = characterSimulatedEntity.getComponent(CharacterControllerBase);
    this.cfc = characterSimulatedEntity.getComponentOrThrow(CharacterForceControllerBase);
    this.groundInfoComponent = characterSimulatedEntity.getComponentOrThrow(WorldsGroundInfoComponent);
    this.transformComponent = characterRootEntity.getComponentOrThrow(TransformComponent);

    // Initialize acceleration curve with property values
    const curveConfig = {
      accelerationTime: this.accelerationTime,
      airControlFactor: this.airControlFactor,
      decelerationFactor: this.decelerationFactor,
    };
    if (this.solver == null) {
      this.solver = new LocomotionSolver(curveConfig);
    } else {
      // Pre-extraction this rebuilt the curve alone; the lock and damped velocity survived.
      // Keyed on the solver, not `initialized`, whose job is gating update().
      this.solver.setCurveConfig(curveConfig);
      this.solver.resetCurve();
    }

    this.initialized = true;
  }

  /**
   * Mirror the designer-editable knobs onto the solver each frame. They are `@property()`
   * fields and can change at runtime, so a one-time copy at initialize() would go stale.
   * The curve knobs are included for the same reason: `setCurveConfig()` mutates the curve's
   * config in place without resetting its interpolation state, so re-applying unchanged
   * values every frame is a no-op.
   */
  private syncSolverConfig(): void {
    this.solver.slideDirectionLockEnabled = this.slideDirectionLockEnabled;
    this.solver.slideDirectionLockThreshold = this.slideDirectionLockThreshold;
    this.solver.enableAcceleration = this.enableAcceleration;
    this.solver.stopDamping = this.stopDamping;

    this.solverCurveConfig.accelerationTime = this.accelerationTime;
    this.solverCurveConfig.airControlFactor = this.airControlFactor;
    this.solverCurveConfig.decelerationFactor = this.decelerationFactor;
    this.solver.setCurveConfig(this.solverCurveConfig);
  }

  public setInput(input: Vec2) {
    this.currentInput = input;
    this.worldInput = null;
  }

  /** World-space counterpart of `setInput`. The last of the two to be called wins. */
  public setWorldInput(direction: Vec3) {
    this.worldInput = new Vec3(direction.x, 0, direction.z);
    this.currentInput = Vec2.zero;
  }

  public setMovementBlocked(blocked: boolean) {
    this.movementBlocked = blocked;
  }

  /**
   * Drop all cached motion. Needed alongside `setMovementBlocked(true)`, which returns
   * before anything decays: `lastDesiredVelocity` would stay at its last moving value, and
   * `CharacterAnimationController` reads it to drive `Speed`.
   */
  public stop(): void {
    this.currentInput = Vec2.zero;
    this.worldInput = null;
    this.clearMotion();
  }

  /**
   * `stop()` without dropping the input: input only arrives on change, so a stick
   * held through a pause must still drive movement once it is unblocked.
   */
  public clearMotion(): void {
    this.lastDesiredVelocity = Vec3.zero;
    this.lastMovementDirection = Vec3.zero;
    this.solver?.resetVelocity();
    this.resetAcceleration();
  }

  /**
   * Reset acceleration state (call after teleport, respawn, etc.)
   */
  public resetAcceleration(): void {
    this.solver?.resetCurve();
  }

  /**
   * Update acceleration configuration at runtime
   */
  public setAccelerationConfig(config: Partial<AccelerationConfig>): void {
    // Written back into the @property fields, not just pushed at the solver.
    // syncSolverConfig() re-applies those fields every frame, so a solver-only write would
    // be clobbered on the next one — the override would appear to take and then silently
    // revert. Persisting through the properties mirrors setSlideDirectionLockEnabled, which
    // already works this way.
    if (config.accelerationTime !== undefined) {
      this.accelerationTime = config.accelerationTime;
    }
    if (config.airControlFactor !== undefined) {
      this.airControlFactor = config.airControlFactor;
    }
    if (config.decelerationFactor !== undefined) {
      this.decelerationFactor = config.decelerationFactor;
    }
    this.solver?.setCurveConfig(config);
  }

  /**
   * Get current acceleration configuration
   */
  public getAccelerationConfig(): AccelerationConfig | null {
    return this.solver?.getCurveConfig() ?? null;
  }

  // ============================================================================
  // Slide Direction Lock
  // ============================================================================

  /**
   * Enable or disable slide direction lock at runtime
   */
  public setSlideDirectionLockEnabled(enabled: boolean): void {
    this.slideDirectionLockEnabled = enabled;
    // The solver's lock is only cleared from inside applySlideDirectionLock, which
    // returns early while disabled — so without this a lock held at the moment of
    // disabling survives, and re-enabling mid-movement resumes the stale heading.
    if (!enabled) {
      this.solver?.unlockSlideDirection();
    }
  }

  /**
   * Check if slide direction is currently locked
   */
  public isSlideDirectionLocked(): boolean {
    return this.solver?.isSlideDirectionLocked() ?? false;
  }

  /**
   * Manually unlock slide direction (e.g., after teleport, landing, etc.)
   */
  public unlockSlideDirection(): void {
    this.solver?.unlockSlideDirection();
  }

  public update(dt: number): void {
    if (!this.initialized || this.movementBlocked) return;
    this.applyMovement(dt);
  }

  private applyMovement(dt: number): void {
    const inputMagnitude = this.getInputMagnitude();

    let baseDirection: Vec3;
    if (this.worldInput != null) {
      baseDirection =
        inputMagnitude > 1.0 ? this.worldInput.div(inputMagnitude) : this.worldInput;
    } else {
      // Camera mapping stays here — it is client-only. Everything downstream of it is
      // body-agnostic and lives in LocomotionSolver.
      let normalizedInput = this.currentInput;
      if (inputMagnitude > 1.0) {
        normalizedInput = new Vec2(
          this.currentInput.x / inputMagnitude,
          this.currentInput.y / inputMagnitude,
        );
      }
      baseDirection = this.calculateMovementDirection(normalizedInput);
    }

    // Apply slide direction lock if enabled
    this.syncSolverConfig();
    let movementDirection: Vec3;
    if (this.worldInput != null) {
      // The lock corrects stick drift; world input is re-aimed by its caller every tick.
      this.solver.unlockSlideDirection();
      movementDirection = baseDirection;
    } else {
      movementDirection = this.solver.resolveDirection(baseDirection, inputMagnitude);
    }

    const effectiveSpeed = this.moveSpeed * this.speedMultiplier;

    const inputDeadZone = this.worldInput != null ? 0 : 0.1;
    if (this.useForceAsInputs && this.cfc != null) {
      // Force-based: let the physics engine handle acceleration.
      // Pass direction * speed as a continuous force (not dt-scaled).
      if (inputMagnitude > inputDeadZone) {
        const planeNormal = this.getMovementPlaneNormal();

        // Strip the velocity component along the plane normal so the force
        // only affects in-plane motion.
        const inPlaneCurrentVelocity = this.projectOntoPlane(
          this.cfc.velocity,
          planeNormal,
        );

        // Compute the desired horizontal velocity (camera-relative, world XZ).
        const horizontalDesiredVelocity = new Vec3(
          movementDirection.x * effectiveSpeed,
          0,
          movementDirection.z * effectiveSpeed,
        );
        const desiredSpeed = Math.sqrt(
          horizontalDesiredVelocity.magnitudeSquared(),
        );

        // Re-orient the desired velocity onto the plane while preserving its
        // magnitude. Naively projecting would shorten it on slopes, causing
        // the character to slow down uphill or hop downhill.
        const inPlaneDir = this.inPlaneUnitDirection(
          horizontalDesiredVelocity,
          planeNormal,
        );
        const inPlaneDesiredVelocity = inPlaneDir != null
          ? inPlaneDir.mul(desiredSpeed)
          : Vec3.zero;

        const desiredVelocity = inPlaneDesiredVelocity.sub(inPlaneCurrentVelocity);
        this.lastDesiredVelocity = desiredVelocity;
        const force = desiredVelocity.mul(this.cfc.mass / dt);
        this.cfc.addForce(force);
      } else {
        this.lastDesiredVelocity = Vec3.zero;
      }
    } else {
      // Kinematic: the solver owns direction -> delta from here.
      // Damping -> [opposing-velocity cancel] -> acceleration. The cancel is supplied as a
      // hook so the solver stays free of the force controller while the ORDER is preserved.
      // Both the params object and the hook are hoisted out of the frame: this runs every
      // frame at 72-90 Hz, and a fresh object literal plus a fresh closure per frame is
      // GC pressure the update loop does not need (no-allocation-in-update-loop).
      const params = this.solveParams;
      params.worldMoveDirection = movementDirection;
      params.inputMagnitude = inputMagnitude;
      params.inputDeadZone = inputDeadZone;
      params.deltaTime = dt;
      params.effectiveSpeed = effectiveSpeed;
      params.isGrounded = this.groundInfoComponent.isGrounded;

      let finalDelta: Vec3 = this.solver.solve(params, this.cancelOpposingVelocityHook);

      // Re-orient the (horizontal) move delta onto the ground plane so walking
      // follows the slope. A purely horizontal delta walks the character off a
      // downhill surface each step -- it moves forward while the ground drops
      // away -- so the character keeps becoming airborne and bounces down the
      // slope. Projecting onto the plane while preserving magnitude keeps it on
      // the surface (mirrors the useForceAsInputs branch). When grounded the
      // plane normal is the slope normal; airborne / on flat ground it is up, so
      // this is a no-op.
      const movementPlaneNormal = this.getMovementPlaneNormal();
      const finalDeltaMagnitude = Math.sqrt(finalDelta.magnitudeSquared());
      if (finalDeltaMagnitude > 1e-6) {
        const inPlaneDelta = this.inPlaneUnitDirection(
          finalDelta,
          movementPlaneNormal,
        );
        if (inPlaneDelta != null) {
          finalDelta = inPlaneDelta.mul(finalDeltaMagnitude);
        }
      }
      this.lastDesiredVelocity = finalDelta.div(dt);

      if (this.kcc != null) {
        this.kcc.addMoveDelta(finalDelta);
      } else {
        this.transformComponent.worldPosition = this.transformComponent.worldPosition.add(
          finalDelta,
        );
      }
    }

    // Facing is owned by a separate rotation ability (AutoFace/Drag). Expose the computed
    // camera-relative movement direction for it to read; MovementAbility no longer rotates.
    this.lastMovementDirection = movementDirection;
  }

  private calculateMovementDirection(normalizedInput: {
    x: number;
    y: number;
  }): Vec3 {
    const horizontalForward = this.getCameraHorizontalForward();
    const horizontalRight = horizontalForward.cross(Vec3.up).normalize();
    return horizontalForward
      .mul(normalizedInput.y)
      .add(horizontalRight.mul(normalizedInput.x));
  }

  /**
   * Counter any existing in-plane velocity that opposes the player's input. If the
   * character is sliding (e.g. on ice) and the player inputs against the slide, cancel the
   * velocity component pointing opposite to the input so the slide can be stopped by
   * inputting against it. Velocity along the plane normal (jumping / falling) is untouched.
   *
   * Runs between damping and acceleration — see the hook in applyMovement.
   */
  private cancelOpposingVelocity(desiredDelta: Vec3): void {
    if (this.cfc == null) {
      return;
    }
    const planeNormal = this.getMovementPlaneNormal();
    const inPlaneDir = this.inPlaneUnitDirection(desiredDelta, planeNormal);
    if (inPlaneDir == null) {
      return;
    }
    const inPlaneVelocity = this.projectOntoPlane(this.cfc.velocity, planeNormal);
    // Signed projection: negative means the character is moving against the input.
    const projection = inPlaneVelocity.dot(inPlaneDir);
    if (projection < 0) {
      this.cfc.addVelocity(inPlaneDir.mul(-projection));
    }
  }

  /**
   * Returns the unit normal of the plane that movement should be confined to:
   *  - The supporting ground's surface normal when grounded, so movement
   *    follows the slope (no slowdown uphill, no hop downhill, and no
   *    stripping of vertical jump/fall velocity).
   *  - The character's transform up axis when airborne, so the in-plane
   *    operations only affect horizontal motion and never zero out
   *    falling / jumping velocity.
   */
  private getMovementPlaneNormal(): Vec3 {
    if (this.groundInfoComponent.isGrounded) {
      return this.groundInfoComponent.lastGoodGroundHit.normal;
    }
    return this.transformComponent.worldRotation.mulVec3(Vec3.up);
  }

  /**
   * Project a vector onto the plane defined by the given unit normal,
   * i.e. remove the component of `v` along `planeNormal`.
   */
  private projectOntoPlane(v: Vec3, planeNormal: Vec3): Vec3 {
    return v.sub(planeNormal.mul(v.dot(planeNormal)));
  }

  /**
   * Project `v` onto the plane defined by `planeNormal` and return the unit
   * direction of the projection. Returns null when the projection has
   * near-zero magnitude (e.g. `v` is perpendicular to the plane, or zero).
   */
  private inPlaneUnitDirection(v: Vec3, planeNormal: Vec3): Vec3 | null {
    const projected = this.projectOntoPlane(v, planeNormal);
    const magSq = projected.magnitudeSquared();
    if (magSq < 1e-10) return null;
    return projected.mul(1 / Math.sqrt(magSq));
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
    this.lastValidHorizontalForward = new Vec3(
      camFwd.x * invMag,
      0,
      camFwd.z * invMag,
    );
    return this.lastValidHorizontalForward;
  }

  // ============================================================================
  // Slide Direction Lock Implementation
  // ============================================================================

  public getMovementInput(): Vec2 {
    return this.currentInput;
  }

  /** Unclamped magnitude of whichever input is active, stick or world-space. */
  public getInputMagnitude(): number {
    if (this.worldInput != null) {
      return Math.sqrt(
        this.worldInput.x * this.worldInput.x + this.worldInput.z * this.worldInput.z,
      );
    }
    return Math.sqrt(
      this.currentInput.x * this.currentInput.x + this.currentInput.y * this.currentInput.y,
    );
  }

  /**
   * Where the body this ability moves is: the KCC's simulated position, which leads the root
   * transform by a frame, or the root transform without a KCC. Null before `initialize()`.
   */
  public getBodyPosition(): Vec3 | null {
    if (!this.initialized) {
      return null;
    }
    return this.kcc?.simulatedPosition ?? this.transformComponent.worldPosition;
  }

  /** World-Y origin-to-capsule-bottom offset for scripted landing; zero for a transform-only movement anchor. */
  public getBodyOriginHeightOffset(): number | null {
    return this.initialized ? characterCapsuleOriginOffset(this.kcc) : null;
  }

  /**
   * Moves the body to `position` this frame with the force controller's gravity and friction
   * held off and locomotion momentum dropped, for a scripted path that must end exactly where
   * it was planned (an NPC crossing a NavMesh link). Call it every frame of the path.
   */
  public placeBody(position: Vec3): void {
    const current = this.getBodyPosition();
    if (current == null) {
      return;
    }
    this.clearMotion();
    this.cfc.disableForcesForSingleFrame = true;
    if (this.kcc != null) {
      this.kcc.addMoveDelta(position.sub(current));
    } else {
      this.transformComponent.worldPosition = position;
    }
  }

  public getDesiredVelocity(): Vec3 {
    return this.lastDesiredVelocity;
  }

  /** Last camera-relative movement direction (pre-physics); a facing ability reads this to auto-face movement. */
  public getMovementDirection(): Vec3 {
    return this.lastMovementDirection;
  }
}
