/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v17

/**
 * MovingPlatformRideComponent
 *
 * Component Attachment: the character's simulated entity (`KinematicCharacter`
 *   in Templates/PlayerCharacter.hstf), beside `WorldsGroundInfoComponent` and
 *   the kinematic force controller.
 * Component Networking: Owner — only the owner (re)parents its own root;
 *   remote proxies compose from the replicated parent link and need no ride
 *   logic.
 *
 * Attaches a standing character to the moving platform beneath it by
 * PARENTING the character root to the platform entity (a Tracked `setParent`
 * with `preserveWorldTransform`), so the engine's own hierarchy composition
 * carries the rider: position AND yaw arrive together, on every endpoint,
 * with no velocity to compute and nothing to replicate. Detachment unparents
 * 1:1 (`setParent(null, preserve)`), then removes any shear a scaled deck
 * folded into the root (`unparentRider`).
 *
 * WHY PARENTING, NOT CARRY VELOCITY. An earlier revision fed the platform's
 * analytic surface velocity into the kinematic force controller as
 * `platformCarryVelocity`. That worked single-player but left remotes to
 * re-derive the deck frame from mount tokens and per-mover deck APIs —
 * replicated state plus analytic code that had to agree on every endpoint.
 * The hierarchy already IS the relative transform: the owner's local is
 * replicated, the parent link is replicated (`ParentTrackingComponent`), and
 * each remote composes proxy world = live local deck * replicated local.
 * There is no smoother to tune, no token to resolve, no provider to query.
 *
 * NO DOUBLE-DRIVE. Parenting moves the owner's transforms, and the
 * kinematic character controller (`KinematicCharacterController::update`)
 * starts every frame by re-reading the hierarchy-composed world transform
 * (Step 1) before applying the TS move delta (Step 2). The hierarchy motion
 * is therefore absorbed, not added: handing the platform delta to the KCC
 * as well would move the rider twice. So while attached the ride hands the
 * force controller NOTHING — the KCC integrates input, gravity, and friction
 * exactly as on static ground, sweeping from the composed position, and
 * collision still resolves against the deck. The `platformCarryVelocity`
 * feed is gone; the force controller is untouched by a parented ride (see
 * CARRY WITHOUT A PARENT for the one exception).
 *
 * WHAT THE RIDE STILL COMPUTES. Two things, both from the live hierarchy:
 * the mount state machine (attach/detach timing, below), and the rider's
 * deck-relative velocity — the frame difference of the root's LOCAL position
 * under the parent, rotated and scaled into world axes, teleport-guarded.
 * The animation controller reads it as `deckRelativeVelocity`: a standing
 * rider's local never changes, so Speed reads idle however fast the deck
 * moves, while genuine relative motion (walking, knockback, jump arcs)
 * animates truthfully. No carry subtraction: the value is already relative.
 *
 * ATTACH / DETACH (mirrors the engine's `WorldsRelativeTransformSystem`).
 * Attachment requires the
 * full mount condition: the ground link is valid, the rider is touching the
 * platform (feet within `TOUCH_DISTANCE_METERS`), the nearest registered
 * mover in the hit entity's ancestry is alive, and the root is not parented
 * elsewhere (the ride never steals a link it does not own). The mount target
 * is always the mover ROOT, never a child collider: only networked entities
 * have online ids, and a cross-host parent (online child, offline parent) is
 * softly rejected by the engine — child colliders are not networked, mover
 * roots are (editor `isNetworkable`). Ground with no registered mover mounts
 * once it is seen MOVING: the highest ancestor of the hit collider that moved
 * since last frame while staying rigid with the collider is the mover (so a
 * script that moves a platform root and a physics body on `DriveMode.Kinematic`
 * both mount with no registration, and a Ferris wheel's level car is mounted,
 * not the wheel turning around it), unless it is a free-simulated dynamic body
 * (a prop).
 * Detection is per mount, never registration: once mounted the rider stays on
 * the same platform through its pauses, and a platform that stopped for good
 * is never mounted again.
 *
 * CARRY WITHOUT A PARENT. When the engine refuses the parent link (a
 * platform root that is not networked, which is how scripts and tools create
 * entities by default), the ride carries the rider by the platform's
 * frame-to-frame motion instead: each frame it maps the rider's seat in last
 * frame's deck pose onto this frame's pose and hands the difference to the
 * kinematic force controller as `carryDisplacement`, a position offset added
 * to the KCC move (no velocity, so nothing survives a jump), and the deck's
 * yaw as `carryYawRadians`, so a spinner turns its rider as a parent would. The rider still
 * reads `isAttached` with a deck-relative velocity, so it idles while
 * standing. Remotes see an unparented root moving with the deck, so they
 * animate its world motion: networking the platform root restores the
 * parented ride everywhere. Each rider remembers the platforms that refused
 * it; each platform's carry is logged once. A rider the force controller can
 * carry is also carried this way, never parented, where the link would
 * shear it (`parentKeepsRiderUndistorted`): under a root scaled unevenly
 * across its floor, mirrored, or scaled unevenly and tilted off upright, the
 * rider's turn composes into a sheared transform: it renders skewed, and
 * unparenting folds the shear into a lasting scale and tilt on its root (so
 * when the ride unparents its rider from a deck that shears it, it restores
 * the up the rider had when parented and its scale, keeping any resize made
 * during the ride). A deck that tilts further mid-ride (a banking cart)
 * hands its parented rider to the carry for the rest of that ride, past a
 * wider bound than the mount's so a slight wobble keeps the link; the next
 * mount decides afresh. A root scaled evenly across its floor that stays
 * upright (a deck scaled to size) parents like any other, keeping the
 * multiplayer ride.
 * Detachment unparents immediately on grounded step-off (static floor,
 * another platform), on a dead target, or on jump takeoff (a jump leaves
 * ballistically in the world frame, so the deck must not carry the rider
 * through the hop), and after `detachmentGracePeriod` of link loss while
 * airborne otherwise — a cast flicker (briefly airborne, still parented)
 * neither attaches nor detaches. A rider-side teleport (a teleport-guarded
 * jump in the deck-relative position) detaches at once: otherwise the old
 * deck would drag the teleported rider through the grace window. Deck
 * teleports need no handling: the hierarchy preserves the relative position
 * across them by construction.
 *
 * Registration (layering): the registry lives here and movers register
 * themselves, so a mover depends on this component and never the reverse.
 * Registration carries only the
 * detachment grace; there is no velocity API to implement, so a physics
 * drift deck and a scripted spinner register identically.
 *
 * Lifecycle: an `ICharacterInitializable`, so `CharacterSimulationController`
 * initializes it with the entity pair and deactivates it when the simulated
 * body is swapped out — a disabled simulation unparents at once and never
 * leaves a stale link gluing the character to a deck.
 *
 * Ordering: driven explicitly by `CharacterSimulationController.update()`,
 * immediately before the force controller integrates — an explicit call, not
 * an event subscription, so the order is structural and can never interleave
 * or invert. Never subscribe this component to `OnWorldUpdateEvent` directly:
 * a second update path would double-publish the deck-relative velocity.
 *
 * Yaw: the hierarchy turns the rider with the deck — no yaw code, no debt,
 * no rotation lock. `AutoFaceRotationAbility` (which owns root facing)
 * re-derives from the current heading on its idle branch, so the two compose
 * instead of fighting.
 *
 * Animation: the component publishes `isAttached` plus `deckRelativeVelocity`,
 * readable after physics runs. The animation controller (input-gated idle,
 * lands above in the stack) gates on them: attached + no input means the
 * rider is still relative to the deck, so Speed reads the deck-relative
 * motion directly. Remotes run no ride: the proxy root's replicated LOCAL
 * position under its replicated parent link differences into the same
 * deck-relative velocity on the remote (see
 * `CharacterAnimationController.remoteUpdate`).
 *
 * What it does NOT do:
 * - Step-off momentum beyond the grace window: once detached, the deck stops
 *   carrying (jump, walk-off, teleport). No fling is imparted.
 */

