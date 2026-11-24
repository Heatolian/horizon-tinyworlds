/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v11

import {
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  AnimatorComponent,
  type Maybe,
  type Entity,
  AnimStateRequestInfo,
  Vec3,
  TransformComponent,
  type RemapPageAsset,
} from 'meta/worlds';
import {CharacterStateMachine, StateId} from '../Character/State/CharacterStateMachine';
import {MovementAbility} from '../Character/Abilities/MovementAbility';
import {CharacterForceControllerBase} from '../Character/Force/CharacterForceControllerBase';
import {JumpStartedEvent} from '../Character/Abilities/JumpAbility';
import {ICharacterInitializable} from '../Character/ICharacterInitializable';
import {
  fromStateEntry,
  WorldsCharacterStateReplication,
  type ReplicatedValue,
} from '../Character/WorldsCharacterStateReplication';
import {AnimKey, AnimVar} from './AnimationGraphContract';
import {CharacterSpeedSmoother} from './CharacterSpeedSmoother';
import {
  DEFAULT_MAX_DECK_SPEED_METERS_PER_SECOND,
  deckTeleportThresholdMeters,
  parentStepToWorld,
} from '../Character/Physics/MovingPlatformCarryMath';
import {MovingPlatformRideComponent} from '../Character/Physics/MovingPlatformRideComponent';
import {ActorActionAnimationModule} from './modules/ActorActionAnimationModule';
import {AirborneAnimationModule} from './modules/AirborneAnimationModule';
import type {
  AnimationContext,
  AnimationFrame,
  AnimationModule,
  MountLayerOptions,
  PlayOptions,
} from './modules/AnimationModule';
import {DamageAnimationModule} from './modules/DamageAnimationModule';
import {DeathAnimationModule} from './modules/DeathAnimationModule';
import {DodgeAnimationModule} from './modules/DodgeAnimationModule';
import {EquipmentAnimationModule} from './modules/EquipmentAnimationModule';

const MASK_WEIGHT_EPSILON = 0.01;

// Hysteresis band for the attached-rider idle gate. Per-frame position noise
// (transform sync residue, KCC corner snags, replication ripple) is absolute,
// not proportional to deck speed — so where the deck itself moves slowly
// (spinner pivot, shuttle turnaround, drift reversal) the deck-relative
// residual hovers AT a single threshold and Speed flickers walk/idle every
// few frames. Entering idle below 0.25 m/s but only leaving above 0.5 m/s
// kills the flicker; knockback (m/s scale) still animates instantly.
const RELATIVE_IDLE_SPEED_SQ = 0.0625;
const RELATIVE_MOVE_SPEED_SQ = 0.25;

/**
 * CharacterAnimationController — the host for character animation feature modules.
 *
 * It owns exactly three things, and deliberately no fourth:
 *   1. THE BASE GRAPH. The locomotion blend (`Speed`, `MovementDirectionYaw`, `ShouldStrafe`)
 *      and the grounded / jumping bools, fed from whichever velocity source this character
 *      has — the owner's physics, a proxy's replicated transform, or observed motion for a
 *      character with no MovementAbility at all.
 *   2. TRANSPORT. Binding the optional {@link WorldsCharacterStateReplication} and routing
 *      replicated keys to the modules that claimed them.
 *   3. COMPOSITION. Mounting modules, ticking them, and propagating shared animation tags.
 *
 * It knows no feature-specific layer or state names. Equipment, airborne, damage, death, and
 * actor actions are plain modules composed through {@link AnimationContext}; one module may
 * control several Animator layers.
 *
 * MULTIPLAYER IS OPT-IN via a sibling {@link WorldsCharacterStateReplication}. Without one
 * everything applies locally (single-player). With one, {@link fireNet} / {@link setNet}
 * predict on the calling client and replicate owner → all, and the callbacks drive every
 * client's layers identically. The locomotion floats are never networked either way: a stale
 * speed is a perpetual sprint, and direction is recoverable from the replicated transform.
 *
 * WHY THE REMOTE VELOCITY IS SMOOTHED AND THE OWNER'S IS NOT (read before trying to unify):
 * a proxy does not run the physics simulation — it only sees the transform as it replicates,
 * with dropped frames and jitter — so a raw per-frame position delta is noisy and fed straight
 * to the animator produces visible popping. The owner reads the physics engine output
 * directly with no round-trip, so smoothing it would only add latency and blur.
 */
