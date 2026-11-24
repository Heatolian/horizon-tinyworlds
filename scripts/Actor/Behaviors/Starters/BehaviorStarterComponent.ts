/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  component,
  Component,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  property,
  subscribe,
  type Entity,
  type EventSubscription,
  ExecuteOn,
} from 'meta/worlds';
import {
  ActorSdkLogicComponent,
  ActorMovementControllerTypeId,
  ActorBehavior,
  PickupItemSlot,
} from 'meta/worlds';
import {movesTheBody} from '../../Controllers/Definitions/IActorMovementOccupant';

/**
 * Default arbitration priorities by role; at these defaults, starters of
 * different roles never tie. Each starter's labelled `basePriority` defaults to
 * its role (a literal: the editor reads defaults per declaring class), falls
 * back to it on zero-init. A creator may reorder roles; a tie on a shared
 * controller is a misconfiguration the manager warns about. Its maximum
 * of 99 keeps starters below `StaggerBehavior` (100) and `DeathBehavior` (1000).
 */
export const StarterPriority = {
  Ambient: 5,
  // Above ambient walkers, below Social movers: a look-at that stands the actor
  // still must yield Movement to Follow and KeepAway rather than tie with them.
  Attention: 15,
  Social: 25,
  Task: 45,
  Combat: 70,
  // Above Combat so a leashed actor walks home instead of chasing.
  Leash: 80,
} as const;

/**
 * Implemented by every behavior a starter registers. The SDK `ActorBehavior`
 * has no removed state and the manager drops a behavior without telling its
 * starter, so the behavior records its own removal in `onRemove()`.
 */
export interface RemovalTrackedBehavior {
  isRemoved: boolean;
}

@component()
export class BehaviorStarterComponent extends Component {
  @property()
  controlledActor: Entity | null = null;

  @property()
  autoStart: boolean = true;

  @property()
  removeDuplicates: boolean = true;

  /**
   * Seconds to keep retrying the start when `ActorSdkLogicComponent` is not
   * ready at start. A spawned actor's components can resolve after its start
   * event, and a starter that misses the window stays silent forever — the
   * behavior is never built, so nothing later retries it. Not a `@property`:
   * a per-scene timeout needs no tuning. Diagnostic only after the wait: one
   * warn names the misconfiguration instead of failing every frame.
   */
  startRetryTimeoutSec: number = 10;

  /** Elapsed retry wait; <= 0 means no retry is armed. */
  private startRetryElapsedSec: number = 0;
  /** The per-frame retry, subscribed only while a retry is armed. */
  private startRetryTick: EventSubscription | null = null;