import {
  CharacterControllerBase,
  component,
  editor,
  ExecuteOn,
  OnGlobalEntityDestroyEvent,
  PhysicsBodyComponent,
  PhysicsBodyDriveMode,
  PhysicsBodyType,
  property,
  subscribe,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
  type OnGlobalEntityDestroyEventPayload,
  Quaternion,
} from 'meta/worlds';
import {ICharacterInitializable} from '../ICharacterInitializable';
import {JumpAbility} from '../Abilities/JumpAbility';
import {CharacterForceControllerBase} from '../Force/CharacterForceControllerBase';
import {WorldsGroundInfoComponent} from './WorldsGroundInfoComponent';
import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  DEFAULT_MAX_DECK_SPEED_METERS_PER_SECOND,
  deckTeleportThresholdMeters,
  MAX_RIDER_SHEAR_WHILE_RIDING,
  parentKeepsRiderUndistorted,
  parentStepToWorld,
  poseChanged,
  relativePose,
  riderShear,
  rotateVector,
  seatInDeck,
  seatToWorld,
  tiltDegrees,
  upOf,
  withUp,
  yawDeltaRadians,
} from './MovingPlatformCarryMath';
import {MovingPlatformMoverBase} from './MovingPlatformMoverBase';
import {CharacterStateMachine} from '../State/CharacterStateMachine';

// Feet-to-deck distance within which the rider counts as touching the
// platform (embodiment's `kGroundContactThreshold_`). Compared against the
// slope-compensated distance (`isNearlyGrounded`), since the raw
// straight-down cast over-measures on slopes.
const TOUCH_DISTANCE_METERS = 0.05;

// Bound on remembered per-platform sets (spawned/destroyed platforms).
export const MAX_REMEMBERED_PLATFORMS = 256;
// Depth bound for every ancestor walk (scene hierarchies are shallow).
const MAX_ANCESTOR_DEPTH = 16;

/** Remember `entity`, evicting the oldest entry (insertion order) when full,
 * so every other platform's history survives. */
export function rememberBounded(set: Set<Entity>, entity: Entity): void {
  if (set.has(entity)) {
    return;
  }
  if (set.size >= MAX_REMEMBERED_PLATFORMS) {
    const oldest = set.values().next();
    if (!oldest.done) {
      set.delete(oldest.value);
    }
  }
  set.add(entity);
}

/**
 * Part of a character: the simulated entity (a ride, a character controller
 * or a character force controller) or the character root (its state
 * machine), which holds the sockets. Moving characters are never ground to
 * mount, however they move.
 */
function isCharacterEntity(entity: Entity): boolean {
  return (
    entity.getComponent(MovingPlatformRideComponent) != null ||
    entity.getComponent(CharacterControllerBase) != null ||
    entity.getComponent(CharacterForceControllerBase) != null ||
    entity.getComponent(CharacterStateMachine) != null
  );
}

// Per-axis slack before an unparented rider's world scale counts as changed.
const RESTORED_SCALE_SLACK = 1e-4;

// Rider shear (see `riderShear`) below which unparenting leaves no visible
// trace on the rider: its unparented pose is left alone.
const SETTLE_SHEAR_EPSILON = 1e-3;

/** The rider root's world scale and up. */
type RiderPose = {worldScale: Vec3; up: Vec3};

/**
 * The rider root's pose as the ride parented it (see `unparentRider`): world
 * scale and up read just before the link, local scale just after, and
 * whether the deck shears the rider as last seen while riding.
 */
type RiderPoseWhenParented = RiderPose & {localScale: Vec3; deckShears: boolean};

/** `a / b`, or 1 when `b` is too small to divide by. */
function scaleRatio(a: number, b: number): number {
  return Math.abs(b) > 1e-6 ? a / b : 1;
}

/**
 * How much `platform`'s pose shears a rider parented under it (see
 * `riderShear`), or null when its pose cannot be read.
 */
function deckShearOf(platform: Entity | null): number | null {
  if (platform == null || !platform.valid) {
    return null;
  }
  const deck = platform.getComponent(TransformComponent);
  const scale = deck?.worldScale;
  const rotation = deck?.worldRotation;
  return scale != null && rotation != null ? riderShear(scale, rotation) : null;
}

/** `parentKeepsRiderUndistorted` for an entity's world pose (no transform: yes). */
function parentKeepsRiderUndistortedUnder(entity: Entity): boolean {
  const transform = entity.getComponent(TransformComponent);
  return (
    transform == null ||
    parentKeepsRiderUndistorted(transform.worldScale, transform.worldRotation)
  );
}

/**
 * A body physics simulates freely (a crate, a ball): it tumbles, and
 * parenting a rider to it would roll the rider with it. Script-driven
 * bodies (`Kinematic` or `VelocityDrive`) and colliders are rideable.
 */
function isFreeSimulatedBody(entity: Entity): boolean {
  const body = entity.getComponent(PhysicsBodyComponent);
  return (
    body != null &&
    body.type === PhysicsBodyType.DynamicCollider &&
    body.driveMode === PhysicsBodyDriveMode.None
  );
}

/**
 * What a mover registers: only its detachment grace. There is no velocity
 * API — the hierarchy carries the rider, so scripted and physics-driven
 * movers register identically.
 */
export type MovingPlatformRegistration = {
  /** Seconds of link loss the mount tolerates before detaching. */
  gracePeriodSeconds: number;
};

@component({
  description:
    'Attaches a standing character to moving platforms (spinners, shuttles, elevators) it stands on.',
})
export class MovingPlatformRideComponent extends ICharacterInitializable {
  private static movers = new Map<Entity, MovingPlatformRegistration>();
  /**
   * Entities with no mover in ancestry (static floor, props), mapped to
   * their parent and grandparent when cached. Hits skip the per-frame
   * registered-mover walk (registry and component lookups per ancestor); the
   * motion probe still samples the hit's chain, since an unregistered
   * platform can start moving at any time. A changed parent chain re-walks,
   * so reparenting under a
   * registered mover is picked up. Cleared on (un)register and past 512
   * entries (self-healing bound for spawned/destroyed props). Residual
   * staleness needs re-ancestoring above the grandparent at runtime, which
   * scenes do not do outside of editor reparenting.
   */
  private static noMoverCache = new Map<
    Entity,
    {parent: Entity | null; grandparent: Entity | null}
  >();

  /**
   * Live ride components, so a dying mover unmounts its riders synchronously:
   * the next frame's validity check runs after native already hides the dying
   * parent link, when `detach` can no longer see the link it owns. Added on
   * initialize, removed on deactivate; entries whose own root died are pruned
   * on use.
   */
  private static liveRides = new Set<MovingPlatformRideComponent>();

