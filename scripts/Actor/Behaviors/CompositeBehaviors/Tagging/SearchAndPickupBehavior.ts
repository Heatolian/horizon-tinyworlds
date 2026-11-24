/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v41

import {TransformComponent, WorldService, type Entity} from 'meta/worlds';
import {CompositeBehavior} from '../CompositeBehavior';
import {FollowBehavior} from '../../BaseBehaviors/FollowBehavior';
import {TargetInfo} from '../../BaseBehaviors/TargetingBehavior';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {TargetTaggedEntityBehavior} from '../../BaseBehaviors/Tagging/TargetTaggedEntityBehavior';
import {isTakeTracked, isTerminalTakeRefusal, readTakeOutcome, clearTakeTracking, TakeRefusalCounter, type TakeOutcome} from '../../../Utilities/TakeOutcome';
import {
  ActorPickupItemControllerTypeId,
  type ActorMovementController,
  type ActorPickupItemController,
  ActorMoveParams,
  ActorRequestPickupData,
  PickupItemSlot,
  ActorMovementControllerTypeId,
} from 'meta/worlds';

/**
 * Per-actor record of whether the empty-handed diagnostic has already been
 * emitted. Owned by whatever outlives the individual behavior instances — the
 * starter component, when a loop re-runs it.
 */
export interface EmptyHandedWarningLatch {
  warned: boolean;
}

/**
 * Backstop on distinct give-up clocks: transient candidates that never reach
 * the threshold would otherwise leave one dead entry each.
 */
const MAX_GIVE_UP_CLOCKS = 16;
// Recovery rounds without an intervening pickup after which recovery stops
// lifting retirements: a permanently-unreachable item is re-chased at most
// this many times instead of oscillating forever. Counted per lift, not per
// give-up, so three different stalled candidates still get their retries.
const MAX_FRUITLESS_GIVE_UPS = 3;
/**
 * Cap on the starter-owned missing-loot cooldown map. Live empty refillables
 * never trip the seed prune, so without this a long-lived actor accumulates
 * one entry per distinct container; evicting a live cooldown only re-takes
 * that container sooner.
 */
const MAX_REFUSED_LOOT_MEMORY = 32;

/**
 * How long a 'missing' (merely empty right now) container stays excluded
 * across loop cycles before the actor re-checks it for a refill. Long enough
 * to move on to other loot instead of burning every cycle on it; short enough
 * that a refilled container does not wait long.
 */
const MISSING_RETRY_COOLDOWN_SECONDS = 30;

/**
 * Cap on the recoverable give-up sink: recovery lifts are gated on the
 * give-up timer, so a timer-off run that keeps refusing (with no pickup to
 * lift) would otherwise grow it one entry per distinct loot forever. The
 * sink doubles as the run's lift list — pickups and fruitless rounds lift
 * exactly its members — so an evicted give-up stays retired for the rest
 * of the run and only the next cycle re-chases it (seeding walks the same
 * sink). Picked-up and held items are never filed here, so lifts cannot
 * re-admit the hand.
 */
const MAX_GIVE_UP_SINK = 32;

/**
 * SearchAndPickupBehavior - Finds the closest entity with a given tag,
 * walks toward it, and picks it up when in range.
 *
 * Composes three internal behaviors:
 * 1. **TargetTaggedEntityBehavior** (priority 200) — resolves the closest
 *    entity matching any of `targetTags` from the ActorTaggingBlackboard
 * 2. **FollowBehavior** (priority 50) — moves the actor toward the target
 * 3. **Pickup logic** — when within `pickupRange`, claims the pickup
 *    controller and grabs the item
 *
 * After pickup, the behavior either finishes (one-shot) or stays active
 * to search for the next item with the same tag (persistent mode).
 * Persistent mode reaches a second item only once something else empties the
 * hand, and only on a LATER cycle: this behavior never drops, and a pickup into
 * an occupied slot is refused, which finishes the search. Nothing can free the
 * hand while this behavior is still running — `SequentialBehavior` and a loop
 * that re-runs the starter both advance only once the current behavior sets
 * `isFinished`, and in a concurrent pairing this composite claims Movement at
 * its own `basePriority` for as long as it stays unfinished. So the supported
 * shape is search → deliver → repeat as sequenced steps, not two behaviors
 * racing within one step.
 *
 * A LOOPED run whose hand is still full — `persistent` on, looped, with no step
 * that empties it — finishes each cycle without collecting, and says so once.
 * It cannot decide that on its own: a loop that re-runs the starter builds a fresh
 * behavior each time, so every per-run field here starts empty. The slot is
 * therefore read BEFORE each request rather than inferred from what this run has
 * already done, which is what keeps that cycle from mistaking the item already
 * in the hand for one it just picked up; and the diagnostic is latched by
 * `emptyHandedWarningLatch`, which the starter owns because it outlives the
 * cycles and this behavior does not.
 *
 * An empty hand slot is the one refusal that IS retried: it means
 * `ActorPickupItemComponent` is still lazily resolving a socket that template
 * instantiation had not created yet, which clears on its own within a frame or
 * two. That retry is throttled by `pickupRetryInterval` and bounded by
 * `maxPickupAttempts`.
 *
 * @example
 * ```typescript
 * const search = new SearchAndPickupBehavior();
 * search.basePriority = 30;
 * search.targetTags = ['sword'];
 * search.pickupRange = 2.0;
 * search.followSpeed = 4.0;
 * actorLogic.addBehavior(search);
 * ```
 */
export class SearchAndPickupBehavior extends CompositeBehavior {
  override name: string = 'SearchAndPickupBehavior';

  /** True once the behavior manager has removed this behavior. */
  isRemoved: boolean = false;

  // ── Targeting Configuration ───────────────────────────────────────

  /** The tags to search for (e.g. ["sword"], ["sword", "key"]). The closest entity matching any tag is selected. */
  targetTags: string[] = [];

  /** Time constant for position smoothing in seconds. */
  positionSmoothingTimeConstant: number = 0.3;

  /** Time constant for velocity smoothing in seconds. */
  velocitySmoothingTimeConstant: number = 0.5;

  /** How far ahead to predict the target's position in seconds. */
  velocityPredictionTime: number = 0.5;