@component({
  description:
    'Host for character animation modules: drives base locomotion, routes replicated state, and supplies shared Animator operations.',
})
export class CharacterAnimationController
  extends ICharacterInitializable
  implements AnimationContext
{
  @property()
  public animatorEntity: Maybe<Entity> = null;

  @property()
  public groundedThreshold: number = 0.8;

  @editor({
    description: `Frames of velocity averaged together in measured mode (a character with no MovementAbility, i.e. an NPC). Higher is smoother but less responsive. Ignored when movement drives the blend. 🚨 Template gotcha: stored as 0 on a template instance — set 10 explicitly.`,
  })
  @property({isNetworked: false, minValue: 1.0, maxValue: 60.0})
  public smoothingFrameCount: number = 10;

  @editor({
    description: `Measured-mode speed clamp (m/s), which keeps a teleport or a physics glitch from spiking the locomotion blend. 🚨 Template gotcha: stored as 0 on a template instance, and a 0 clamps all motion to zero — set 10.0 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 100.0})
  public maxSpeedClamp: number = 10.0;

  @editor({
    description: `Measured-mode multiplier applied to the speed before it reaches the animator, for tuning blend thresholds. 🚨 Template gotcha: stored as 0 on a template instance, and a 0 freezes locomotion animation entirely — set 1.0 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 10.0})
  public speedMultiplier: number = 1.0;

  @editor({
    description: `Measured-mode floor below which speed is treated as zero, so micro-movement does not trip the locomotion blend. 🚨 Template gotcha: stored as 0 on a template instance, which disables the filter — set 0.01 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 1.0})
  public minSpeedThreshold: number = 0.01;

  @editor({
    description: `Movement speed at which a masked layer's mask reaches full strength (the action confined to the upper body, legs left to locomotion). The ramp is proportional from 0 up to this — at the 1.0 default, half speed is a half-strength mask. Layers with no mask ignore it.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 50.0})
  public actionMaskFullSpeed: number = 1.0;

  // ===== AnimationContext =====

  private animator!: AnimatorComponent;

  public mountLayer(layerName: string, options: MountLayerOptions = {}): boolean {
    if (options.optional === true) {
      try {
        this.animator.getLayerWeight(layerName);
      } catch {
        return false;
      }
    }
    this.animator.requestLayerFade(layerName, options.initialWeight ?? 1, {fadeTimeSec: 0});
    if (options.initialMaskWeight !== undefined) {
      this.animator.requestLayerMaskFade(layerName, options.initialMaskWeight, {fadeTimeSec: 0});
      this.layerMaskWeights.set(layerName, options.initialMaskWeight);
    }
    return true;
  }

  public playState(layerName: string, stateName: string, options: PlayOptions = {}): void {
    const request = new AnimStateRequestInfo();
    request.layerName = layerName;
    request.stateName = stateName;
    request.startPhase = options.startPhase ?? 0;
    request.transitionTimeSec = options.transitionTimeSec ?? 0.15;
    this.animator.requestTransitionToState(request);
  }

  public currentState(layerName: string): string | null {
    try {
      return this.animator.getCurrentStateName(layerName);
    } catch {
      return null;
    }
  }

  public setLayerWeight(layerName: string, weight: number, fadeTimeSec: number = 0.15): void {
    this.animator.requestLayerFade(layerName, weight, {fadeTimeSec});
  }

  public setLayerMaskWeight(
    layerName: string,
    weight: number,
    fadeTimeSec: number = 0.15,
  ): void {
    const current = this.layerMaskWeights.get(layerName);
    const atEndpoint = weight <= 0 || weight >= 1;
    if (
      current === weight ||
      (!atEndpoint &&
        current !== undefined &&
        Math.abs(weight - current) < MASK_WEIGHT_EPSILON)
    ) {
      return;
    }
    this.animator.requestLayerMaskFade(layerName, weight, {fadeTimeSec});
    this.layerMaskWeights.set(layerName, weight);
  }

  public setGraphVariable(name: string, value: number | boolean): void {
    this.animator.setGraphVariable(name, value);
  }

  public addRemapper(page: RemapPageAsset, priority: number): void {
    this.animator.addAnimRemapper(page, priority);
  }

  public removeRemapper(page: RemapPageAsset): void {
    this.animator.removeAnimRemapper(page);
  }

  public fireNet(key: string): void {
    if (this.stateReplication) {
      this.stateReplication.trigger(key);
    } else {
      this.dispatchTrigger(key);
    }
  }

  public setNet(key: string, value: ReplicatedValue): void {
    if (this.stateReplication) {
      this.stateReplication.requestState(key, value);
    } else {
      this.dispatchValue(key, value, false);
    }
  }

  public setTag(tag: string, raised: boolean): void {
    const changed = raised ? !this.tags.has(tag) : this.tags.delete(tag);
    if (raised) {
      this.tags.add(tag);
    }
    if (!changed) {
      return;
    }
    // Synchronous, not deferred to the next tick: a module raising a tag expects its peers to
    // be back at rest by the time its own next statement runs.
    for (const module of this.modules) {
      module.onTagsChanged?.();
    }
  }

  public hasTag(tag: string): boolean {
    return this.tags.has(tag);
  }

  // ===== Public API: gameplay addresses an intent, never a layer. =====

  /** Play a one-shot action. Unclaimed intents are a no-op. */
  public play(action: string): void {
    this.modulesByAction.get(action)?.request?.(action);
  }

  /** Cut a one-shot action short. */
  public stop(action: string): void {
    this.modulesByAction.get(action)?.interrupt?.(action);
  }

  /** Enter or leave a persistent pose. */
  public setActionActive(action: string, active: boolean): void {
    this.modulesByAction.get(action)?.setActive?.(action, active);
  }

  public isActionActive(action: string): boolean {
    return this.modulesByAction.get(action)?.isActive?.(action) ?? false;
  }

  /**
   * Push a per-entity tuning value at the module serving `action`.
   *
   * A module is a plain class with no `@property`, so a number that differs between the player
   * and an NPC has to come from the gameplay component that owns it. Call this from an
   * `ExecuteOn.Everywhere` handler — every client must hold the value before the first
   * replicated trigger arrives, because a proxy writes the graph variables itself.
   */
  public tune(action: string, key: string, value: number): void {
    this.modulesByAction.get(action)?.tune?.(action, key, value);
  }

  // ===== Internals =====

  private readonly modules: AnimationModule[] = [
    new AirborneAnimationModule(),
    new ActorActionAnimationModule(),
    new DamageAnimationModule(),
    new DeathAnimationModule(),
    new DodgeAnimationModule(),
    new EquipmentAnimationModule(),
  ];
  /**
   * Routing tables, derived from the modules at construction rather than at mount. A gameplay
   * component pushes its tuning from `OnEntityCreateEvent`, which fires before the
   * `OnEntityStartEvent` that mounts the modules — built any later, those values would be
   * routed to an empty table and silently dropped.
   */
  private readonly modulesByAction: Map<string, AnimationModule> = indexByAction(this.modules);
  private readonly modulesByNetKey: Map<string, AnimationModule[]> = indexByNetKey(this.modules);
  private readonly tags: Set<string> = new Set<string>();
  private readonly layerMaskWeights: Map<string, number> = new Map<string, number>();

  private stateMachine: CharacterStateMachine | null = null;
  private movementComponent: MovementAbility | null = null;
  private transformComponent: TransformComponent | null = null;
  private characterForceController: CharacterForceControllerBase | null = null;
  // Optional ride fix, resolved in initialize(). Read in update(), never owned
  // here — the ride component owns its lifecycle on the simulated entity.
  private platformRide: MovingPlatformRideComponent | null = null;
  // Idle-gate hysteresis state. Only consulted while attached; self-corrects
  // within one frame of (re)attach either way, so no reset on detach.
  private rideIdleLatched: boolean = false;
  private stateReplication: WorldsCharacterStateReplication | null = null;

  /** Remote-only velocity smoother; null on the owner. See the class header. */
  private speedSmoother: CharacterSpeedSmoother | null = null;
  private previousPosition: Vec3 | null = null;
  // Remote-side mount: the proxy root's replicated parent link, read live
  // against this endpoint's mover registry. When the owner rides, the proxy
  // is parented to the mover on the remote too (the parent link replicates),
  // so the proxy's LOCAL position under that parent differences into the
  // same deck-relative velocity the owner's ride publishes — no token, no
  // provider query, no deck API. `remotePrevRel` is the anchor (null until
  // the second tracked frame); a parent change re-anchors.
  private remoteMountParent: Maybe<Entity> = null;
  private remotePrevRel: Vec3 | null = null;
  // `isRemoteMountParent` for the root's current parent, recomputed only when
  // the parent changes (it walks the parent chain).
  private deckParentChecked: Maybe<Entity> = null;
  private deckParentIsDeck: boolean = false;
  // The owner's last blend input from `ownerWorldVelocity`, held through an
  // anchor frame (as the remote holds its blend) instead of dropping to idle.
  private ownerHeldVelocity: Vec3 = Vec3.zero;

  private warnedMissingSpeed: boolean = false;

  /**
   * True when the character has no MovementAbility, so the locomotion blend comes from
   * observed motion instead — an NPC, moved by behaviours, physics or a scripted path.
   * Resolved in the start handlers rather than `initialize`, because a proxy never runs
   * `initialize` and still has to pick the same path.
   */
  private measuredLocomotion: boolean = false;
  private velocitySamplesX: number[] = [];
  private velocitySamplesZ: number[] = [];
  private velocitySampleIndex: number = 0;
  private measuredPreviousPosition: Vec3 | null = null;

  /**
   * Keys the BASE graph owns. Their replication key IS the graph variable / transition name
   * (a base-graph transition is layerless, so one string carries it), which is why they can be
   * applied here directly. Everything else on the channel belongs to a module.
   */
  private static readonly baseGraphKeys: ReadonlySet<string> = new Set<string>([
    AnimKey.IS_GROUNDED,
    AnimKey.IS_JUMPING,
    AnimKey.IS_RECENTLY_GROUNDED,
    AnimKey.JUMP_TRIGGER,
  ]);

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  private onEntityStart(): void {
    this.startShared();
  }

  /**
   * Remote (proxy) setup. The owner-side `initialize` / `update` never run here, so a proxy
   * resolves its own animator and transform, builds the smoother, and mounts the same modules —
   * they play from the replication callbacks.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.NonOwner})
  private onRemoteEntityStart(): void {
    this.transformComponent = this.entity.getComponent(TransformComponent);
    this.speedSmoother = new CharacterSpeedSmoother();
    this.startShared();
  }

  private startShared(): void {
    const animatorEntity = this.animatorEntity ?? this.entity;
    const animator =
      animatorEntity.getComponent(AnimatorComponent) ??
      this.entity.getChildrenWithComponent(AnimatorComponent, true)[0]?.getComponent(
        AnimatorComponent,
      );
    if (!animator) {
      throw new Error('AnimatorComponent not found on the assigned entity or its children');
    }
    this.animator = animator;
    this.resolveLocomotionSource();
    // Mount before binding because binding immediately replays persistent network state.
    this.mountModules();
    this.bindStateReplication();
  }

  /** Mount every feature module on owner and proxy clients. */
  private mountModules(): void {
    for (const module of this.modules) {
      module.attach(this);
      module.onCharacterStart?.(this.entity);
    }
  }

  /**
   * Resolve the optional replication layer and drive the animator from its callbacks. Replays
   * the current VALUE snapshot once so a late joiner converges; triggers are never replayed.
   */
  private bindStateReplication(): void {
    this.stateReplication =
      this.entity.getComponent(WorldsCharacterStateReplication) ??
      this.entity
        .getChildrenWithComponent(WorldsCharacterStateReplication, true)[0]
        ?.getComponent(WorldsCharacterStateReplication) ??
      null;
    if (!this.stateReplication) {
      return;
    }
    this.stateReplication.addStateListener((key, value) => this.dispatchValue(key, value, false));
    this.stateReplication.addTriggerListener((key) => this.dispatchTrigger(key));
    for (const entry of this.stateReplication.replicatedState) {
      // fromStateEntry reconstructs the JS type from the wire number, so a Bool graph var does
      // not get a numeric 0 at frame 0. `replayed` marks this as a join-time snapshot rather
      // than a live change — a module holding a persistent pose seeds to its end frame.
      this.dispatchValue(entry.key, fromStateEntry(entry), true);
    }
  }

  /** Apply a replicated value: to the base graph if it owns the key, then to every claimant. */
  private dispatchValue(key: string, value: ReplicatedValue, replayed: boolean): void {
    if (CharacterAnimationController.baseGraphKeys.has(key)) {
      this.animator.setGraphVariable(key, value);
    }
    const claimants = this.modulesByNetKey.get(key);
    if (claimants) {
      for (const module of claimants) {
        module.onNetValue?.(key, value, replayed);
      }
    }
  }

  /**
   * Fire a replicated one-shot. Base-graph and module handling are additive, not exclusive: the
   * jump trigger is a base-graph transition AND the edge the airborne pass starts from, and
   * both need it.
   */
  private dispatchTrigger(key: string): void {
    if (CharacterAnimationController.baseGraphKeys.has(key)) {
      this.animator.requestTransition(key);
    }
    const claimants = this.modulesByNetKey.get(key);
    if (claimants) {
      for (const module of claimants) {
        module.onNetTrigger?.(key);
      }
    }
  }

  /** Decide once whether locomotion comes from MovementAbility or from observed motion. */
  private resolveLocomotionSource(): void {
    this.measuredLocomotion = this.entity.getComponent(MovementAbility) == null;
    if (!this.measuredLocomotion) {
      return;
    }
    // Seed the safe stance once, before `bindStateReplication()` replays any snapshot. The
    // per-frame pin in `driveMeasuredLocomotion()` now fires only for a pure puppet, so a
    // measured entity that carries a replication channel but whose stance write never reaches
    // this client (owner `update()` not ticked, or a proxy before the first snapshot) would
    // otherwise sit at the graph's airborne default. This floor keeps it at the previous
    // grounded stance until a real write — the owner's `publishStance()` or a proxy's replayed
    // snapshot — overwrites it.
    this.animator.setGraphVariable(AnimKey.IS_GROUNDED, true);
    this.animator.setGraphVariable(AnimKey.IS_RECENTLY_GROUNDED, true);
    this.animator.setGraphVariable(AnimKey.IS_JUMPING, false);
    this.transformComponent ??= this.entity.getComponent(TransformComponent);
    const frames = Math.max(1, Math.floor(this.smoothingFrameCount));
    this.velocitySamplesX = new Array<number>(frames).fill(0);
    this.velocitySamplesZ = new Array<number>(frames).fill(0);
    this.velocitySampleIndex = 0;
    this.measuredPreviousPosition = null;
  }

  public initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity): void {
    this.stateMachine = characterRootEntity.getComponent(CharacterStateMachine);
    this.movementComponent = characterRootEntity.getComponent(MovementAbility);
    this.transformComponent = characterRootEntity.getComponent(TransformComponent);
    // The force controller usually lives on the simulated (physics) entity; fall back to root.
    this.characterForceController =
      characterSimulatedEntity.getComponent(CharacterForceControllerBase) ??
      characterRootEntity.getComponent(CharacterForceControllerBase);
    // Optional: a template without the ride fix simply has no such component,
    // and Speed behaves exactly as before.
    this.platformRide =
      characterSimulatedEntity.getComponent(MovingPlatformRideComponent);

    for (const module of this.modules) {
      module.onCharacterReady?.(characterRootEntity, characterSimulatedEntity);
    }

    // The jump edge goes onto the wire once. The base graph takes it as a transition and any
    // module that claimed the key takes it too, on every client — this host does not know or
    // care which module that is.
    this.subscribe(JumpStartedEvent, () => this.fireNet(AnimKey.JUMP_TRIGGER));
  }

  /**
   * Publish the stance the base graph transitions on: grounded, recently grounded, jumping.
   *
   * Runs for measured characters as well as driven ones, which is what lets an NPC play the
   * player's jump. These three come from the state machine, not from locomotion, so the
   * measured/driven split has no bearing on them — an actor whose jump is commanded by a
   * behaviour reaches `StateId.Jumping` exactly as a player pressing the button does.
   *
   * `applyBool` replicates when a channel is present and only RPCs on an actual transition,
   * so a proxy sees the same stance without this costing per-frame traffic.
   */
  private publishStance(): void {
    this.applyBool(AnimKey.IS_GROUNDED, this.stateMachine?.isGrounded() ?? true);
    this.applyBool(
      AnimKey.IS_RECENTLY_GROUNDED,
      this.stateMachine?.isNearlyGrounded(this.groundedThreshold) ?? true,
    );
    this.applyBool(
      AnimKey.IS_JUMPING,
      (this.stateMachine?.getCurrentState() ?? StateId.Movement) === StateId.Jumping,
    );
  }

  /** Owner-side per-frame, inside the character's ordered update (after physics). */
  public update(): void {
    // Stance first, and OUTSIDE the measured early return below. A measured character still
    // has a state machine, and the base graph cannot reach its jump pose without these.
    this.publishStance();

    // Measured mode drives locomotion on every client from the Everywhere handler, so the
    // owner path has nothing else to do — including the ordered module tick, which exists to
    // read this frame's physics and a measured character has none to read.
    if (this.measuredLocomotion) {
      return;
    }
    let velocity = Vec3.zero;
    if (this.movementComponent) {
      velocity = this.movementComponent.getDesiredVelocity();
    }
    if (this.characterForceController) {
      // Parented by something other than the ride (a seat, a vehicle): read
      // motion relative to that parent, as every remote does, so all
      // endpoints animate the same. The ride's own mounts use its published
      // deck-relative velocity below.
      const sampledVelocity = this.ownerWorldVelocity(
        this.characterForceController.sampledVelocity,
        this.characterForceController.syncedMoveDeltaSeconds,
      );
      const desiredSpeed = velocity.magnitude();
      // Detached riders hold no latch: a stale value would leak into the next
      // ride when its first frame lands in the hysteresis dead-band, so every
      // attach starts unlatched (motion shown until speed resolves idle).
      const rideForLatch = this.platformRide;
      if (rideForLatch == null || !rideForLatch.isAttached) {
        this.rideIdleLatched = false;
      }
      if (desiredSpeed < 0.01) {
        // No input: fall back to sampled velocity for external forces (knockback, etc.)
        // While attached with no input the rider is still relative to the deck
        // by definition, so Speed reads the deck-relative motion the ride
        // publishes (already relative — no carry subtraction). Genuine
        // relative motion above the gate, e.g. knockback while riding,
        // still animates truthfully.
        const ride = this.platformRide;
        if (ride != null && ride.isAttached) {
          const relative = ride.deckRelativeVelocity;
          const relativeSq = relative.magnitudeSquared();
          if (relativeSq < RELATIVE_IDLE_SPEED_SQ) {
            this.rideIdleLatched = true;
          } else if (relativeSq > RELATIVE_MOVE_SPEED_SQ) {
            this.rideIdleLatched = false;
          }
          velocity = this.rideIdleLatched ? Vec3.zero : relative;
        } else {
          velocity = sampledVelocity;
        }
      } else {
        // Always animate in the direction of the input, but take whichever magnitude is
        // larger so the player still gets feedback when running into a wall.
        // While attached, the sample embeds the deck motion: project the
        // deck-relative motion the ride publishes, or a rider walking with a
        // 4 m/s shuttle would show a run animation for a walk.
        const velocityDirection = velocity.normalize();
        const ride = this.platformRide;
        const deckRelative =
          ride != null && ride.isAttached
            ? ride.deckRelativeVelocity
            : sampledVelocity;
        const scalarProjection = Math.max(desiredSpeed, deckRelative.dot(velocityDirection));
        velocity = velocityDirection.mul(scalarProjection);
      }
    }

    const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    // Speed is local on every client, never networked (see the class header).
    this.animator.setGraphVariable(AnimVar.SPEED, horizontalSpeed);
    // Stance was already published by publishStance() at the top of update().
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(velocity),
    );

    this.ownerTickModules(horizontalSpeed, 0);
  }

  /**
   * Remote per-frame update (invoked by CharacterUpdateManager on non-owner clients): derive
   * velocity from the proxy's own replicated transform, smooth it, and feed the same two Blend
   * Space 2D inputs the owner feeds. Intentionally NOT run on the owner.
   */
  public remoteUpdate(deltaTime: number): void {
    if (this.measuredLocomotion || !this.speedSmoother || !this.transformComponent) {
      return;
    }
    const currentPosition = this.transformComponent.worldPosition;
    if (this.previousPosition === null || deltaTime <= 0) {
      this.previousPosition = currentPosition;
      return;
    }
    const sampledVelocity = currentPosition.sub(this.previousPosition).mul(1 / deltaTime);
    this.previousPosition = currentPosition;

    // Mounted on the owner: the proxy root carries the replicated parent
    // link, so its LOCAL position under that parent is the rider's
    // deck-relative seat on this endpoint too — difference it (animator
    // only, never a transform write: proxy transforms are replication-owned
    // and the write throws "not owned"). A standing rider's local never
    // changes, so Speed reads idle however fast the deck moves. A detected
    // mover counts even though this endpoint's registry never saw it; a
    // socket on another character does not (see isRemoteMountParent).
    const mountParent = this.entity.parent;
    if (mountParent != null && mountParent.valid && this.isDeckParent(mountParent)) {
      const relative = this.parentRelativeVelocity(mountParent, deltaTime);
      if (relative != null) {
        this.driveRemoteBlend(relative);
      }
      return;
    }
    this.remoteMountParent = null;
    this.remotePrevRel = null;
    this.driveRemoteBlend(sampledVelocity);
  }

  /**
   * The owner's motion for the blend when the ride is not carrying it: under
   * a deck-like parent (see `isRemoteMountParent`), motion relative to that
   * parent; otherwise the sampled world velocity. An anchor frame (a new
   * parent, a replication snap) has no relative sample: it repeats the last
   * input rather than read idle for a frame.
   */
  private ownerWorldVelocity(sampledVelocity: Vec3, deltaTime: number): Vec3 {
    const ride = this.platformRide;
    const parent = ride != null && ride.isAttached ? null : this.entity.parent;
    if (parent == null || !parent.valid || !this.isDeckParent(parent)) {
      this.remoteMountParent = null;
      this.remotePrevRel = null;
      this.ownerHeldVelocity = sampledVelocity;
      return sampledVelocity;
    }
    const relative = this.parentRelativeVelocity(parent, deltaTime);
    if (relative != null) {
      this.ownerHeldVelocity = relative;
    }
    return this.ownerHeldVelocity;
  }

  private isDeckParent(parent: Entity): boolean {
    if (this.deckParentChecked !== parent) {
      this.deckParentChecked = parent;
      this.deckParentIsDeck = MovingPlatformRideComponent.isRemoteMountParent(parent);
    }
    return this.deckParentIsDeck;
  }

  /**
   * Deck follow, animator only. Differences the root's LOCAL position under
   * its parent: the frame difference IS the deck-relative velocity — walking
   * animates, standing reads idle, knockback reads instantly. A parent
   * change or a replication snap re-anchors and returns null instead of a
   * sample (the anchor frame feeds nothing, so a discontinuity never
   * animates as a step). Never writes the transform.
   */
  private parentRelativeVelocity(mountParent: Entity, deltaTime: number): Vec3 | null {
    const transform = this.transformComponent;
    if (transform == null) {
      return null;
    }
    if (this.remoteMountParent !== mountParent) {
      this.remoteMountParent = mountParent;
      this.remotePrevRel = null;
    }
    const relNow = transform.localPosition;
    const prev = this.remotePrevRel;
    this.remotePrevRel = relNow;
    if (prev == null || deltaTime <= 0) {
      return null;
    }
    // The local step is in the parent's frame and units; the blend yaws by
    // the character's world rotation, so hand it world axes.
    const parentTransform = mountParent.getComponent(TransformComponent);
    const localStep = relNow.sub(prev);
    const world =
      parentTransform != null
        ? parentStepToWorld(
            parentTransform.worldRotation,
            parentTransform.worldScale,
            localStep,
          )
        : localStep;
    const step = new Vec3(world.x, world.y, world.z);
    // Teleport guard: a replication snap jumps the local, not the seat —
    // re-anchor instead of flinging the blend.
    if (
      step.magnitude() >
      deckTeleportThresholdMeters(
        DEFAULT_MAX_DECK_SPEED_METERS_PER_SECOND,
        deltaTime,
      )
    ) {
      return null;
    }
    return step.mul(1 / deltaTime);
  }

  /** Feed one velocity sample through smoothing and the blend. */
  private driveRemoteBlend(velocity: Vec3): void {
    this.speedSmoother!.update(velocity);
    const smoothed = this.speedSmoother!.averagedVelocity;
    this.animator.setGraphVariable(
      AnimVar.SPEED,
      Math.sqrt(smoothed.x * smoothed.x + smoothed.z * smoothed.z),
    );
    // Without this the Blend Space 2D x input stays at its default 0 on the proxy and every
    // direction collapses to "Walk Fwd" — strafe and back never play.
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(smoothed),
    );
  }

  /** Every client: measured locomotion, then the layers' client-local tick (masks included). */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onEveryClientUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.measuredLocomotion) {
      this.driveMeasuredLocomotion(payload.deltaTime);
    }
    this.clientTickModules(payload.deltaTime);
  }

  private ownerTickModules(speed: number, deltaTime: number): void {
    const frame: AnimationFrame = {deltaTime, speed, maskRamp: this.maskRamp(speed)};
    for (const module of this.modules) {
      module.onOwnerUpdate?.(frame);
    }
  }

  /**
   * `speed` is read back off the animator rather than taken from whichever path wrote it, so
   * the mask ramp is identical on owner, proxy and measured characters.
   */
  private clientTickModules(deltaTime: number): void {
    // An unreadable Speed degrades the mask ramp ONLY. Skipping the tick outright would also
    // stop every layer's onUpdate for the entity's lifetime, which is a far wider blast radius
    // than the value it depends on — no layer should lose its per-frame work because a blend
    // input is missing.
    const speed = this.readSpeed() ?? 0;
    const frame: AnimationFrame = {deltaTime, speed, maskRamp: this.maskRamp(speed)};
    for (const module of this.modules) {
      module.onUpdate?.(frame);
    }
  }

  private readSpeed(): number | null {
    const speed = this.animator.getGraphVariable(AnimVar.SPEED);
    if (typeof speed === 'number') {
      return speed;
    }
    if (!this.warnedMissingSpeed) {
      this.warnedMissingSpeed = true;
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- latched to fire at most once per entity
      console.warn(
        `[CharacterAnimationController] graph variable '${AnimVar.SPEED}' is not a float; layer mask ramps will read 0`,
      );
    }
    return null;
  }

  /** A zero/negative full-speed collapses the ramp into an on/off step instead of dividing by <= 0. */
  private maskRamp(speed: number): number {
    if (this.actionMaskFullSpeed > 0) {
      return Math.max(0, Math.min(1, speed / this.actionMaskFullSpeed));
    }
    return speed > 0 ? 1 : 0;
  }

  /**
   * Locomotion blend for a character with no MovementAbility. Runs on every client — each one
   * measures the transform it already has, so the blend needs nothing off the wire.
   */
  private driveMeasuredLocomotion(deltaTime: number): void {
    if (!this.transformComponent) {
      return;
    }
    const worldPosition = this.transformComponent.worldPosition;
    if (this.measuredPreviousPosition === null || deltaTime < 0.0001) {
      this.measuredPreviousPosition = worldPosition;
      return;
    }
    const displacement = worldPosition.sub(this.measuredPreviousPosition);
    this.measuredPreviousPosition = worldPosition;

    this.velocitySamplesX[this.velocitySampleIndex] = displacement.x / deltaTime;
    this.velocitySamplesZ[this.velocitySampleIndex] = displacement.z / deltaTime;
    this.velocitySampleIndex = (this.velocitySampleIndex + 1) % this.velocitySamplesX.length;

    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < this.velocitySamplesX.length; i++) {
      sumX += this.velocitySamplesX[i];
      sumZ += this.velocitySamplesZ[i];
    }
    const averageX = sumX / this.velocitySamplesX.length;
    const averageZ = sumZ / this.velocitySamplesZ.length;

    const rawSpeed = Math.sqrt(averageX * averageX + averageZ * averageZ);
    const clampedSpeed = Math.min(rawSpeed, this.maxSpeedClamp);
    const finalSpeed =
      clampedSpeed < this.minSpeedThreshold ? 0 : clampedSpeed * this.speedMultiplier;

    this.animator.setGraphVariable(AnimVar.SPEED, finalSpeed);
    // Pin the constant stance ONLY for a pure puppet actor — one with no source of real
    // stance on THIS client. The owner reads stance from `stateMachine`; a proxy, whose
    // owner-only `initialize` never runs and so holds a null `stateMachine`, reads it from
    // the replication channel that `publishStance()` writes to. This handler is
    // `ExecuteOn.Everywhere`, so gating on `stateMachine` alone would refire the pin on every
    // proxy and stomp that replicated stance each frame — the same ground-pose bug, now seen
    // only by observers. A puppet has neither source, and grounded is the right answer for it.
    if (!this.stateMachine && !this.stateReplication) {
      this.animator.setGraphVariable(AnimKey.IS_GROUNDED, true);
      this.animator.setGraphVariable(AnimKey.IS_JUMPING, false);
    }
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(new Vec3(averageX, 0, averageZ)),
    );
    // A measured character is turned by its own movement controller rather than by look
    // input, so the graph reads direction off MovementDirectionYaw.
    this.animator.setGraphVariable(AnimVar.SHOULD_STRAFE, true);
  }

  /**
   * Apply a networked bool: predict + replicate when a channel is present (its change-check
   * means it only RPCs on an actual transition), else dispatch locally — exactly as a
   * replicated value would, so the base graph AND every layer that claimed the key see it.
   * Writing straight to `setGraphVariable` here instead reaches the base graph but skips the
   * layers, so a measured single-player character's airborne layer never learned it was
   * jumping and held its ground pose through the flight.
   */
  private applyBool(key: string, value: boolean): void {
    if (this.stateReplication) {
      this.stateReplication.requestState(key, value);
    } else {
      this.dispatchValue(key, value, false);
    }
  }

  private getRelativeMovementYaw(worldVelocity: Vec3): number {
    if (!this.transformComponent || worldVelocity.magnitudeSquared() < 0.01) return 0;

    const relativeVelocity = this.transformComponent.worldRotation.inverse().mulVec3(worldVelocity);
    if (relativeVelocity.magnitudeSquared() < 0.01) return 0;

    const moveAngle = Math.atan2(relativeVelocity.x, relativeVelocity.z) * (180 / Math.PI);
    const characterAngle = Math.atan2(Vec3.forward.x, Vec3.forward.z) * (180 / Math.PI);

    let yaw = moveAngle - characterAngle;
    if (yaw > 180) yaw -= 360;
    if (yaw < -180) yaw += 360;
    return yaw;
  }
}

function indexByAction(modules: readonly AnimationModule[]): Map<string, AnimationModule> {
  const byAction = new Map<string, AnimationModule>();
  for (const module of modules) {
    for (const action of module.actions ?? []) {
      if (byAction.has(action)) {
        throw new Error(`[CharacterAnimationController] duplicate animation action '${action}'.`);
      }
      byAction.set(action, module);
    }
  }
  return byAction;
}

function indexByNetKey(modules: readonly AnimationModule[]): Map<string, AnimationModule[]> {
  const byKey = new Map<string, AnimationModule[]>();
  for (const module of modules) {
    for (const key of module.netKeys ?? []) {
      // Several modules may claim one key — the jump edge starts both the base graph's
      // transition and the airborne pass — so every claimant is kept.
      const claimants = byKey.get(key);
      if (claimants) {
        claimants.push(module);
      } else {
        byKey.set(key, [module]);
      }
    }
  }
  return byKey;
}