  /**
   * Platforms the engine refused as this rider's parent (a non-networked
   * root cannot parent a networked character): carried without a parent,
   * never re-parented. Per rider, since the refusal depends on the pair.
   */
  private unparentableMounts = new Set<Entity>();
  /** Platforms whose ride mode was already logged, so each logs once. */
  private static announcedMounts = new Set<Entity>();
  /** Platforms whose scale-driven carry was already logged. */
  private static announcedScaledMounts = new Set<Entity>();
  /** Platforms whose distorting link to a rig without the carry was already logged. */
  private static announcedShearedParents = new Set<Entity>();
  /** Platforms whose refusal (no link, no carry) was already logged. */
  private static announcedUncarriedMounts = new Set<Entity>();

  /**
   * Called by mover components on start (the experiment movers land above in
   * the stack), or lazily by `isMoverEntity` on first sight. Registration is
   * per-endpoint (the map lives in this endpoint's JS context), so every
   * endpoint resolves against its own live deck — including remotes, which
   * read the proxy's parent link against their local registry for the
   * animator.
   */
  public static registerMover(
    entity: Entity,
    registration: MovingPlatformRegistration,
  ): void {
    MovingPlatformRideComponent.movers.set(entity, registration);
    // A newly registered mover may sit above a cached miss: drop the cache.
    MovingPlatformRideComponent.noMoverCache.clear();
  }

  public static unregisterMover(entity: Entity): void {
    MovingPlatformRideComponent.movers.delete(entity);
    MovingPlatformRideComponent.noMoverCache.clear();
    // Destroy unmounts here, not next frame: riders detach while the parent
    // link is still visible. Afterwards native hides the dying parent (reads
    // null with the raw link intact) and a late detach would leave the rider
    // glued to the dead platform.
    MovingPlatformRideComponent.detachRidersFrom(entity);
  }

  /**
   * Unmount every live ride on a dying platform. Rides whose own root is
   * already gone are dropped from tracking instead: nothing to unparent.
   * Matches by identity string as well as identity, since a destroy payload
   * can carry a new reference for the same entity.
   */
  private static detachRidersFrom(platform: Entity): void {
    const tag = platform.toString();
    for (const ride of [...MovingPlatformRideComponent.liveRides]) {
      const root = ride.characterRoot;
      if (root == null || !root.valid) {
        MovingPlatformRideComponent.liveRides.delete(ride);
        continue;
      }
      const target = ride.targetPlatform;
      if (target === platform || (target != null && target.toString() === tag)) {
        ride.detach();
      }
    }
  }

  /** True when the entity is a registered mover (live registry, any endpoint).
   * A registry miss falls back to component presence: movers whose own
   * onStart never fires on this endpoint (proxy-replicated dynamics execute
   * no scripts on clients) register lazily on first sight, with
   * `DEFAULT_GRACE_PERIOD_SECONDS` (0.5 s) rather than the 1.0 s the movers'
   * own onStart registers -- a backstop path, since onStart registration runs
   * on every endpoint where the mover script executes.
   */
  public static isMoverEntity(entity: Entity): boolean {
    if (MovingPlatformRideComponent.movers.has(entity)) {
      return true;
    }
    return MovingPlatformRideComponent.tryLazyRegister(entity);
  }