  /**
   * Horizontal view angle (deg) loot must fall inside to be noticed, measured
   * from the actor's body facing. 0 (default) keeps the omniscient search.
   * An acquired target is kept without re-checking the cone. Facing only: no
   * occlusion is tested. Nothing here turns the body, so a non-zero angle
   * needs a companion behavior that does, or off-cone loot is never noticed.
   * Re-copied to the inner targeting every frame, so a live edit takes effect
   * without a restart.
   */
  searchViewAngleDeg: number = 0;

  /**
   * Tags whose carriers the search never pursues, forwarded to the inner
   * targeting every frame. A world tags looted chests "opened" and lists it
   * here, and the actor walks past them to unopened loot. Empty (default)
   * skips nothing.
   */
  excludedTags: string[] = [];

  /**
   * Registry key for a world-provided candidate filter, forwarded to the
   * inner targeting every frame (like `excludedTags`). Scene data cannot
   * carry a function, so a world script registers one under a name
   * (`CandidateFilterRegistry.register`) and sets this to that name — through
   * the starter, like `excludedTags`. Empty (default) uses no registry filter.
   */
  candidateFilterKey: string = '';

  /**
   * Seconds without a pickup before the run gives up on a target: the target
   * is retired and a persistent search moves to the next candidate while a
   * one-shot search finishes. Each target accrues its own clock, so a fresh
   * target gets its full window while oscillation between two stalled targets
   * still retires one; each pickup clears every clock, so a productive run is
   * never cut off. Time with no target resolved accrues nothing, and the
   * clock does not run while dormant behind `detectionRange`. 0 (default)
   * pursues forever, as before. Bounds the hover over an unreachable item
   * and the pacing next to a contested one.
   */
  giveUpSeconds: number = 0;

  // ── Follow Configuration ──────────────────────────────────────────

  /** Movement speed in m/s. */
  followSpeed: number = 5.0;

  /** Body direction mode while approaching. See FollowBehavior. */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /** Angular speed in radians per second for body direction rotation. */
  bodyDirectionAngularSpeed: number = 3.14;

  /** GotoBehavior repath interval. */
  repathInterval: number = 0.2;

  /** GotoBehavior distance to stop. */
  distanceToStop: number = 0.1;

  // ── Pickup Configuration ──────────────────────────────────────────

  /**
   * Distance (meters) from target at which pickup is triggered. XZ only.
   *
   * Keep this within the loot's 3D reach: the take fires at this XZ range,
   * but the server answers `outOfReach` past the loot's `Interactable`
   * maxDistance (default 3m). Retrying `outOfReach` is still correct — the
   * follow sub-behavior keeps closing the XZ gap between attempts, so only a
   * height gap the actor cannot close burns the bound, and that loot is
   * genuinely unreachable.
   */
  pickupRange: number = 2.0;

  /** Which hand slot to use for pickup. */
  pickupSlot: PickupItemSlot = PickupItemSlot.RightHand;

  /**
   * If true, stays active after pickup to search for the next item. A single
   * run still collects at most one item: the next pickup is refused while the
   * hand is full, and that refusal finishes the search. Collecting several
   * items means sequencing this behavior with something that empties the hand
   * and letting the sequence repeat — see the class doc for why a concurrent
   * pairing cannot free the hand mid-run.
   *
   * Take-loot accumulates in the actor's inventory instead of the hand.
   * Dropping a take-tracked slot deposits the take-receiving backpacks as
   * world loot (see ActorPickupItemComponent.dropItem), so a deliver step
   * after the run can move it back out; give-up paths only clear the
   * tracking and leave the goods behind. Looped collect sequences without
   * a deliver step still saturate into `noRoom`.
   */
  persistent: boolean = false;

  /**
   * Seconds to wait before re-attempting a pickup that read back an empty hand
   * slot. `ActorPickupItemComponent.onUpdate` re-runs `tryResolveSlots()` every
   * frame because "template children may not exist at onCreate time", so the
   * socket usually appears within a frame or two; throttling keeps the retry off
   * the frame clock without making it slower than the thing it waits for.
   */
  pickupRetryInterval: number = 0.5;

  /**
   * Seconds to stand still after a successful pickup before chasing the next
   * target. Defaults to a visible beat: a human stops to pocket a find instead
   * of snatching it at full stride, so every searcher reads as deliberate
   * without per-template tuning. Set 0 to opt a hurried NPC back out.
   */
  postPickupDwellSec: number = 1.0;

  /**
   * Total pickup attempts allowed before the search finishes empty-handed.
   * Bounds two different retries: an unresolved hand slot (below), and filed
   * retryable take refusals — full, out of reach, unhandled — which count
   * filed answers, not frames (see `TakeRefusalCounter`), so one refusal
   * held across frames never reaches the bound on its own. Terminal refusals
   * never reach it either: they give up at once.
   *
   * For the unresolved slot: bounds the retry so a slot that never
   * resolves — a template genuinely missing its socket child — terminates
   * instead of re-entering `pickupItem()` every `pickupRetryInterval` for the
   * rest of the run, which would also re-emit that component's ungated slot
   * warning each time.
   *
   * The bound is per RUN, not per actor: a loop that re-runs the starter builds a
   * fresh behavior each cycle, so a template that is genuinely missing its
   * socket is re-diagnosed once per cycle, and finishing is what hands the cycle
   * back instead of holding it. What paces that repeat is the retry window
   * below, NOT the loop: a loop may restart the behavior on the very next
   * frame. A run cannot reach this warning faster than the window, which is
   * what keeps the repeat off the frame clock.
   *
   * A cooldown is armed between attempts but not after the last, so the window
   * spanned is `(maxPickupAttempts - 1) × pickupRetryInterval` seconds — 1.0s at
   * the defaults, generous against a resolve that takes a frame or two.
   *
   * Only the unresolved slot and retryable take refusals are retried. A slot
   * that already holds something finishes immediately: nothing reachable
   * while this behavior runs can empty the hand.
   */
  maxPickupAttempts: number = 3;

  /**
   * Partial takes answered for one target before the search retires it.
   * Every 'partial' moves items, so a finite container drains on its own and
   * this never fires for one — it is a backstop for loot that never drains
   * (e.g. concurrently refilled), which would otherwise re-take forever. Each
   * count is one filed answer (see below), generously high against legitimate
   * multi-take drains.
   */
  maxPartialTakes: number = 10;