  // CRITICAL: Only initialize behaviors on owner (server) since that's where NPC logic runs
  // Client views don't need to initialize behaviors - they receive replicated transforms
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    if (this.tryResolveActor()) {
      this.disarmStartRetry();
      if (!this.autoStart) {
        return;
      }
      if (this.controlledActor) {
        this.warnIfNoMovementController();
        this.startBehavior();
      }
      return;
    }
    // No logic yet (spawned actors resolve components after start): retry on
    // update instead of staying silent forever. The wait is bounded below.
    this.armStartRetry();
  }

  /**
   * Retries a start that missed its window until the actor resolves or the
   * timeout expires. A resolved actor with autoStart off is still left alone:
   * an external driver calls startBehavior() itself. Runs every frame only
   * while a retry is armed ({@link armStartRetry}): a starter that started
   * costs nothing per frame.
   */
  onStartRetryTick(ev: OnWorldUpdateEventPayload): void {
    // Only the owner starts behaviors: a machine that lost ownership mid-retry
    // stops here (the subscription, unlike an Owner-scoped handler, stays put).
    if (this.startRetryElapsedSec <= 0 || !this.entity.isOwned()) {
      this.disarmStartRetry();
      return;
    }
    if (this.tryResolveActor()) {
      this.disarmStartRetry();
      this.onStartRetryResolved();
      return;
    }
    this.startRetryElapsedSec += ev.deltaTime;
    if (this.startRetryElapsedSec > this.startRetryTimeoutSec) {
      this.disarmStartRetry();
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- fires at most once: the retry disarms itself on the same tick.
      console.warn(
        `[${this.locomotionStarterName() ?? 'BehaviorStarterComponent'}] No ActorSdkLogicComponent ` +
          `on '${this.entity.name}' after ${this.startRetryTimeoutSec}s, so no behavior was started. ` +
          'Add the logic component to the actor.',
      );
    }
  }

  /** Arms the bounded start retry; subclasses with their own start path call this. */
  protected armStartRetry(): void {
    this.startRetryElapsedSec = Number.EPSILON;
    if (this.startRetryTick == null) {
      this.startRetryTick = this.subscribe(OnWorldUpdateEvent, (ev: OnWorldUpdateEventPayload) =>
        this.onStartRetryTick(ev),
      );
    }
  }

  private disarmStartRetry(): void {
    this.startRetryElapsedSec = 0;
    this.startRetryTick?.disconnect();
    this.startRetryTick = null;
  }

  /**
   * Runs once the retry resolves the actor. Subclasses that start outside
   * `startBehavior()` (health/death) override this instead.
   */
  protected onStartRetryResolved(): void {
    if (this.autoStart && this.controlledActor) {
      this.warnIfNoMovementController();
      this.startBehavior();
    }
  }

  /**
   * Resolves controlledActor; true when the starter can start. Readiness is a
   * hook because starters register on different owners: most use the
   * controlled actor's logic, but the health starter registers on its own
   * entity. The two must agree, or a resolve re-arms forever — resolving on
   * one entity's logic while registering on the other's.
   */
  private tryResolveActor(): boolean {
    if (!this.controlledActor && this.entity.getComponent(ActorSdkLogicComponent)) {
      this.controlledActor = this.entity;
    }
    return this.isReadyToStart();
  }

  /**
   * True when the logic component the starter registers on exists. Base
   * starters register on the controlled actor; override when yours does not.
   */
  protected isReadyToStart(): boolean {
    if (this.controlledActor == null) {
      return false;
    }
    try {
      return this.controlledActor.getComponent(ActorSdkLogicComponent) != null;
    } catch {
      return false;
    }
  }

  /**
   * Override in starters whose behavior drives locomotion, returning the
   * subclass name. A non-null value both opts into the missing-movement-
   * controller check and labels its diagnostic, so opt-in and label cannot
   * drift apart. Null (the default) is for starters that never move the actor
   * — look and speak. Note that item starters DO move: `UseItemBehavior` and
   * `SearchAndPickupBehavior` both drive `GotoBehavior` internally.
   *
   * The name is supplied explicitly rather than read from `constructor.name`,
   * which is not stable under minification.
   */
  protected locomotionStarterName(): string | null {
    return null;
  }

  /**
   * A locomotion actor with no registered ActorMovementController holds its
   * target and never closes; the request is dropped silently, so the only
   * downstream symptom misattributes to navmesh/collider radii.
   * CharacterAnimationController does NOT register one — it only drives animation.
   *
   * Runs before startBehavior(), which early-returns on every subclass when a
   * required property is unset, so the message states only what is true either
   * way: the actor cannot be moved. Diagnostic only — startBehavior() still
   * runs. warn, not error: error severity reaches APP ERROR / hzw_hsr_errors
   * and fails smoketest.
   */
  private warnIfNoMovementController(): void {
    const starterName = this.locomotionStarterName();
    if (starterName === null || !this.controlledActor) {
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      return;
    }
    // Occupancy is not capability. Some controllers register under the movement type id
    // to share its arbitration axis while being unable to move the body — JumpAbility
    // drives only the vertical axis and implements moveToPosition as a no-op so the
    // unguarded casts in the mover behaviours stay safe. Counting those would silence this
    // warning on exactly the misconfiguration it exists to catch: a locomotion actor with
    // a jump but no mover. They opt out as an `IActorMovementOccupant`.
    const movers = actorLogic.getControllers(ActorMovementControllerTypeId).filter(movesTheBody);
    if (movers.length > 0) {
      return;
    }
    console.warn(
      `[${starterName}] No ActorMovementController is registered on this ` +
      'actor — a locomotion behavior on it cannot move it. Add ' +
      "ActorTransformMoveComponent to the actor's root entity " +
      '(CharacterAnimationController only drives animation).',
    );
  }

  /**
   * Resolves a scene-authored hand slot, falling back to RightHand.
   *
   * The pickup starters type their slot as `number` rather than
   * `PickupItemSlot` because an enum `@property` does not survive scene
   * serialisation, so a template instance zero-inits it to `None`. That value
   * IS rejected by `ActorPickupItemComponent.pickupItem`, but only once the
   * actor has already walked to the item, so the failure reads as a pickup that
   * quietly does nothing. Checking at configuration time names the real cause.
   *
   * warn, not error: error severity reaches APP ERROR / hzw_hsr_errors and
   * fails smoketest, and this path recovers.
   *
   * Recovering rather than rejecting is deliberate, and it is a behaviour
   * change: an unset slot used to mean no pickup at all. An actor that carries
   * the item in the wrong hand is visibly wrong and easy to trace from the
   * warning; one that walks to the item and then does nothing reads as a broken
   * behaviour tree and cost a debugging cycle to attribute. The two bad inputs
   * are reported differently so a typo is not mistaken for the zero-init trap.
   */
  protected resolveHandSlot(slot: number, starterName: string): PickupItemSlot {
    if (slot === PickupItemSlot.RightHand || slot === PickupItemSlot.LeftHand) {
      return slot as PickupItemSlot;
    }
    const cause =
      slot === PickupItemSlot.None
        ? 'likely unset on the instance — a template instance zero-inits this property to None'
        : 'not a PickupItemSlot value, so this looks like a typo';
    console.warn(
      `[${starterName}] hand slot is ${slot}, ${cause}. Expected ` +
        `${PickupItemSlot.RightHand} (RightHand) or ${PickupItemSlot.LeftHand} (LeftHand). ` +
        'Falling back to RightHand so the actor still picks up; set the slot explicitly to ' +
        'choose the hand.',
    );
    return PickupItemSlot.RightHand;
  }

  /**
   * Returning the behavior lets a caller observe when it finishes.
   * `ActorSdkLogicComponent` exposes `addBehavior` / `removeBehavior` but no way
   * to read the behavior list, so the returned instance is the only handle on
   * completion — which is what a component driving a repeating starter needs.
   *
   * The rule is about capability, not guarantee: a starter returns its behavior
   * unless that behavior can never finish. Of the behaviors these starters
   * create, `AttentionBehavior`, `IdleWanderBehavior`,
   * `FollowTaggedEntityBehavior`, `FleeTaggedEntityBehavior` and
   * `EngageCombatBehavior` never assign `isFinished`, so
   * `StarterLookAtComponent`, `StarterWanderComponent`,
   * `StarterFollowComponent`, `StarterKeepAwayComponent` and
   * `StarterCombatComponent` return nothing — a handle to any of them could
   * only invite a caller to wait forever. Every other starter returns.
   *
   * None of the behaviors that do finish are unconditional about it.
   * `SimpleFetchBehavior` finishes after its drop, `LeadBehavior` on arrival,
   * `UseItemBehavior` on use completion or when it gives up (a destroyed or
   * transform-less target, or no item held in the use slot), and
   * `SearchAndPickupBehavior` after its pickup — but only while `persistent` is
   * off, because a persistent search is meant to keep looking. So a returned
   * handle means "this can complete", never "this will": a caller that loops on
   * completion has to tolerate a behavior that never reports one.
   *
   * The union return type is what makes that split expressible: a
   * `startBehavior(): void` override stays valid.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  startBehavior(): ActorBehavior | void { }

  private handle: (ActorBehavior & RemovalTrackedBehavior) | null = null;

  /**
   * Registers `behavior` on the actor, replacing this starter's previous one,
   * and forwards `removeDuplicates` so the SDK evicts same-type behaviors that
   * other starters registered.
   *
   * The previous behavior is removed only while it is still registered:
   * `removeBehavior()` calls `onRemove()` unconditionally, so removing one the
   * manager already dropped would run its cleanup twice.
   */
  protected registerBehavior(
    actorLogic: ActorSdkLogicComponent,
    behavior: ActorBehavior & RemovalTrackedBehavior,
  ): void {
    const previous = this.runningHandle();
    if (previous) {
      actorLogic.removeBehavior(previous);
    }
    actorLogic.addBehavior(behavior, this.removeDuplicates);
    this.handle = behavior;
  }

  /**
   * The registered behavior, or null once it finished or was removed. The
   * manager drops a behavior without telling its starter, so an edit written
   * to a dropped one would change nothing.
   */
  protected runningBehavior<T extends ActorBehavior>(): T | null {
    return this.runningHandle() as T | null;
  }

  /**
   * Applies a live property edit to the running behavior, if any. For
   * `@subscribePropertyChange` handlers, since `startBehavior()` copies
   * properties into the behavior only once.
   */
  protected pushToRunning<T extends ActorBehavior>(apply: (behavior: T) => void): void {
    const behavior = this.runningBehavior<T>();
    if (behavior) {
      apply(behavior);
    }
  }

  /**
   * True when `entity` is the controlled actor or one of its descendants, such
   * as a mesh or collider child. For entity properties a creator picks: a
   * forced target skips the tag query's self-exclusion, so choosing the actor
   * or a part of it makes the actor target itself.
   */
  protected isOwnActorEntity(entity: Entity): boolean {
    const actor = this.controlledActor;
    if (actor == null) {
      return false;
    }
    // A destroyed entity throws when its ancestry is read.
    return entity === actor || (entity.valid && entity.getAncestors().includes(actor));
  }

  /**
   * `value` when positive, else `fallback`. For properties where 0 is never a
   * meaningful setting (speeds, intervals, ranges): a template instance
   * zero-inits every property its delta omits, so 0 there means "unset".
   */
  protected static positiveOr(value: number, fallback: number): number {
    return value > 0 ? value : fallback;
  }

  /**
   * A starter's `basePriority` as arbitration reads it: `role` when an instance
   * zero-inits it, and capped at 99 because authored values load natively and
   * skip the property's maximum, so stagger (100) and death still win.
   */
  protected static resolvePriority(value: number, role: number): number {
    return value > 0 ? Math.min(value, 99) : role;
  }

  private runningHandle(): (ActorBehavior & RemovalTrackedBehavior) | null {
    if (this.handle && (this.handle.isFinished || this.handle.isRemoved)) {
      this.handle = null;
    }
    return this.handle;
  }
}