  /**
   * Whether a character root parented under `parent` reads its motion
   * relative to that parent, for the animator on every endpoint: a registered
   * mover, or any parent outside a character rig (the owner may have mounted
   * ground it detected by motion, which no registry on a remote endpoint
   * saw; a seat or vehicle that parents the root reads the same way on the
   * owner, so endpoints agree). A socket on another character (carried,
   * attached) is not a platform: walking up the parent chain finds the
   * character. Callers cache the answer per parent.
   */
  public static isRemoteMountParent(parent: Entity): boolean {
    if (MovingPlatformRideComponent.isMoverEntity(parent)) {
      return true;
    }
    let current: Entity | null = parent;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current != null; depth++) {
      if (isCharacterEntity(current)) {
        return false;
      }
      current = current.parent;
    }
    return true;
  }

  // Presence fallback via the shared mover base class (all experiment movers
  // extend `MovingPlatformMoverBase`, which lives beside this component so
  // the check needs no import of the unsynced mover modules and forms no
  // cycle); at runtime this is the real class.
  private static tryLazyRegister(entity: Entity): boolean {
    if (entity.getComponent(MovingPlatformMoverBase) != null) {
      MovingPlatformRideComponent.registerMover(entity, {
        gracePeriodSeconds: DEFAULT_GRACE_PERIOD_SECONDS,
      });
      return true;
    }
    return false;
  }

  @editor({
    description:
      'Master switch. Turn off to restore the old behavior (platforms slide out from under the rider).',
  })
  @property()
  enabled: boolean = true;

  @editor({
    description:
      'Speed bound (m/s) for the deck-relative teleport guard. A single-frame relative jump larger than this bound (plus slack) is a rider teleport, not travel — the rider detaches instead of flinging the animator. Legitimate relative motion peaks well below this.',
  })
  @property()
  maxDeckSpeedMetersPerSecond: number =
    DEFAULT_MAX_DECK_SPEED_METERS_PER_SECOND;

  @editor({
    description:
      'Log one [RideDBG] line per second while attached (platform, relative speed). Disable before landing.',
  })
  @property()
  debugLogging: boolean = false;

  private groundInfo: Maybe<WorldsGroundInfoComponent> = null;
  private forceController: Maybe<CharacterForceControllerBase> = null;
  private rootTransform: Maybe<TransformComponent> = null;
  private characterRoot: Maybe<Entity> = null;
  // Jump state polled from the root's ability (which lives on the character
  // root, not the simulated entity): a takeoff detaches at once so the deck
  // never carries a jump. Cached at initialize; null when the rig has none.
  private jumpAbility: Maybe<JumpAbility> = null;

  private initialized: boolean = false;
  private simActive: boolean = false;

  /**
   * Mounted platform: the registered mover that owns the mount (the mover
   * root, not the child collider the cast hit), kept across frames
   * (embodiment's `targetId`) so a flickering ground link doesn't re-resolve
   * every frame — and so stepping between child colliders of one mover does
   * not count as a re-attach. Null while detached.
   */
  private targetPlatform: Entity | null = null;
  /**
   * Seconds since the ground link to the target broke while still mounted.
   * Detach fires when this exceeds the target's own grace period.
   */
  private detachmentGraceTimer: number = 0;
  /**
   * Deck-relative baseline: the root's local position under the parent last
   * frame. Null until the second tracked frame — velocity needs two samples,
   * so the (re)attach frame anchors and publishes zero. Cleared on every
   * detach and re-attach, so a new mount can never inherit a stale delta.
   */
  private relativeBaseline: Vec3 | null = null;

  /**
   * True while carrying without a parent link (see CARRY WITHOUT A PARENT):
   * `relativeBaseline` then holds the seat in the deck frame, and the deck's
   * last world pose anchors the next frame's carry.
   */
  private carryWithoutParent: boolean = false;
  // The rider root's pose as the ride parented it; null while the ride holds
  // no link (see `unparentRider`).
  private poseWhenParented: RiderPoseWhenParented | null = null;
  private carryDeckPosition: Vec3 | null = null;
  private carryDeckRotation: Quaternion | null = null;

  /**
   * Motion probe for ground with no registered mover: last frame's world pose
   * of each entity on the hit's ancestor chain, keyed by entity, so a mover
   * is detected on its second consecutive grounded frame wherever it sits in
   * the chain (the cast may move between colliders at different depths). Two
   * map pairs swap each probe (the maps are reused, not reallocated); emptied
   * whenever the rider leaves the ground.
   */
  private probePositions = new Map<Entity, Vec3>();
  private probeRotations = new Map<Entity, Quaternion>();
  private nextProbePositions = new Map<Entity, Vec3>();
  private nextProbeRotations = new Map<Entity, Quaternion>();

  /**
   * True while attached to a platform: the mount condition is met and the
   * root is parented to the mover, or carried without a parent. Static floor
   * never moves and therefore never attaches. `CharacterAnimationController` reads this
   * (after physics runs) to drive an input-gated idle over the
   * deck-relative motion (see the class header).
   */
  public isAttached: boolean = false;

  /**
   * The rider's deck-relative velocity (m/s, world axes): the frame
   * difference of the rider's seat on the deck, teleport-guarded. Zero on the
   * anchor frame and while detached. The animator reads this directly — no
   * carry subtraction, since the value is already relative.
   */
  public deckRelativeVelocity: Vec3 = Vec3.zero;

  private debugTimeSeconds: number = 0;
  private debugSamples: number = 0;
  private debugSpeedSum: number = 0;
  private debugMaxSpeed: number = 0;
  private debugPlatformName: string = '';

  public initialize(
    characterRootEntity: Entity,
    characterSimulatedEntity: Entity,
  ): void {
    this.characterRoot = characterRootEntity;
    this.rootTransform = characterRootEntity.getComponent(TransformComponent);
    this.groundInfo = characterSimulatedEntity.getComponent(
      WorldsGroundInfoComponent,
    );
    this.forceController = characterSimulatedEntity.getComponent(
      CharacterForceControllerBase,
    );
    this.jumpAbility = characterRootEntity.getComponent(JumpAbility);
    this.initialized =
      this.rootTransform != null && this.groundInfo != null;
    this.simActive = true;
    MovingPlatformRideComponent.liveRides.add(this);
    this.clearAttachState();
  }

  public override deactivate(): void {
    this.simActive = false;
    MovingPlatformRideComponent.liveRides.delete(this);
    this.detach();
  }

  /**
   * Backstop for movers that never unregister themselves on this endpoint:
   * lazily registered movers, and mover scripts whose own destroy handler
   * never runs here. Unregistering is idempotent with the movers' own
   * destroy handlers, so a double run only repeats a map delete and a
   * detach pass over already-detached riders.
   */
  @subscribe(OnGlobalEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onMoverDestroy(payload: OnGlobalEntityDestroyEventPayload): void {
    const destroyed = payload.entity;
    if (destroyed == null) {
      return;
    }
    if (MovingPlatformRideComponent.movers.has(destroyed)) {
      MovingPlatformRideComponent.unregisterMover(destroyed);
      return;
    }
    const tag = destroyed.toString();
    for (const mover of [...MovingPlatformRideComponent.movers.keys()]) {
      if (mover.toString() === tag) {
        MovingPlatformRideComponent.unregisterMover(mover);
        return;
      }
    }
    // Not a known mover: still prune dead ride roots and catch mounts keyed
    // by a reference the registry never saw.
    MovingPlatformRideComponent.detachRidersFrom(destroyed);
  }

  private clearAttachState(): void {
    this.poseWhenParented = null;
    this.isAttached = false;
    this.deckRelativeVelocity = Vec3.zero;
    this.targetPlatform = null;
    this.detachmentGraceTimer = 0;
    this.relativeBaseline = null;
    this.resetCarry();
  }

  private resetCarry(): void {
    this.carryWithoutParent = false;
    this.carryDeckPosition = null;
    this.carryDeckRotation = null;
    if (this.forceController != null) {
      this.forceController.carryDisplacement = Vec3.zero;
      this.forceController.carryYawRadians = 0;
    }
  }

  /**
   * Resolve the registered mover for a ground entity: the entity itself,
   * else the nearest ancestor that registered. Bounded walk (scene
   * hierarchies are shallow; a cycle guard caps it regardless). The mount
   * target is always the mover root: only networked entities have online
   * ids, and the parent link must replicate cross-host.
   */
  private findMover(entity: Entity): Entity | null {
    let current: Entity | null = entity;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current != null; depth++) {
      if (MovingPlatformRideComponent.isMoverEntity(current)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Full detach: unparent the root (only a link this ride owns — the parent
   * must be the mount target), clear the mount, and flush the debug window.
   * The next attach re-resolves from scratch.
   */
  private detach(): void {
    this.flushDebugLog();
    const root = this.characterRoot;
    const target = this.targetPlatform;
    if (root != null && target != null) {
      const parent = root.parent;
      if (parent === target || (parent == null && !this.carryWithoutParent)) {
        // A null parent under a live mount is a dying target: native hides a
        // pending-destruction parent while the raw link remains, so clear it
        // explicitly. A different live parent is never touched.
        this.unparentRider(parent === target ? target : null);
      }
    }
    this.clearAttachState();
  }

  /**
   * Attach the root to the mover, preserving world transform: the engine
   * recomputes the local (with an automatic interpolation-reset snap
   * suppression), so the attach frame itself injects no motion. Skips the
   * call when the link is already in place. Never steals a link owned
   * elsewhere: attach requires the root to be unparented or already on the
   * target.
   */
  private attach(target: Entity): boolean {
    const root = this.characterRoot;
    if (root == null) {
      return false;
    }
    const current = root.parent;
    if (current === target) {
      return true;
    }
    // Another parent is never taken over.
    if (current != null && current !== this.targetPlatform) {
      return false;
    }
    const canCarry = this.forceController?.appliesCarryDisplacement === true;
    // A rig that can be carried without a link skips one that would distort
    // it; any other rig takes the link wherever the engine allows it.
    const distorting = canCarry && !parentKeepsRiderUndistortedUnder(target);
    const knownUnparentable = distorting || this.unparentableMounts.has(target);
    if (knownUnparentable && !canCarry) {
      return this.refuseUncarried(target);
    }
    // This ride's own link (the current mount) is released first, so the new
    // mount starts clean whether it parents or carries without a parent.
    if (current != null) {
      this.unparentRider(current);
    }
    if (!knownUnparentable) {
      // Read before the link, which a deck's shear would color; kept only
      // once the engine accepts the link.
      const pose = this.readRiderPose();
      root.setParent(target, {preserveWorldTransform: true});
      if (root.parent === target) {
        this.keepRiderPose(pose, target);
        // A switch straight from a carried platform starts clean: no carry
        // mode or deck anchor survives from the previous mount.
        this.resetCarry();
        if (!canCarry && !parentKeepsRiderUndistortedUnder(target)) {
          // A rig without the carry has no other way to ride: say so.
          this.announceDistortingMount(target, true);
        }
        return true;
      }
      // The engine refused the link (a non-networked root cannot parent a
      // networked character): carry without a parent instead, and never
      // retry the link on this platform. A rig whose force controller cannot
      // apply the carry stays unmounted, also without retrying: the caller
      // detaches, and the old link is already released.
      rememberBounded(this.unparentableMounts, target);
      if (!canCarry) {
        return this.refuseUncarried(target);
      }
    }
    this.resetCarry();
    this.carryWithoutParent = true;
    if (distorting) {
      this.announceDistortingMount(target);
    }
    if (knownUnparentable) {
      return true;
    }
    console.log(
      `[MovingPlatformRide] '${target.name}' carries riders without a parent ` +
        'link: its root is not networked, so other players see the rider ' +
        'moved, not mounted. Make the platform root networked for a full ride.',
    );
    return true;
  }

  /**
   * Track the mount and publish the deck-relative velocity. Called by
   * `CharacterSimulationController.update()` before the force controller
   * integrates — never subscribe to the update event directly.
   */
  public updateCarry(dt: number): void {
    if (!this.enabled || !this.initialized || !this.simActive) {
      // A disabled simulation must not leave a stale parent link behind:
      // detach unparents at once.
      this.detach();
      return;
    }

    const groundInfo = this.groundInfo;
    if (groundInfo == null) {
      return;
    }

    // Jump takeoff sheds the mount at once: the ability's isJumping spans
    // takeoff to touchdown, so detaching here (and skipping the grace bridge
    // below while it stays true) flies the world-frame arc — a straight-up
    // jump from a moving deck lands on a different deck spot, or off it —
    // and landing clears the flag so the mount re-resolves normally. Walk-offs
    // never set the flag, so their grace carry is unchanged.
    if (this.jumpAbility?.getIsJumping() === true) {
      if (this.targetPlatform != null) {
        this.detach();
      }
      return;
    }

    // Resolve this frame's ground target, if any. Mounted targets are
    // re-validated every frame: a destroyed platform detaches immediately
    // (grace bridges link flicker, not a dead entity).
    // Touch gate, computed once: the slope-compensated check feeds both
    // resolution and the step-off test below.
    const touchingGround = groundInfo.isNearlyGrounded(TOUCH_DISTANCE_METERS);
    const groundTarget = this.resolveGroundTarget(groundInfo, touchingGround);

    if (this.targetPlatform != null && !this.targetPlatform.valid) {
      this.detach();
      return;
    }

    if (groundTarget == null) {
      // No ridable ground this frame. Grace only bridges link LOSS (airborne,
      // cast flicker): grounded contact with anything else — static floor, an
      // unresolved ledge, a DIFFERENT platform — detaches immediately instead
      // of dragging the rider on the old deck. The parent link stays through
      // grace, so cast flicker keeps following the deck; jumps bypass grace
      // via the takeoff check above and are already detached here.
      if (!touchingGround && this.targetPlatform != null) {
        this.detachmentGraceTimer += dt;
        if (this.detachmentGraceTimer >= this.gracePeriodSeconds()) {
          this.detach();
          return;
        }
        this.trackMount(dt);
        return;
      }
      this.detach();
      return;
    }

    const platformChanged =
      this.targetPlatform != null && this.targetPlatform !== groundTarget;

    if (this.targetPlatform == null || platformChanged) {
      // Attach (or re-attach): fresh mount, grace reset, link first. When
      // the root is parented elsewhere the attach is refused and the rider
      // stays unmounted — the ride never steals a link it does not own.
      if (!this.attach(groundTarget)) {
        this.detach();
        return;
      }
      const hitEntity = groundInfo.lastGoodGroundHit.shapeEntity;
      if (this.debugLogging && groundTarget !== hitEntity) {
        // eslint-disable-next-line no-console
        console.log(
          `[RideAttach] mounted ${groundTarget.name} via child collider ` +
            `${hitEntity?.name ?? '?'}.`,
        );
      }
      this.targetPlatform = groundTarget;
      this.detachmentGraceTimer = 0;
      // A new mount anchors the relative baseline next frame; velocity needs
      // two samples, so a fresh attach frame publishes zero.
      this.relativeBaseline = null;
    } else {
      // Same mount, link healthy: reset grace.
      this.detachmentGraceTimer = 0;
    }
    this.trackMount(dt);
  }

  /**
   * Seconds of link loss the current mount tolerates before detaching: the
   * mounted mover's own registered period, or the default when the entry is
   * missing (unregistered mid-ride by a destroy/recreate race).
   */
  private gracePeriodSeconds(): number {
    if (this.targetPlatform == null) {
      return DEFAULT_GRACE_PERIOD_SECONDS;
    }
    return (
      MovingPlatformRideComponent.movers.get(this.targetPlatform)
        ?.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS
    );
  }

  /**
   * This frame's ground candidate: null unless the rider is touching a live
   * entity with a registered mover in its ancestry. Touching means feet
   * within `TOUCH_DISTANCE_METERS` (embodiment's mount gate); ground detected
   * but not touched (stepping off a ledge above it) does not attach. Returns
   * the mover ROOT, so mounts are keyed by platform, not by whichever child
   * collider the cast happened to hit. Unregistered ground is mounted only
   * once it is seen moving (`detectMovingGround`).
   */
  private resolveGroundTarget(
    groundInfo: WorldsGroundInfoComponent,
    touchingGround: boolean,
  ): Entity | null {
    // Touch gate with slope compensation (computed once in `updateCarry`):
    // the raw straight-down distance over-measures on slopes, which would
    // unmount riders on tilted decks.
    if (!touchingGround) {
      this.resetProbe();
      return null;
    }
    const platform = groundInfo.lastGoodGroundHit.shapeEntity;
    if (platform == null || !platform.valid) {
      this.resetProbe();
      return null;
    }
    // Static fast path: a remembered miss skips the ancestor walk. The cached
    // parent chain is verified, so reparenting under a registered mover
    // re-walks instead of going stale. Cleared on (un)register, so a newly
    // registered mover is always found.
    const cachedChain = MovingPlatformRideComponent.noMoverCache.get(platform);
    const parent = platform.parent;
    const cacheValid =
      cachedChain !== undefined &&
      parent === cachedChain.parent &&
      (parent?.parent ?? null) === cachedChain.grandparent;
    const found =
      cachedChain !== undefined && cacheValid
        ? null
        : this.findMover(platform);
    if (found != null) {
      // Liveness: a destroyed platform must not attach. `valid` is the
      // script-side check (cf. AttackEntityInRangeBehavior). There is no
      // script API for enabled-in-hierarchy; a disabled mover stops its own
      // updates, and destroy unregisters the mover, so a stale entry
      // cannot outlive its entity.
      if (!found.valid) {
        MovingPlatformRideComponent.movers.delete(found);
        MovingPlatformRideComponent.detachRidersFrom(found);
        return null;
      }
      // A character or a body released to physics between the feet and the
      // mover (an NPC on the ship, a lift dropped to physics on it) is not
      // ground the ship carries the rider on.
      if (this.rejectsGround(platform, found)) {
        this.resetProbe();
        return null;
      }
      // An unregistered mover nested under the registered one (a lift on a
      // registered ship) is what the rider stands on once it moves relative
      // to it.
      if (found === platform) {
        this.resetProbe();
        return found;
      }
      // A nested mount already riding holds through its dwell (the lift
      // pauses at a floor while the ship carries on), as any mount does.
      const nestedMount = this.targetPlatform;
      const holdsNestedMount =
        nestedMount != null &&
        nestedMount !== found &&
        nestedMount.valid &&
        this.isUnder(platform, nestedMount) &&
        this.isUnder(nestedMount, found);
      // Only movers below the registered one matter here: stop the climb at it.
      const nestedInRegistered = this.detectMovingGround(platform, found);
      if (
        nestedInRegistered != null &&
        nestedInRegistered !== found &&
        this.isUnder(nestedInRegistered, found) &&
        // An ancestor of the held mount moving on (the cart a dwelling lift
        // rides) does not replace it; a mover below it still takes over.
        !(
          holdsNestedMount &&
          nestedInRegistered !== nestedMount &&
          this.isUnder(nestedMount, nestedInRegistered)
        )
      ) {
        return this.announceDetected(nestedInRegistered);
      }
      return holdsNestedMount ? nestedMount : found;
    }
    // Still on the mounted platform (any collider under it, and no registered
    // mover nearer the hit): keep the mount through its pauses -- unless the
    // rider stepped onto an unregistered mover nested under it (a lift on a
    // moving deck, a Ferris car boarded from the wheel). Probing continues
    // below the mount, and a mover moving relative to it takes over.
    const mounted = this.targetPlatform;
    if (mounted != null && mounted.valid && this.isUnder(platform, mounted)) {
      // A platform released to physics mid-ride (drive mode Kinematic ->
      // None) tumbles like a prop, and a character standing on the mount is
      // not the mount: never keep riding either.
      if (isFreeSimulatedBody(mounted) || this.rejectsGround(platform, mounted)) {
        this.resetProbe();
        return null;
      }
      const nested = this.detectMovingGround(platform);
      if (nested != null && nested !== mounted && this.isUnder(nested, mounted)) {
        return this.announceDetected(nested);
      }
      return mounted;
    }
    // No registered mover: mount it anyway if it is moving -- unless the
    // feet are on a character or a free body riding it (a crate on a cart),
    // which the mounted branch would reject on the next frame.
    const detected = this.detectMovingGround(platform);
    if (detected != null) {
      if (this.rejectsGround(platform, detected)) {
        this.resetProbe();
        return null;
      }
      return this.announceDetected(detected);
    }
    // Remember the miss with its current parent chain (self-healing bound
    // for spawned/destroyed props).
    if (MovingPlatformRideComponent.noMoverCache.size > 512) {
      MovingPlatformRideComponent.noMoverCache.clear();
    }
    const chainParent = platform.parent;
    MovingPlatformRideComponent.noMoverCache.set(platform, {
      parent: chainParent,
      grandparent: chainParent?.parent ?? null,
    });
    return null;
  }

  private resetProbe(): void {
    this.probePositions.clear();
    this.probeRotations.clear();
  }

  /** Log once per platform that motion detection mounted it. */
  /**
   * A platform that can neither take the parent link nor be carried without
   * one (the character's force controller applies no carry) is not ridden:
   * say so once, so it is not silently non-rideable.
   */
  private refuseUncarried(target: Entity): false {
    if (!MovingPlatformRideComponent.announcedUncarriedMounts.has(target)) {
      rememberBounded(MovingPlatformRideComponent.announcedUncarriedMounts, target);
      console.warn(
        `[MovingPlatformRide] '${target.name}' cannot carry this rider: its ` +
          'root takes no parent link (it is not networked) and the ' +
          "character's force controller applies no carry. Make the platform " +
          'root networked, or use KinematicForceController.',
      );
    }
    return false;
  }

  /**
   * Hand a parented rider to the carry without a parent, anchored at this
   * frame's deck pose so the carry picks up where the link left off. The
   * carry lasts until this ride ends (no flipping back while the deck levels
   * out); the next mount decides afresh from the deck's pose then.
   */
  private carryOnWithoutParent(platform: Entity, deck: TransformComponent): void {
    this.unparentRider(platform);
    this.resetCarry();
    this.carryWithoutParent = true;
    this.carryDeckPosition = deck.worldPosition;
    this.carryDeckRotation = deck.worldRotation;
    this.relativeBaseline = null;
    this.deckRelativeVelocity = Vec3.zero;
    this.isAttached = true;
    this.announceDistortingMount(platform);
  }

  /**
   * Log once per platform that its root's scale keeps riders unparented (or,
   * for a rig without the carry, parents one it distorts), with the scale
   * and tilt that triggered it.
   */
  private announceDistortingMount(platform: Entity, parented: boolean = false): void {
    const announced = parented
      ? MovingPlatformRideComponent.announcedShearedParents
      : MovingPlatformRideComponent.announcedScaledMounts;
    if (announced.has(platform)) {
      return;
    }
    rememberBounded(announced, platform);
    const transform = platform.getComponent(TransformComponent);
    const scale = transform?.worldScale;
    const pose =
      transform != null && scale != null
        ? ` (scale ${scale.x.toFixed(2)} x ${scale.y.toFixed(2)} x ` +
          `${scale.z.toFixed(2)}, tilted ${tiltDegrees(transform.worldRotation).toFixed(2)} deg)`
        : '';
    const what = parented
      ? "parents this rider although its root's scale" +
        `${pose} shears it, as the character's force controller applies no carry`
      : `carries riders without a parent link: its root's scale${pose} would ` +
        'shear a parented rider';
    console.log(
      `[MovingPlatformRide] '${platform.name}' ${what} (scaled unevenly ` +
        'across its floor, a mirrored axis, or scaled unevenly and tilted). ' +
        'Scale its floor evenly and keep the root upright, or keep it at unit ' +
        'scale and scale a child mesh and collider, for a full ride.',
    );
  }

  /** The rider root's world scale and up, or null when unreadable. */
  private readRiderPose(): RiderPose | null {
    const transform = this.rootTransform;
    const scale = transform?.worldScale;
    const rotation = transform?.worldRotation;
    if (scale == null || rotation == null) {
      return null;
    }
    const up = upOf(rotation);
    return {worldScale: new Vec3(scale.x, scale.y, scale.z), up: new Vec3(up.x, up.y, up.z)};
  }

  /** Keep the pose read before an accepted link, with the local scale under it. */
  private keepRiderPose(pose: RiderPose | null, target: Entity): void {
    const local = this.rootTransform?.localScale;
    this.poseWhenParented =
      pose != null && local != null
        ? {
            ...pose,
            localScale: new Vec3(local.x, local.y, local.z),
            deckShears: (deckShearOf(target) ?? 0) > SETTLE_SHEAR_EPSILON,
          }
        : null;
  }

  /**
   * Unparent the rider, preserving its world transform. Under a deck whose
   * pose shears a parented rider (within the bounds the ride parents at, or
   * past them on the mid-ride hand-off), the link left the rider's world
   * transform slightly sheared, which unparenting folds into a tilt and a
   * lopsided scale on the root: remove those, restoring the up the rider had
   * when parented and its scale times any resize made during the ride (read
   * from its local scale, which the deck's pose never changes). Under any
   * other deck the unparented pose is left alone. A deck whose pose cannot be
   * read while its link is still in view is judged by its shear as last seen
   * while riding. A link already out of view (native hides a dying deck, or
   * another script removed it) leaves the pose alone: the root's local scale
   * may no longer be the deck's, so it cannot tell a resize.
   */
  private unparentRider(platform: Entity | null): void {
    const root = this.characterRoot;
    const transform = this.rootTransform;
    const pose = this.poseWhenParented;
    this.poseWhenParented = null;
    if (root == null) {
      return;
    }
    const local = transform?.localScale;
    const resize =
      pose != null && local != null
        ? new Vec3(
            scaleRatio(local.x, pose.localScale.x),
            scaleRatio(local.y, pose.localScale.y),
            scaleRatio(local.z, pose.localScale.z),
          )
        : null;
    root.setParent(null, {preserveWorldTransform: true});
    const shear = deckShearOf(platform);
    const shears =
      platform != null &&
      (shear != null ? shear > SETTLE_SHEAR_EPSILON : pose?.deckShears === true);
    if (transform == null || pose == null || resize == null || !shears) {
      return;
    }
    const scale = new Vec3(
      pose.worldScale.x * resize.x,
      pose.worldScale.y * resize.y,
      pose.worldScale.z * resize.z,
    );
    const now = transform.worldScale;
    if (
      now == null ||
      Math.abs(now.x - scale.x) > RESTORED_SCALE_SLACK ||
      Math.abs(now.y - scale.y) > RESTORED_SCALE_SLACK ||
      Math.abs(now.z - scale.z) > RESTORED_SCALE_SLACK
    ) {
      transform.worldScale = scale;
    }
    const rotation = transform.worldRotation;
    if (rotation != null) {
      const upright = withUp(rotation, pose.up);
      if (upright !== rotation) {
        transform.worldRotation = new Quaternion(upright.x, upright.y, upright.z, upright.w);
      }
    }
  }

  private announceDetected(platform: Entity): Entity {
    if (!MovingPlatformRideComponent.announcedMounts.has(platform)) {
      rememberBounded(MovingPlatformRideComponent.announcedMounts, platform);
      console.log(
        `[MovingPlatformRide] '${platform.name}' carries riders: detected moving ground with no registered mover.`,
      );
    }
    return platform;
  }

  /**
   * Whether the hit chain from `hit` up to (not including) `stop` holds
   * ground the ride never carries on: a character or a free-simulated body.
   */
  private rejectsGround(hit: Entity, stop: Entity): boolean {
    let current: Entity | null = hit;
    for (
      let depth = 0;
      depth < MAX_ANCESTOR_DEPTH && current != null && current !== stop;
      depth++
    ) {
      if (isCharacterEntity(current) || isFreeSimulatedBody(current)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Whether `entity` is `ancestor` or sits under it (bounded walk). */
  private isUnder(entity: Entity, ancestor: Entity): boolean {
    let current: Entity | null = entity;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current != null; depth++) {
      if (current === ancestor) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * The mover under an unregistered ground collider, found by motion: the
   * highest entity on the hit's ancestor chain whose world pose changed since
   * last frame, climbing only while each ancestor stays rigid with the hit
   * (its pose relative to the hit unchanged). A moving root carries every
   * rigid child, so the highest rigid one moving is the one being moved; an
   * ancestor moving relative to the hit (a Ferris wheel around its
   * counter-rotating car, a lift under a turntable) is not what the rider
   * stands on, so the climb stops below it. Each ancestor is compared with
   * its own pose last frame, matched by entity at any depth, so stepping
   * between colliders of one platform keeps the comparison. Skips other characters (a ride, a
   * character controller or a character force controller anywhere up the
   * chain)
   * and free-simulated dynamic bodies (props tumble; riding them would roll
   * the rider). Nothing is registered: the mount itself keeps the rider on.
   * Cost: on ground whose hit collider is still (static floor, a deck at
   * rest), one transform read per grounded frame. Once the hit moves, per
   * ancestor up to the scene root: four component lookups (characters), a
   * transform read and two map writes. A rider on a moving registered mover
   * pays this walk too, up to that mover (`stopAt`): it finds an unregistered
   * mover nested under the registered one.
   */
  private detectMovingGround(hit: Entity, stopAt: Entity | null = null): Entity | null {
    // Still hit (static floor, a deck at rest): nothing above it can both
    // move and stay rigid with it, so no mover exists. Skip the climb and keep
    // last frame's poses; the full walk runs once the hit itself moves.
    const hitTransform = hit.getComponent(TransformComponent);
    const lastHitPosition = this.probePositions.get(hit);
    const lastHitRotation = this.probeRotations.get(hit);
    if (
      hitTransform != null &&
      lastHitPosition !== undefined &&
      lastHitRotation !== undefined &&
      !poseChanged(
        lastHitPosition,
        hitTransform.worldPosition,
        lastHitRotation,
        hitTransform.worldRotation,
      )
    ) {
      return null;
    }
    let moving: Entity | null = null;
    let current: Entity | null = hit;
    let depth = 0;
    let rigid = true;
    const lastPositions = this.probePositions;
    const lastRotations = this.probeRotations;
    const nextPositions = this.nextProbePositions;
    const nextRotations = this.nextProbeRotations;
    nextPositions.clear();
    nextRotations.clear();
    // Rigidity is measured against the lowest entity seen on both frames: the
    // hit itself, or (when the cast moved to a sibling collider of the same
    // platform) the nearest ancestor seen both frames.
    let anchorLastPosition: Vec3 | null = null;
    let anchorLastRotation: Quaternion | null = null;
    let anchorPosition: Vec3 | null = null;
    let anchorRotation: Quaternion | null = null;
    while (current != null && depth < MAX_ANCESTOR_DEPTH) {
      if (isCharacterEntity(current)) {
        this.resetProbe();
        return null;
      }
      const transform = current.getComponent(TransformComponent);
      if (transform == null) {
        break;
      }
      const position = transform.worldPosition;
      const rotation = transform.worldRotation;
      const lastPosition = lastPositions.get(current);
      const lastRotation = lastRotations.get(current);
      if (lastPosition !== undefined && lastRotation !== undefined) {
        if (anchorPosition == null) {
          anchorLastPosition = lastPosition;
          anchorLastRotation = lastRotation;
          anchorPosition = position;
          anchorRotation = rotation;
        } else if (
          rigid &&
          anchorLastPosition != null &&
          anchorLastRotation != null &&
          anchorRotation != null
        ) {
          const before = relativePose(
            anchorLastPosition,
            anchorLastRotation,
            lastPosition,
            lastRotation,
          );
          const now = relativePose(anchorPosition, anchorRotation, position, rotation);
          if (poseChanged(before.position, now.position, before.rotation, now.rotation)) {
            rigid = false;
          }
        }
        if (rigid && poseChanged(lastPosition, position, lastRotation, rotation)) {
          moving = current;
        }
      }
      nextPositions.set(current, position);
      nextRotations.set(current, rotation);
      if (current === stopAt) {
        break;
      }
      current = current.parent;
      depth++;
    }
    this.probePositions = nextPositions;
    this.probeRotations = nextRotations;
    this.nextProbePositions = lastPositions;
    this.nextProbeRotations = lastRotations;

    if (moving == null || !moving.valid || isFreeSimulatedBody(moving)) {
      return null;
    }
    return moving;
  }

  /**
   * Publish this frame's deck-relative velocity from the mounted target.
   * Runs on the attach frame, on healthy frames, and on grace frames (same
   * target, briefly unlinked): the root's local position under the parent,
   * frame-differenced. A rider-side teleport (a teleport-guarded jump in the
   * relative position) detaches at once instead of publishing — otherwise the
   * old deck would drag the teleported rider through the grace window. Deck
   * teleports never trip the guard: the hierarchy preserves the relative
   * position across them by construction.
   */
  private trackMount(dt: number): void {
    const platform = this.targetPlatform;
    const rootTransform = this.rootTransform;
    if (platform == null || rootTransform == null) {
      this.deckRelativeVelocity = Vec3.zero;
      return;
    }
    if (this.carryWithoutParent) {
      // A carry assumes an unparented root: anything that parented it since
      // ends the ride (detach leaves that link alone).
      if (this.characterRoot?.parent != null) {
        this.detach();
        return;
      }
      this.trackCarry(dt, platform, rootTransform);
      return;
    }
    // The link must still be ours: anything that reparented the root out
    // from under the mount ends it.
    if (this.characterRoot?.parent !== platform) {
      this.detach();
      return;
    }
    const deck = platform.getComponent(TransformComponent);
    const deckRotation = deck?.worldRotation;
    const deckScale = deck?.worldScale;
    const readable = deckRotation != null && deckScale != null;
    const shear = readable ? riderShear(deckScale, deckRotation) : 0;
    if (readable && this.poseWhenParented != null) {
      // An unreadable frame keeps the shear last seen.
      this.poseWhenParented.deckShears = shear > SETTLE_SHEAR_EPSILON;
    }
    if (deck != null && shear > MAX_RIDER_SHEAR_WHILE_RIDING) {
      if (this.forceController?.appliesCarryDisplacement === true) {
        // A scaled deck tilting under its parented rider (a banking cart)
        // would shear it.
        this.carryOnWithoutParent(platform, deck);
        return;
      }
      // A rig without the carry has no other way to ride: say so.
      this.announceDistortingMount(platform, true);
    }
    this.isAttached = true;
    const relative = rootTransform.localPosition;
    const prev = this.relativeBaseline;
    this.relativeBaseline = relative;
    if (prev == null || dt <= 0) {
      // Anchor frame (or a degenerate frame): no velocity yet.
      this.deckRelativeVelocity = Vec3.zero;
      this.updateDebugLog(dt, platform.name);
      return;
    }
    // The local step is in the deck's frame and units; the animator wants
    // world axes (it yaws by the character's world rotation).
    const localStep = relative.sub(prev);
    const world =
      deckRotation != null && deckScale != null
        ? parentStepToWorld(deckRotation, deckScale, localStep)
        : null;
    this.publishRelativeStep(
      dt,
      platform,
      world != null ? new Vec3(world.x, world.y, world.z) : localStep,
    );
  }

  /**
   * Carry without a parent link: map the rider's seat in last frame's deck
   * pose onto this frame's pose and hand the difference to the force
   * controller, which adds it to the KCC move. The seat is measured against
   * the pose the last carry targeted, so a standing rider's seat never
   * changes and the published relative velocity is its own motion only. A
   * deck jump past the teleport bound re-anchors instead of dragging the
   * rider across the map.
   */
  private trackCarry(
    dt: number,
    platform: Entity,
    rootTransform: TransformComponent,
  ): void {
    const deck = platform.getComponent(TransformComponent);
    if (deck == null) {
      this.detach();
      return;
    }
    this.isAttached = true;
    const deckPosition = deck.worldPosition;
    const deckRotation = deck.worldRotation;
    const lastPosition = this.carryDeckPosition;
    const lastRotation = this.carryDeckRotation;
    this.carryDeckPosition = deckPosition;
    this.carryDeckRotation = deckRotation;
    const bound = deckTeleportThresholdMeters(this.maxDeckSpeedMetersPerSecond, dt);
    if (
      lastPosition == null ||
      lastRotation == null ||
      dt <= 0 ||
      deckPosition.sub(lastPosition).magnitude() > bound
    ) {
      // Re-anchor: no carry this frame, and none left from an earlier one.
      this.relativeBaseline = null;
      this.deckRelativeVelocity = Vec3.zero;
      if (this.forceController != null) {
        this.forceController.carryDisplacement = Vec3.zero;
        this.forceController.carryYawRadians = 0;
      }
      return;
    }
    // The simulated entity holds this frame's position; the root is synced
    // to it only after the force controller runs, a frame of movement behind.
    const rider =
      this.forceController?.simulatedTransform?.worldPosition ?? rootTransform.worldPosition;
    const seatXYZ = seatInDeck(lastPosition, lastRotation, rider);
    const seat = new Vec3(seatXYZ.x, seatXYZ.y, seatXYZ.z);
    const carried = seatToWorld(deckPosition, deckRotation, seat);
    if (this.forceController != null) {
      this.forceController.carryDisplacement = new Vec3(
        carried.x - rider.x,
        carried.y - rider.y,
        carried.z - rider.z,
      );
      this.forceController.carryYawRadians = yawDeltaRadians(lastRotation, deckRotation);
    }
    const lastSeat = this.relativeBaseline;
    this.relativeBaseline = seat;
    if (lastSeat == null) {
      this.deckRelativeVelocity = Vec3.zero;
      return;
    }
    const step = rotateVector(deckRotation, seat.sub(lastSeat));
    this.publishRelativeStep(dt, platform, new Vec3(step.x, step.y, step.z));
  }

  /** Publish a world-axis deck-relative step, or detach on a rider teleport. */
  private publishRelativeStep(dt: number, platform: Entity, step: Vec3): void {
    if (
      step.magnitude() >
      deckTeleportThresholdMeters(this.maxDeckSpeedMetersPerSecond, dt)
    ) {
      // Rider-side teleport: detach at once (see the method header).
      this.detach();
      return;
    }
    this.deckRelativeVelocity = step.mul(1 / dt);
    this.updateDebugLog(dt, platform.name);
  }

  /**
   * One [RideDBG] line per second of attachment (wall clock, not frame
   * count). Still frames pause the window instead of restarting it; a
   * platform change flushes the open window first so a line never mixes
   * stats from two platforms.
   */
  private updateDebugLog(dt: number, platformName: string): void {
    if (!this.debugLogging) {
      this.debugTimeSeconds = 0;
      this.debugSamples = 0;
      this.debugSpeedSum = 0;
      this.debugMaxSpeed = 0;
      this.debugPlatformName = '';
      return;
    }
    if (!this.isAttached) {
      return;
    }
    if (
      this.debugSamples > 0 &&
      this.debugPlatformName !== '' &&
      this.debugPlatformName !== platformName
    ) {
      this.flushDebugLog();
    }
    const speed = this.deckRelativeVelocity.magnitude();
    this.debugPlatformName = platformName;
    this.debugTimeSeconds += dt;
    this.debugSamples++;
    this.debugSpeedSum += speed;
    if (speed > this.debugMaxSpeed) {
      this.debugMaxSpeed = speed;
    }
    if (this.debugTimeSeconds >= 1.0) {
      this.flushDebugLog();
    }
  }

  private flushDebugLog(): void {
    if (this.debugSamples > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[RideDBG] platform=${this.debugPlatformName} ` +
          `maxRel=${this.debugMaxSpeed.toFixed(2)} ` +
          `meanRel=${(this.debugSpeedSum / this.debugSamples).toFixed(2)}`,
      );
    }
    this.debugTimeSeconds = 0;
    this.debugSamples = 0;
    this.debugSpeedSum = 0;
    this.debugMaxSpeed = 0;
    this.debugPlatformName = '';
  }
}