  /** Seconds to wait before starting. Prevents instant actions during scene loading. */
  startDelay: number = 0;

  /**
   * Shared across the behaviors one starter builds, so the empty-handed
   * diagnostic names its misconfiguration once per actor.
   *
   * WHY it cannot be an instance field: the warning fires on a run that arrives
   * with a full hand, which under a loop is EVERY cycle — and a loop may
   * restart the behavior on the very next frame. An instance field resets with
   * the instance, so the warn would repeat at frame rate on exactly the
   * misconfiguration it exists to report.
   *
   * `null` means no latch, which warns once per run. That is correct for a
   * caller that constructs the behavior directly rather than looping it.
   */
  emptyHandedWarningLatch: EmptyHandedWarningLatch | null = null;

  // ── Activation Configuration ─────────────────────────────────────

  /**
   * Detection range in meters (XZ plane). When > 0, the behavior stays
   * dormant (returns -1 for all controllers) until the target entity is
   * within this range. Once activated, the behavior stays active until
   * it finishes or is removed — it will NOT deactivate if the actor
   * moves beyond the detection range while approaching the target.
   *
   * Set to 0 (default) to always be active — the behavior claims
   * controllers immediately and starts moving toward the target.
   *
   * Use this with the priority system: give the pickup behavior a
   * higher basePriority than a concurrent follow behavior. While
   * dormant, the lower-priority follow behavior wins the controllers.
   * When the target enters detection range, this behavior activates
   * and its higher priority takes over movement.
   */
  detectionRange: number = 0;

  // ── Internal State ────────────────────────────────────────────────

  private sharedTargetInfo: TargetInfo = new TargetInfo();
  private targetBehavior: TargetTaggedEntityBehavior | null = null;
  private followBehavior: FollowBehavior | null = null;
  private pendingPickup: boolean = false;
  private pickupRetryCooldown: number = 0;
  private dwellRemaining: number = 0;
  /** Attempts made against an unresolved hand slot; see maxPickupAttempts. */
  private unresolvedSlotAttempts: number = 0;
  /**
   * Loot a sent take is still awaiting: the targeting sub-behavior clears its
   * target when the loot is destroyed, so the take is settled through this
   * field instead of sharedTargetInfo.
   */
  private awaitingTake: Entity | null = null;
  /** Filed refusal answers for the current target; see TakeRefusalCounter. */
  private readonly takeRefusals = new TakeRefusalCounter();
  /**
   * Loot this run sent a take for. The controller's settled entries outlive
   * the take (and the run): a 'done' that this run never sent is stale, so
   * only a sent take's 'done' counts as this run's pickup.
   */
  private readonly sentTakes = new Set<Entity>();
  /** Target the partial-take streak below belongs to; a new target restarts it. */
  private partialTakeTarget: Entity | null = null;
  private partialTakeCount: number = 0;
  /**
   * 'missing' loot with its re-check time (world seconds): a live container
   * answers 'missing' while merely empty, so it is excluded across cycles only
   * until then, then re-checked for a refill. Owned by the starter; null keeps
   * 'missing' run-local.
   */
  missingLootCooldowns: Map<Entity, number> | null = null;
  /**
   * Retryable-refusal reasons already warned about, so a looped actor names
   * each once instead of once per cycle. Owned by the starter; null warns
   * once per run.
   */
  warnedTakeRefusals: Set<string> | null = null;
  private activated: boolean = false;
  /**
   * Entities this run must not target again: items it picked up, plus an item it
   * found already occupying the hand slot. Both ride the actor's hand and keep
   * their tag, so either would otherwise stay the nearest candidate forever.
   */
  private readonly retired: Set<Entity> = new Set<Entity>();
  /**
   * Seconds since anything resolved. Recovery lifts give-ups only after a
   * sustained empty window, so a transient null (cone edge, range jitter)
   * never cancels a legitimate retirement on one frame.
   */
  private emptyResolveSeconds: number = 0;
  /**
   * Recovery rounds since the last pickup. The starter shares one object
   * across loop cycles (same lifetime as `giveUpSink`), so a looped one-shot
   * search cannot dodge the cap by restarting; without a starter the
   * per-instance default below applies. Recovery lifts retirements only
   * while the count is below the cap, so transient unreachability is
   * retried a few times and then the actor rests instead of re-chasing a
   * permanently-unreachable item forever.
   */
  fruitlessCounter: {count: number} = {count: 0};
  /**
   * Whether this run picked anything up. Distinct from `retired` being non-empty,
   * which is also true of a run that only excluded an item it found in the hand.
   */
  private pickedUpThisRun: boolean = false;
  private elapsedTime: number = 0;
  private started: boolean = false;
  /**
   * Pursuit time accrued per target; see `giveUpSeconds`. A flip-flopping
   * nearest candidate resumes — never restarts — its clock.
   */
  private readonly giveUpClocks: Map<Entity, number> = new Map<Entity, number>();
  /**
   * Whether arbitration handed this behavior Movement since the last frame.
   * Set in `useController`, consumed and cleared by `checkGiveUp`: the clock
   * measures pursuit, so frames spent outranked (staggered, using an item)
   * must not burn a target's give-up budget.
   */
  private drovePursuitLastFrame: boolean = false;
  /**
   * Give-up memory. The starter shares one object across loop cycles (which
   * build a fresh behavior each time); without a starter the per-instance
   * default below applies, so a directly-driven behavior still recovers.
   * Give-ups are written here as well as to `retired`; a successful pickup
   * clears it, so re-dropped items become eligible again.
   */
  giveUpSink: Set<Entity> = new Set<Entity>();
  private actorTransform: TransformComponent | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    this.targetBehavior = new TargetTaggedEntityBehavior();
    this.targetBehavior.basePriority = 200;
    this.targetBehavior.targetTags = this.targetTags;
    this.targetBehavior.positionSmoothingTimeConstant = this.positionSmoothingTimeConstant;
    this.targetBehavior.velocitySmoothingTimeConstant = this.velocitySmoothingTimeConstant;
    this.targetBehavior.velocityPredictionTime = this.velocityPredictionTime;
    this.targetBehavior.targetInfo = this.sharedTargetInfo;
    this.targetBehavior.viewAngleDeg = this.searchViewAngleDeg;
    this.targetBehavior.excludedTags = this.excludedTags;
    this.targetBehavior.candidateFilterKey = this.candidateFilterKey;
    if (this.retired.size > 0) {
      // Seeded before initialize (see seedRetired): the inner targeting is
      // built here, so apply the exclusions now.
      this.targetBehavior.excludeEntities = this.retired;
    }

    this.followBehavior = new FollowBehavior();
    this.followBehavior.basePriority = 50;
    this.followBehavior.followRange = Math.min(
      Math.max(0.3, this.pickupRange - 0.3),
      this.pickupRange,
    ); // Stop inside take range, not at the loot's center: driving to the exact position walks the actor into the crate. The 0.3 parks inside the checkPickupRange trigger with arrival-tolerance margin; the clamp keeps a misconfigured tiny range from parking outside its own trigger. Applies to hand-prop pickups too.
    this.followBehavior.followSpeed = this.followSpeed;
    this.followBehavior.bodyDirectionMode = this.bodyDirectionMode;
    this.followBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.followBehavior.repathInterval = this.repathInterval;
    this.followBehavior.distanceToStop = this.distanceToStop;
    this.followBehavior.targetInfo = this.sharedTargetInfo;

    this.subBehaviors = [this.targetBehavior, this.followBehavior];

    // Earlier runs' refusals stay excluded: the server answers them the same
    // way every cycle, so re-targeting only walks there to retire again.
    // Seeded here — not per retire — because the loop builds a fresh behavior
    // each cycle. Destroyed loot is pruned instead of copied: it can never be
    // re-targeted, and holding it would grow the sets (and the per-cycle copy)
    // without bound. 'missing' entries carry a re-check time instead of
    // lasting: an emptied container refills, and the actor must notice.
    const now = WorldService.get().getWorldTime();
    if (this.missingLootCooldowns != null) {
      for (const [loot, retryAt] of this.missingLootCooldowns) {
        if (loot.isDestroyed() || retryAt <= now) {
          this.missingLootCooldowns.delete(loot);
          continue;
        }
        this.retired.add(loot);
      }
    }
    if (this.missingLootCooldowns != null) {
      this.targetBehavior.excludeEntities = this.retired;
    }

    // IMPORTANT: super.initialize() MUST be called before this.getEntity().
    // getEntity() requires this.behaviorManager to be set, which happens
    // inside super.initialize().
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  /**
   * Seeds retirements from an earlier run. The starter carries give-ups
   * across loop cycles (which build a fresh behavior each time); merged into
   * this run's retired set and exclusions, whenever it arrives. Despawned
   * entries are pruned from the shared set itself, so the cross-cycle memory
   * cannot grow with respawn churn.
   */
  seedRetired(entities: Set<Entity>): void {
    for (const entity of entities) {
      // Despawned retirements never resolve again; leave them behind.
      if (typeof entity.isDestroyed === 'function' && entity.isDestroyed()) {
        entities.delete(entity);
        continue;
      }
      this.retired.add(entity);
    }
    if (this.targetBehavior && this.retired.size > 0) {
      this.targetBehavior.excludeEntities = this.retired;
    }
  }

  override update(deltaTime: number): void {
    // Wait for startDelay before doing anything
    if (!this.started) {
      this.elapsedTime += deltaTime;
      if (this.elapsedTime < this.startDelay) {
        return;
      }
      this.started = true;
    }

    // Run sub-behaviors (targeting + follow)
    super.update(deltaTime);

    // Re-copied every frame (see LeadBehavior): the inner targeting is built
    // once in initialize, so a one-time copy would freeze a live edit.
    if (this.targetBehavior) {
      this.targetBehavior.viewAngleDeg = this.searchViewAngleDeg;
      this.targetBehavior.excludedTags = this.excludedTags;
      this.targetBehavior.candidateFilterKey = this.candidateFilterKey;
    }

    this.checkGiveUp(deltaTime);

    // Expired 'missing' cooldowns lift within the run too: an emptied
    // container refills, and without this a persistent run never re-checks
    // it (the initialize seeding only helps fresh behaviors). Destroyed loot
    // leaves the cooldowns instead of retired: it can never be re-targeted.
    if (this.missingLootCooldowns != null && this.missingLootCooldowns.size > 0) {
      const now = WorldService.get().getWorldTime();
      let lifted = false;
      for (const [loot, retryAt] of this.missingLootCooldowns) {
        if (loot.isDestroyed() || retryAt <= now) {
          this.missingLootCooldowns.delete(loot);
          if (!loot.isDestroyed() && this.retired.delete(loot)) {
            lifted = true;
          }
        }
      }
      if (lifted && this.targetBehavior) {
        this.targetBehavior.excludeEntities = this.retired;
      }
    }

    // Recovery: when nothing resolves for a full give-up window while give-ups
    // are remembered, every candidate is retired and the actor would idle
    // until a pickup that never comes. Lift the give-up retirements so the
    // search retries with fresh clocks. Pickup and held-item retirements stay:
    // the carried item keeps its tag, and lifting it would re-chase the hand.
    if (this.sharedTargetInfo.targetEntity == null) {
      this.emptyResolveSeconds += deltaTime;
    } else {
      this.emptyResolveSeconds = 0;
    }
    if (
      this.giveUpSeconds > 0 &&
      !this.isFinished &&
      this.emptyResolveSeconds >= this.giveUpSeconds &&
      this.fruitlessCounter.count < MAX_FRUITLESS_GIVE_UPS &&
      this.giveUpSink.size > 0
    ) {
      this.emptyResolveSeconds = 0;
      // A lift spends one retry: the cap counts recovery rounds, not
      // give-ups, so stalling on several different candidates never spends
      // the retries their shared empty window still needs.
      this.fruitlessCounter.count++;
      for (const entity of this.giveUpSink) {
        this.retired.delete(entity);
      }
      this.giveUpSink.clear();
      this.giveUpClocks.clear();
    }

    if (this.pickupRetryCooldown > 0) {
      this.pickupRetryCooldown -= deltaTime;
    }
    if (this.dwellRemaining > 0) {
      this.dwellRemaining -= deltaTime;
    }

    // Check if target is within pickup range
    this.checkPickupRange();
  }

  override getControllerUsePriority(controllerType: string): number {
    // Detection range gate: stay dormant until target is within range.
    // Once activated, stay active until finished or removed.
    if (this.detectionRange > 0 && !this.activated) {
      if (!this.isTargetInDetectionRange()) {
        return -1;
      }
      this.activated = true;
    }

    // Claim pickup controller when we have a pending pickup
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingPickup) {
      return this.basePriority;
    }

    // Post-pickup beat: claim Movement and command an explicit stop while the
    // take reads. Abstaining (-1) left the last drive input latched, so the
    // actor blew through at full stride; only a commanded stop plants the
    // feet. The pickup claim above still fires, so nothing else moves mid-dwell.
    if (this.dwellRemaining > 0 && controllerType === ActorMovementControllerTypeId) {
      return this.basePriority;
    }

    // Delegate locomotion to sub-behaviors
    return super.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    // Winning Movement is what pursuit means: the give-up clock accrues from
    // this latch, so a frame spent outranked burns nothing.
    if (controllerType === ActorMovementControllerTypeId) {
      this.drovePursuitLastFrame = true;
    }
    if (controllerType === ActorMovementControllerTypeId && this.dwellRemaining > 0) {
      (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
      return;
    }
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingPickup) {
      const pickupController = controller as ActorPickupItemController;
      const targetEntity = this.sharedTargetInfo.targetEntity;

      // The take receipt settles after the post-pickup read-back (same frame
      // on the server): ask the controller for the take's outcome instead of
      // inferring it — `readTakeOutcome`, shared in TakeOutcome.ts.
      // A sent take outlives the targeting info: the sub-behavior clears its
      // target when the loot is destroyed, so settle the awaited take before
      // touching sharedTargetInfo.
      if (this.awaitingTake != null) {
        const awaited = this.awaitingTake;
        const settled = readTakeOutcome(pickupController, this.pickupSlot, awaited);
        if (settled === 'done') {
          this.pendingPickup = false;
          this.awaitingTake = null;
          this.finishPickup(awaited);
          return;
        }
        if (isTerminalTakeRefusal(settled)) {
          this.giveUpTakeTarget(pickupController, awaited);
          // ...and file it, so later runs exclude it up front instead of
          // walking there to retire it again: 'missing' waits out its
          // re-check cooldown, anything else joins the recoverable sink.
          this.rememberRefusedLoot(awaited, settled);
          if (settled !== 'missing') {
            this.sinkGiveUp(awaited);
          }
          return;
        }
        if (settled === 'pending') {
          this.pendingPickup = true;
          return;
        }
        if (settled === 'partial') {
          // WHY the bound: every partial moves items, so a finite container
          // drains on its own — but a container that never drains would
          // re-take here forever. Count filed answers, not passes: this
          // settle block runs once per receipt, while the read-back 'partial'
          // below also fires on backed-off passes re-reading the same answer.
          if (this.partialTakeTarget !== awaited) {
            this.partialTakeTarget = awaited;
            this.partialTakeCount = 0;
          }
          this.partialTakeCount += 1;
          if (this.partialTakeCount >= this.maxPartialTakes) {
            if (this.warnedTakeRefusals == null || !this.warnedTakeRefusals.has('partial')) {
              console.warn(
                `[SearchAndPickup] take of the target keeps returning partial ` +
                  `after ${this.partialTakeCount} takes without draining it, ` +
                  `so the search is retiring it.`,
              );
              this.warnedTakeRefusals?.add('partial');
            }
            this.giveUpTakeTarget(pickupController, awaited);
            return;
          }
        }
        // A settled partial (below its bound), a retryable refusal, or nothing
        // filed: the awaited take is over — fall through to normal targeting,
        // which re-sends. Waiting out 'partial' here would stall the run:
        // nothing on that path sends, and the settled entry only clears in
        // pickupItem.
        this.awaitingTake = null;
      }
      if (targetEntity && !targetEntity.isDestroyed()) {
        // WHY: read the slot BEFORE requesting, because the read-back afterwards
        // cannot tell a refused request from a successful one when the target IS
        // the held item. A picked-up item keeps its tag and rides the hand, and
        // a loop builds a fresh behavior each cycle with an
        // empty `retired` set, so the item this actor is already holding is
        // exactly what the next cycle re-targets — and `pickupItem()` is a silent
        // no-op into an occupied slot, leaving the slot reading back as the
        // target. Without this pre-check that reads as a pickup, and the cycle
        // finishes reporting success while holding what it arrived with.
        const slotOnArrival = pickupController
          .getItemData()
          .getPickupItem(this.pickupSlot);
        // A consumed take (loot destroyed when emptied) lingers as reported
        // until something drops it: read it as empty so the run takes the new
        // target instead of finishing over a destroyed entity. Positive checks
        // only: stub entities in tests carry no `valid` field.
        const holdingOnArrival =
          slotOnArrival != null &&
          slotOnArrival.valid !== false &&
          !slotOnArrival.isDestroyed()
            ? slotOnArrival
            : undefined;

        // A settled take for THIS target is this run's pickup even though live
        // loot still reports: the receipt already confirmed it. Anything the
        // slot tracks — this run's pending take, its partial leftovers, or a
        // settled take of other loot — is not an occupied hand: the take path
        // below clears settled tracking and waits out the rest.
        const outcomeOnArrival = readTakeOutcome(pickupController, this.pickupSlot, targetEntity);
        if (
          slotOnArrival === targetEntity &&
          outcomeOnArrival === 'done' &&
          this.sentTakes.has(targetEntity)
        ) {
          this.pendingPickup = false;
          this.finishPickup(targetEntity);
          return;
        }
        const holdingIsTrackedTake =
          holdingOnArrival !== undefined &&
          isTakeTracked(pickupController, this.pickupSlot, holdingOnArrival);
        if (holdingOnArrival !== undefined && !holdingIsTrackedTake) {
          this.pendingPickup = false;
          this.finishHoldingAnotherItem(holdingOnArrival);
          return;
        }

        pickupController.pickupItem(
          new ActorRequestPickupData(targetEntity, this.pickupSlot),
        );
        this.pendingPickup = false;
        // Record the send: a 'done' the run never sent is a stale entry from
        // an earlier cycle, not this run's pickup (see the arrival pre-check
        // and the destroyed-target branch).
        this.sentTakes.add(targetEntity);

        // WHY: pickupItem() is a silent no-op when the hand slot never resolved
        // or the slot is invalid — so read the slot back instead of assuming the
        // item is now in hand. The occupied case is already handled above.
        const heldItem = pickupController
          .getItemData()
          .getPickupItem(this.pickupSlot);

        const takeOutcome = readTakeOutcome(pickupController, this.pickupSlot, targetEntity);

        if (takeOutcome === 'done' || (heldItem === targetEntity && takeOutcome == null)) {
          this.finishPickup(targetEntity);
        } else if (takeOutcome === 'pending') {
          // WHY: the receipt is still in flight — the server ran the take, but
          // its answer arrives after this read-back. Remember the loot so the
          // take settles even after targeting forgets it, and keep claiming so
          // the next pass settles it even if the actor drifts out of pickup
          // range. This counts no unresolved attempt: that bound is for takes
          // that never went out.
          this.awaitingTake = targetEntity;
          this.takeRefusals.noteNonRefusal();
          this.pendingPickup = true;
          return;
        } else if (takeOutcome === 'partial') {
          // WHY: some items moved but leftovers remain — the slot re-takes on
          // the next pass (the settled entry clears in pickupItem). Re-arm
          // instead of retiring: the target is not done, and counting this as
          // unresolved would burn the bounded retries on a take that worked.
          // Deliberately uncounted toward maxPartialTakes: this read-back also
          // fires on backed-off passes re-reading the same answer, so only
          // the awaiting settle above — once per filed receipt — counts.
          this.takeRefusals.noteNonRefusal();
          this.pendingPickup = true;
          return;
        } else if (isTerminalTakeRefusal(takeOutcome)) {
          // WHY: the server will never move this loot for this actor. Retrying
          // is wrong, so the target retires like a pickup — without the
          // picked-up flag — and a one-shot run finishes instead of chasing
          // it forever. A persistent run keeps going after the other targets.
          this.giveUpTakeTarget(pickupController, targetEntity);
          this.rememberRefusedLoot(targetEntity, takeOutcome);
          // Stable-policy refusals retire recoverably through the sink (a
          // pickup or a fruitless round lifts them); 'missing' stays out —
          // its re-check runs on the starter-owned cooldown instead.
          if (takeOutcome !== 'missing') {
            this.sinkGiveUp(targetEntity);
          }
        } else if (takeOutcome != null) {
          // WHY: a retryable refusal (full, out of reach, unhandled) is a
          // filed answer, not a missing hand socket: wait out the take
          // backoff and retry, but bound it — then finish with a warning that
          // names the refusal, not the template. The bound counts filed
          // answers, not passes (see TakeRefusalCounter): a refusal re-read
          // after a backed-off send advances nothing.
          const attempts = this.takeRefusals.count(targetEntity, takeOutcome);
          if (attempts >= this.maxPickupAttempts) {
            // Latched per actor (per run without the starter's set): a looped
            // search re-hits this every cycle, and the diagnosis does not
            // change between them.
            if (this.warnedTakeRefusals == null || !this.warnedTakeRefusals.has(takeOutcome)) {
              console.warn(
                `[SearchAndPickup] '${this.actorName()}' take of the target refused (${takeOutcome}) ` +
                  `after ${attempts} attempts, so the search is finishing empty-handed.`,
              );
              this.warnedTakeRefusals?.add(takeOutcome);
            }
            // A retryable refusal is filed, not permanent: the next cycle may
            // retry it, so it retires recoverably through the sink (lifted
            // by pickups and fruitless rounds) rather than the permanent
            // refused-loot memory.
            this.giveUpTakeTarget(pickupController, targetEntity);
            // ... but it does join the recoverable sink: the world may change
            // (a full backpack frees, a blocker walks away), so fruitless
            // rounds and pickups lift it like any other give-up.
            this.sinkGiveUp(targetEntity);
          } else {
            this.pickupRetryCooldown = this.pickupRetryInterval;
          }
        } else if (heldItem === undefined) {
          // WHY: an empty slot with no filed outcome means pickupItem() bailed
          // before sending anything (takes file pending at least). Retrying is
          // right because the DOMINANT cause — a hand socket the component is
          // still lazily resolving, which its onUpdate retries every frame —
          // clears on its own; the bound is what stops a socket that never
          // resolves from retrying for the rest of the run. It is not the only
          // cause: pickupItem() also stores nothing when pickupSlot is outside
          // PickupItemSlot, which never clears. The terminal warning names both
          // rather than diagnosing the one. Take refusals never reach here —
          // the branches above own them.
          this.unresolvedSlotAttempts += 1;
          if (this.unresolvedSlotAttempts >= this.maxPickupAttempts) {
            const windowSeconds = (
              (this.maxPickupAttempts - 1) * this.pickupRetryInterval
            ).toFixed(1);
            console.warn(
              `[SearchAndPickup] hand slot ${this.pickupSlot} stored nothing ` +
                `after ${this.unresolvedSlotAttempts} attempts over ` +
                `${windowSeconds}s, so the search is finishing empty-handed. ` +
                'Either the actor template is missing the socket child for ' +
                'this slot, or the slot is not a PickupItemSlot value — ' +
                "check ActorPickupItemComponent's own warning, which names " +
                'whichever of the two it hit.',
            );
            this.isFinished = true;
          } else {
            this.pickupRetryCooldown = this.pickupRetryInterval;
          }
        } else {
          // Defensive: the pre-check above proved the slot was empty, so only
          // something outside this behavior could have filled it with a third
          // entity between the two reads. The read-back is the only authority on
          // what the slot holds, so trust it over the pre-check rather than
          // retiring a target that was never taken.
          this.finishHoldingAnotherItem(heldItem);
        }
      } else {
        // The target is gone. A take THIS RUN sent may have consumed it: the
        // tracked entry survives destruction, so a filed 'done' for a sent
        // take still counts as this run's pickup instead of resetting to look
        // for new targets. A 'done' this run never sent is stale — reset.
        if (
          targetEntity != null &&
          readTakeOutcome(pickupController, this.pickupSlot, targetEntity) === 'done' &&
          this.sentTakes.has(targetEntity)
        ) {
          this.pendingPickup = false;
          this.finishPickup(targetEntity);
        } else {
          // Target was destroyed — reset so we can detect new targets
          this.pendingPickup = false;
        }
      }
      return;
    }

    // Delegate to sub-behaviors (follow + targeting)
    super.useController(controllerType, controller);
  }

  /**
   * Demo drivers call this when a take happens out of band — e.g. a
   * proximity-container take the behavior never hand-executed — so it still
   * reads as a pause. Arms the same dwell a hand pickup would, without
   * shortening one already running.
   */
  public notifyExternalTake(): void {
    this.dwellRemaining = Math.max(this.dwellRemaining, Math.max(0, this.postPickupDwellSec));
  }

  override onRemove(): void {    super.onRemove();
    this.isRemoved = true;
    this.pendingPickup = false;
    this.pickupRetryCooldown = 0;
    this.dwellRemaining = 0;
    this.unresolvedSlotAttempts = 0;
    this.awaitingTake = null;
    this.takeRefusals.reset();
    this.sentTakes.clear();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
    this.activated = false;
    this.pickedUpThisRun = false;
    this.giveUpClocks.clear();
    // Cleared so a restarted behavior can re-fetch an item that has since been
    // dropped — a loop builds a fresh instance each cycle,
    // but a caller reusing one would otherwise never target it again.
    this.retired.clear();
    // emptyHandedWarningLatch is deliberately left alone: it belongs to the
    // starter, not this run, and clearing it here would restore the per-frame
    // repeat it exists to stop.
    this.targetBehavior = null;
    this.followBehavior = null;
    this.actorTransform = null;
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Actor name for diagnostics. `behaviorManager` is unset when tests drive
   * the behavior without `initialize()`, so this must stay null-safe.
   */
  private actorName(): string {
    return this.behaviorManager?.actorEntity.name ?? 'unknown actor';
  }

  /**
   * Retires a target the run is done with, keeping it out of later searches.
   * The taken target retires like a pickup (without the picked-up flag); the
   * held item retires because it rides the hand.
   */
  private retireTarget(target: Entity): void {
    this.retired.add(target);
    if (this.targetBehavior) {
      this.targetBehavior.excludeEntities = this.retired;
    }
  }

  /**
   * 'missing' gets a re-check time — a live container answers it while merely
   * empty, so a refilled container must stay takeable. Stable-policy refusals
   * retire recoverably through the give-up sink instead (see the settle
   * branches); destroyed loot needs no memory either: it can never be
   * re-targeted, and the seed prune drops it.
   */
  private rememberRefusedLoot(target: Entity, outcome: TakeOutcome): void {
    if (outcome !== 'missing') {
      return;
    }
    const cooldowns = this.missingLootCooldowns;
    if (cooldowns == null) {
      return;
    }
    // Re-insert to refresh recency: a Map keeps the original position on
    // re-set, which would otherwise evict an actively-refreshed cooldown
    // first.
    cooldowns.delete(target);
    cooldowns.set(target, WorldService.get().getWorldTime() + MISSING_RETRY_COOLDOWN_SECONDS);
    // Bounded: live empty refillables never trip the seed prune, so without
    // this a long-lived actor accumulates one entry per distinct container.
    // Evicting a live cooldown only re-takes that container sooner.
    while (cooldowns.size > MAX_REFUSED_LOOT_MEMORY) {
      const oldest = cooldowns.keys().next();
      if (oldest.done) {
        break;
      }
      cooldowns.delete(oldest.value);
    }
  }

  /**
   * Files a give-up in the recoverable sink, evicting the oldest past the
   * cap. Re-insert refreshes recency (a Set keeps the original position on
   * re-add), so an actively-refused target is never the one evicted.
   */
  private sinkGiveUp(target: Entity): void {
    this.giveUpSink.delete(target);
    this.giveUpSink.add(target);
    while (this.giveUpSink.size > MAX_GIVE_UP_SINK) {
      const oldest = this.giveUpSink.keys().next();
      if (oldest.done) {
        break;
      }
      this.giveUpSink.delete(oldest.value);
    }
  }

  /**
   * Gives up on a take target: clears the run's take state, forgets the
   * slot's take tracking, and retires the target for this run. The clear is
   * the load-bearing half — without it the filed entry outlives the run and
   * the slot keeps reporting abandoned loot as held. clearTakeTracking
   * deposits nothing: the goods stay in the inventory (a real drop-off
   * deposits via dropItem). Cross-run memory stays with the callers:
   * refusals retire recoverably through the give-up sink (missing runs on
   * its own re-check cooldown instead). A one-shot run finishes; a
   * persistent run keeps going after the others.
   */
  private giveUpTakeTarget(
    pickupController: ActorPickupItemController,
    target: Entity,
  ): void {
    this.pendingPickup = false;
    this.awaitingTake = null;
    this.takeRefusals.reset();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
    // The run is done with this target, so its send entry leaves with it:
    // a persistent run that retires many refused targets would otherwise
    // grow one entry per target. Re-targeting re-sends and re-adds.
    this.sentTakes.delete(target);
    clearTakeTracking(pickupController, this.pickupSlot);
    this.retireTarget(target);
    if (!this.persistent) {
      this.isFinished = true;
    }
  }

  /**
   * The run picked its target up: completions count it, one-shot runs finish,
   * and the target retires so a persistent search does not chase a point that
   * moves with the actor.
   */
  private finishPickup(target: Entity): void {
    this.unresolvedSlotAttempts = 0;
    this.pickedUpThisRun = true;
    this.awaitingTake = null;
    this.takeRefusals.reset();
    this.sentTakes.clear();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
    this.giveUpClocks.clear();
    // A pickup proves the world moved: remembered give-ups become eligible
    // again, so they leave `retired` as well as the sink. Only remembered
    // ones lift — picked-up items were never filed here, and sink-evicted
    // give-ups stay retired for the rest of the run (the next cycle
    // re-chases them, since seeding walks the same sink).
    for (const entity of this.giveUpSink) {
      this.retired.delete(entity);
    }
    this.giveUpSink.clear();
    this.fruitlessCounter.count = 0;
    this.dwellRemaining = Math.max(0, this.postPickupDwellSec);
    // A picked-up item keeps its tag and rides the hand, so a persistent
    // search would re-acquire it and chase a point that moves with the
    // actor. Retiring it here is what bounds the search to items still
    // on the ground.
    this.retireTarget(target);
    if (!this.persistent) {
      this.isFinished = true;
    }
  }

  /**
   * Ends a run that cannot pick anything up because `heldItem` occupies the hand
   * slot. Nothing reachable from here frees it: this behavior never drops, and
   * every composition the package ships runs one behavior at a time —
   * `SequentialBehavior` and a loop that re-runs the starter advance only once this
   * behavior sets `isFinished`, and in a concurrent pairing this composite claims
   * Movement at its own `basePriority`, out-ranking the deliver partners, for as
   * long as it stays unfinished. So retrying cannot succeed; finishing hands the
   * next cycle a chance with an empty hand.
   *
   * The target is deliberately NOT retired — it was never taken, so it stays
   * searchable. `heldItem` is, because it rides the actor's hand and keeps its
   * tag, so a persistent run would otherwise walk toward a point that moves with
   * the actor.
   */
  private finishHoldingAnotherItem(heldItem: Entity): void {
    // WHY the pickedUpThisRun guard: finishing after a pickup is the documented
    // one-item-per-run terminus, so warning there would fire on every loop cycle
    // in normal operation. Having picked nothing up means the hand was already
    // full on arrival — a composition this behavior cannot work in — which is
    // worth naming, since pickupItem()'s own occupied-slot log is
    // debugLogEnabled-gated and defaults off.
    //
    // WHY the latch as well: that misconfiguration holds on EVERY cycle, and a
    // loop may restart the behavior on the very next frame, so the guard alone
    // leaves an accurate warning firing at frame rate.
    if (!this.pickedUpThisRun && this.emptyHandedWarningLatch?.warned !== true) {
      if (this.emptyHandedWarningLatch) {
        this.emptyHandedWarningLatch.warned = true;
      }
      console.warn(
        `[SearchAndPickup] '${this.actorName()}' hand slot ${this.pickupSlot} already holds ` +
          'another item and nothing this behavior can reach will free it, ' +
          'so the search is finishing without collecting anything. ' +
          'Sequence this after a behavior that empties the hand rather ' +
          'than running the two concurrently.',
      );
    }
    this.retireTarget(heldItem);
    this.isFinished = true;
  }

  /**
   * Returns true if the target entity is within detectionRange (XZ distance).
   * Used to gate activation when detectionRange > 0.
   */
  private isTargetInDetectionRange(): boolean {
    if (!this.actorTransform || !this.sharedTargetInfo.isValid || !this.sharedTargetInfo.targetEntity) {
      return false;
    }

    const targetTransform = this.sharedTargetInfo.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      return false;
    }

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    return (dx * dx + dz * dz) <= (this.detectionRange * this.detectionRange);
  }

  private checkPickupRange(): void {
    if (
      this.pendingPickup ||
      this.pickupRetryCooldown > 0 ||
      this.dwellRemaining > 0 ||
      !this.actorTransform
    ) {
      return;
    }

    if (!this.sharedTargetInfo.isValid || !this.sharedTargetInfo.targetEntity) {
      return;
    }

    const targetTransform = this.sharedTargetInfo.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      return;
    }

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;

    // XZ distance only (ignore height)
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ <= this.pickupRange) {
      this.pendingPickup = true;
    }
  }

  /**
   * Retires the current target once its accrued pursuit time reaches
   * `giveUpSeconds`, so a run stalls on an unreachable item for at most that
   * long. A persistent search then moves to the next candidate; a one-shot
   * search finishes.
   */
  private checkGiveUp(dt: number): void {
    // Consumed every frame, whatever the guards below decide, so the latch
    // never goes stale across an early return.
    const drove = this.drovePursuitLastFrame;
    this.drovePursuitLastFrame = false;
    if (this.giveUpSeconds <= 0 || this.isFinished) {
      return;
    }
    // Dormant behind detectionRange: the actor is not chasing anything, so
    // the clock must not run against a target it never pursued.
    if (this.detectionRange > 0 && !this.activated) {
      return;
    }
    // A forced pause is not pursuit: the clock stalls while the looter dwells
    // on a picked-up item, so the dwell itself never burns a target's
    // give-up budget.
    if (this.dwellRemaining > 0) {
      return;
    }
    const current = this.sharedTargetInfo.targetEntity;
    // The clock bounds hovering over a held target, not searching for one:
    // time with no target resolved neither accrues nor retires anything.
    if (!current) {
      return;
    }
    // Outranked is not pursuit either: while another behavior drives
    // locomotion the actor chases nothing, so the clock must not retire a
    // target it never moved toward.
    if (!drove) {
      return;
    }
    // A take exchange in progress is productive, not hovering: the clock
    // stalls while a receipt is awaited or armed, so a slow receipt or a
    // multi-take drain never burns a yielding target's give-up budget. Once
    // nothing is in flight — a filed refusal waiting out backoff, a target
    // stranded out of range — the clock owns the hover again: the take
    // bounds only advance on re-sends, so without this a target that never
    // re-sends would hover forever.
    if (this.awaitingTake != null || this.pendingPickup) {
      return;
    }
    const accrued = (this.giveUpClocks.get(current) ?? 0) + dt;
    // Refresh recency first: the pursued target is newest, so the cap below
    // always evicts a stale transient.
    this.giveUpClocks.delete(current);
    this.giveUpClocks.set(current, accrued);
    while (this.giveUpClocks.size > MAX_GIVE_UP_CLOCKS) {
      const oldest = this.giveUpClocks.keys().next();
      if (oldest.done) {
        break;
      }
      this.giveUpClocks.delete(oldest.value);
    }
    if (accrued < this.giveUpSeconds) {
      return;
    }
    this.giveUpClocks.delete(current);
    // The run is done with this target: drop its send entry (a late 'done'
    // for a retired target is stale — the settle guards check membership —
    // and a persistent run would otherwise grow one entry per trip) and
    // reset the refusal/partial streaks, like giveUpTakeTarget. Re-targeting
    // re-sends and re-adds. The trip has no controller handle, so a
    // controller-side filed entry clears on the next send instead of here;
    // reads are entity-keyed, so it is ignored until then.
    this.sentTakes.delete(current);
    this.takeRefusals.reset();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
    this.retired.add(current);
    this.sinkGiveUp(current);
    if (this.targetBehavior) {
      // Published for resolveTarget, which skips every listed entity: this
      // is what retires the target from the next pick.
      this.targetBehavior.excludeEntities = this.retired;
    }
    if (!this.persistent) {
      this.isFinished = true;
    }
  }
}
