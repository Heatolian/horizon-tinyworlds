/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v34

import {
  Vec3,
  type Entity,
  TransformComponent,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import {isTakeTracked, isTerminalTakeRefusal, readTakeOutcome, clearTakeTracking, TakeRefusalCounter} from '../../Utilities/TakeOutcome';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestPickupData,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';
import {TargetTaggedEntityBehavior} from './Tagging/TargetTaggedEntityBehavior';

/**
 * Pending pickup/drop action to be executed via the priority system.
 */
enum PendingPickupAction {
  None,
  Pickup,
  Drop,
}

/**
 * SimpleFetchBehavior - Makes an Actor fetch a single item and deliver it.
 *
 * Flow:
 * - When not holding item: walk toward itemToPickUp, pick up when in range
 * - When holding item: walk toward itemDropOffPoint, drop when in range
 *
 * After drop-off, clears itemToPickUp and returns to finished. Dropping a
 * take-tracked slot at the drop-off deposits the take-receiving backpacks
 * as world loot (see `ActorPickupItemComponent.dropItem`): fetch→drop-off
 * delivers take-loot through the deposit.
 * Uses GotoBehavior internally for locomotion.
 * Pickup/drop actions go through the priority arbitration system via useController().
 */
export class SimpleFetchBehavior extends ActorBehavior {
  itemToPickUp: Entity | null = null;
  /** Display label for the target: `name` throws once the entity is destroyed, so warnings must never read it unguarded. */
  private get itemLabel(): string {
    const target = this.itemToPickUp;
    if (target == null || target.valid === false || target.isDestroyed()) {
      return '<destroyed>';
    }
    return target.name;
  }
  /**
   * Tag fallback when itemToPickUp is unset: the nearest tagged entity with a
   * transform becomes the target. Lets the starter point at loot spawned at
   * runtime (spawners mint new entities, so no authored reference can name
   * them). Dead characters are never fetched; their dropped loot, a separate
   * entity, resolves normally. Read when the behavior starts; edits apply on
   * restart.
   */
  itemToPickUpTag: string = '';
  /**
   * Horizontal view angle (deg) tag-resolved loot must fall inside to be
   * noticed, measured from the actor's body facing. 0 (default) keeps the
   * omniscient resolution. An acquired target is kept without re-checking the
   * cone. Read when the behavior starts; edits apply on restart.
   */
  fetchViewAngleDeg: number = 0;
  /**
   * Tags whose carriers tag-resolution never fetches (e.g. "opened"). Empty
   * (default) skips nothing. Read when the behavior starts; edits apply on
   * restart.
   */
  fetchExcludedTags: string[] = [];
  /**
   * Starter-owned map of delivered props to each prop's drop-time position
   * (its own position at the drop, else the drop-off or actor position),
   * written through on drop-off: a delivered hand prop keeps its tag, so
   * without this a restarted fetch re-fetches what it just delivered. Only
   * entity identity would survive a restart, so the drop position travels
   * with it — seeding re-anchors each prop at its real drop spot, never at
   * the current one.
   */
  deliveredSink: Map<Entity, Vec3> | null = null;
  itemDropOffPoint: Entity | null = null;
  itemPickupRange: number = 1.0;
  moveSpeed: number = 5.0;
  pickupSlot: PickupItemSlot = PickupItemSlot.RightHand;
  /** Seconds to wait before starting the fetch cycle. Prevents instant completion during scene loading. */
  startDelay: number = 0;

  /** Attempts the current target has been refused; see the retry bound in update(). */
  maxTakeRefusedAttempts: number = 3;

  /**
   * Consecutive 'partial' observations while not holding before the fetch
   * gives up. Unreachable against the real controller — a partial entry
   * always reports live loot or tracks a consumed take, and both read as
   * holding — so this is a backstop against a stuck read, mirroring
   * SearchAndPickup's maxPartialTakes.
   */
  maxPartialTakes: number = 10;

  private currentGotoBehavior: GotoBehavior | null = null;
  private isHoldingItem: boolean = false;
  private pendingAction: PendingPickupAction = PendingPickupAction.None;
  private lastPickupController: ActorPickupItemController | null = null;
  private elapsedTime: number = 0;
  private started: boolean = false;
  /** Filed refusal answers for the current target; see TakeRefusalCounter. */
  private readonly takeRefusals = new TakeRefusalCounter();
  /** Target the partial-take streak below belongs to; a new target restarts it. */
  private partialTakeTarget: Entity | null = null;
  private partialTakeCount: number = 0;
  /** Latched so the tag-wait warn below fires once per run, not per frame. */
  private tagWaitWarned: boolean = false;

  /**
   * Shared tag targeting (nearest-wins, self-skip, destroyed-skip, skip tags,
   * optional view cone) behind tag mode. Entity-ref mode never touches it.
   */
  private tagTargeting: TargetTaggedEntityBehavior | null = null;
  /**
   * Run-local tag exclusions: seeded delivered props. Read by the inner
   * targeting, never replaced.
   */
  private readonly tagExcluded: Set<Entity> = new Set<Entity>();
  /**
   * Where each excluded prop was dropped. Seeded entries carry their real drop
   * position from the starter-owned map; drop-branch entries are anchored at
   * the delivered prop's own drop-time position (falling back to the drop-off,
   * else the actor's feet). An exclusion ends when its prop leaves this anchor
   * (see `releaseMovedDeliveries`). `Vec3` is immutable, so keeping the
   * reference allocates nothing.
   */
  private readonly exclusionAnchors = new Map<Entity, Vec3>();

  /**
   * Seeds run-local tag exclusions from the starter-owned map, so a restarted
   * fetch skips what an earlier cycle delivered. Each entry carries its real
   * drop position — that is what survives the restart, not the current
   * drop-off or actor pose. Despawned entries never resolve again; left behind
   * (and pruned from the source map, bounding it).
   */
  seedDelivered(deliveries: Map<Entity, Vec3>): void {
    for (const [entity, dropPos] of deliveries) {
      if (typeof entity.isDestroyed === 'function' && entity.isDestroyed()) {
        deliveries.delete(entity);
        continue;
      }
      this.tagExcluded.add(entity);
      this.exclusionAnchors.set(entity, dropPos);
    }
    if (this.tagTargeting) {
      this.tagTargeting.excludeEntities = this.tagExcluded;
    }
  }

  /**
   * Releases delivered-prop exclusions whose prop left where it was dropped:
   * a prop carried away (by a player, another actor, or lifted onto a shelf)
   * is back in circulation and fetchable again. Runs every frame; cheap (a
   * few squared-distance checks, no allocation, Set deletion during iteration
   * is safe). Entries that were never anchored (no readable transform at
   * record time) stay excluded.
   */
  private releaseMovedDeliveries(): void {
    if (this.tagExcluded.size === 0 || this.itemToPickUpTag.length === 0) {
      return;
    }
    // Twice the pickup range, floored to cover the landing envelope: the drop
    // fires while the actor is still a stop-distance out and the prop falls
    // from the hand, so a just-dropped prop never rests on the anchor. The
    // floor (range + 1.5 m) covers stop distance plus hand offset plus the
    // fall; a prop carried past either bound is back in circulation.
    const releaseDist = Math.max(this.itemPickupRange * 2, this.itemPickupRange + 1.5);
    const releaseSq = releaseDist * releaseDist;
    for (const prop of this.tagExcluded) {
      // Hygiene first: destroyed or deregistered entries leave regardless of
      // position.
      if (prop.isDestroyed() || prop.valid === false) {
        this.tagExcluded.delete(prop);
        this.deliveredSink?.delete(prop);
        this.exclusionAnchors.delete(prop);
        continue;
      }
      const anchor = this.exclusionAnchors.get(prop);
      if (!anchor) {
        continue;
      }
      const pos = prop.getComponent(TransformComponent)?.worldPosition;
      if (!pos) {
        continue;
      }
      // Full 3D distance: a prop lifted onto a shelf above the drop point is
      // as back-in-circulation as one carried across the room.
      const dx = pos.x - anchor.x;
      const dy = pos.y - anchor.y;
      const dz = pos.z - anchor.z;
      if (dx * dx + dy * dy + dz * dz > releaseSq) {
        this.tagExcluded.delete(prop);
        this.deliveredSink?.delete(prop);
        this.exclusionAnchors.delete(prop);
      }
    }
  }

  /**
   * Tag-mode resolution through the shared targeting behavior. Returns the
   * live target, or null while nothing valid resolves.
   */
  private resolveTagTarget(deltaTime: number): Entity | null {
    const targeting = this.tagTargeting;
    if (!targeting) {
      return null;
    }
    targeting.update(deltaTime);
    const info = targeting.targetInfo;
    const target = info.isValid ? info.targetEntity : null;
    // The shared query skips destroyed loot, but an entity invalidated without
    // destruction (a deregistered handle) still needs the guard: never latch
    // what is already gone.
    if (!target || target.valid === false || target.isDestroyed()) {
      return null;
    }
    return target;
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.currentGotoBehavior = new GotoBehavior();
    this.currentGotoBehavior.desiredSpeed = this.moveSpeed;
    // Movement is claimed through the nested goto, so without this the walk
    // arbitrates at the class default of 0 whatever basePriority was set to.
    this.currentGotoBehavior.basePriority = this.basePriority;
    // Preserve prior behavior: SimpleFetch does not control body direction, so
    // keep the nested goto from claiming the body-direction controller.
    this.currentGotoBehavior.shouldFaceDirection = false;
    // No distanceToStop override: it feeds the goto's waypoint-advance
    // tolerance, so a raised stop would turn early at every navmesh waypoint
    // and cut corners on detour paths. The walk stops at the behavior level
    // instead — handleMovingToItem/handleMovingToDropOff halt the goto once
    // inside arrival range (arrival triggers fire at itemPickupRange).

    const transform = this.getEntity().getComponent(TransformComponent);
    if (transform) {
      this.currentGotoBehavior.targetPosition = transform.worldPosition;
    }

    if (this.behaviorManager) {
      void this.currentGotoBehavior.initialize(this.behaviorManager);
    }

    this.tagTargeting = new TargetTaggedEntityBehavior();
    this.tagTargeting.targetTags = this.itemToPickUpTag.length > 0 ? [this.itemToPickUpTag] : [];
    this.tagTargeting.viewAngleDeg = this.fetchViewAngleDeg;
    this.tagTargeting.excludedTags = this.fetchExcludedTags;
    this.tagTargeting.excludeEntities = this.tagExcluded;
    // SimpleFetch owns the wait-warn in update: the shared no-producer warn
    // would false-positive on spawner-minted loot that registers late.
    this.tagTargeting.noProducerGraceSeconds = Number.POSITIVE_INFINITY;
    if (this.behaviorManager) {
      void this.tagTargeting.initialize(this.behaviorManager);
    }
  }

  /**
   * Where a dropped prop lands: the drop-off position, else the actor's own
   * position (a fetch with no drop-off point drops at its feet). Null when
   * neither has a readable transform — before initialize there is no manager
   * yet, so only the drop-off is consulted.
   */
  private dropAnchor(): Vec3 | null {
    const dropPos = this.itemDropOffPoint?.getComponent(TransformComponent)?.worldPosition ?? null;
    if (dropPos) {
      return dropPos;
    }
    if (!this.behaviorManager) {
      return null;
    }
    return this.getEntity().getComponent(TransformComponent)?.worldPosition ?? null;
  }

  override update(deltaTime: number): void {
    // Wait for startDelay before beginning the fetch cycle
    if (!this.started) {
      this.elapsedTime += deltaTime;
      if (this.elapsedTime < this.startDelay) {
        return;
      }
      this.started = true;
    }

    // Delivered props that left the drop-off are back in circulation before
    // anything resolves below.
    this.releaseMovedDeliveries();

    // Tag fallback: resolve once the cycle starts, so spawner-minted loot has
    // registered before we look. Keeps retrying while unresolved — a missing
    // tag means the loot is not in the world yet, not that the fetch is over.
    if (!this.itemToPickUp && this.itemToPickUpTag.length > 0) {
      this.itemToPickUp = this.resolveTagTarget(deltaTime);
      if (!this.itemToPickUp) {
        if (!this.tagWaitWarned) {
          this.tagWaitWarned = true;
          console.warn(
            `[SimpleFetch] waiting for loot tagged '${this.itemToPickUpTag}'.`,
          );
        }
        return;
      }
    }

    // Tag re-resolution: spawner-minted loot is contested and short-lived — a
    // latched crate drained by someone else destroys itself, and chasing the
    // dead reference stalls the fetch. While not holding, a destroyed target
    // that isn't take-tracked for this slot releases back to null, so the
    // next frame resolves the nearest live crate. (A consumed take stays
    // tracked: updateHoldingState keeps isHoldingItem, so its run still
    // completes to the drop-off.)
    if (
      this.itemToPickUpTag.length > 0 &&
      !this.isHoldingItem &&
      this.itemToPickUp != null &&
      (this.itemToPickUp.valid === false || this.itemToPickUp.isDestroyed()) &&
      !isTakeTracked(this.lastPickupController, this.pickupSlot, this.itemToPickUp)
    ) {
      this.itemToPickUp = null;
      this.takeRefusals.reset();
      this.partialTakeTarget = null;
      this.partialTakeCount = 0;
    }

    if (!this.currentGotoBehavior || !this.itemToPickUp) {
      return;
    }

    this.updateHoldingState();

    // A filed take outcome for this loot that is neither progress nor pending
    // ends the fetch instead of retrying it forever: terminal refusals give
    // up at once, retryable ones (full, out of reach, unhandled) get a bound.
    // The bound counts filed answers, not frames — see TakeRefusalCounter — so
    // one refusal held across frames never reaches it on its own.
    if (!this.isHoldingItem && this.itemToPickUp != null) {
      const outcome = readTakeOutcome(this.lastPickupController, this.pickupSlot, this.itemToPickUp);
      if (outcome != null && outcome !== 'pending' && outcome !== 'done' && outcome !== 'partial') {
        if (isTerminalTakeRefusal(outcome)) {
          console.warn(
            `[SimpleFetch] take of '${this.itemLabel}' terminally refused (${outcome}); finishing empty-handed.`,
          );
          this.finishRefusedFetch();
          return;
        }
        const attempts = this.takeRefusals.count(this.itemToPickUp, outcome);
        if (attempts >= this.maxTakeRefusedAttempts) {
          console.warn(
            `[SimpleFetch] take of '${this.itemLabel}' refused (${outcome}) ${attempts} times; finishing empty-handed.`,
          );
          this.finishRefusedFetch();
          return;
        }
      } else {
        if (outcome === 'partial') {
          // A partial the fetch is not holding: the entry reports live loot
          // and tracks a consumed take, so this means the read is stuck, not
          // draining — bound it instead of fetching forever.
          if (this.partialTakeTarget !== this.itemToPickUp) {
            this.partialTakeTarget = this.itemToPickUp;
            this.partialTakeCount = 0;
          }
          this.partialTakeCount += 1;
          if (this.partialTakeCount >= this.maxPartialTakes) {
            console.warn(
              `[SimpleFetch] take of '${this.itemLabel}' still partial ` +
                `after ${this.partialTakeCount} takes without holding it; finishing empty-handed.`,
            );
            this.finishRefusedFetch();
            return;
          }
        } else {
          this.partialTakeTarget = null;
          this.partialTakeCount = 0;
        }
        this.takeRefusals.noteNonRefusal();
      }
    } else {
      this.takeRefusals.reset();
      this.partialTakeTarget = null;
      this.partialTakeCount = 0;
    }

    const actorTransform = this.getEntity().getComponent(TransformComponent);
    if (!actorTransform) {
      return;
    }

    const actorPos = actorTransform.worldPosition;
    const actorPosXZ = new Vec3(actorPos.x, 0, actorPos.z);

    if (!this.isHoldingItem) {
      this.handleMovingToItem(actorPosXZ, actorPos);
    } else {
      this.handleMovingToDropOff(actorPosXZ, actorPos);
    }

    void this.currentGotoBehavior.update(deltaTime);
  }

  private updateHoldingState(): void {
    if (!this.lastPickupController) {
      this.isHoldingItem = false;
      return;
    }

    const itemData = this.lastPickupController.getItemData();
    const heldItem = itemData.getPickupItem(this.pickupSlot);
    // A consumed take (loot destroyed) is no longer reported as held, but the
    // take is still tracked: stay holding so the run completes to its
    // drop-off instead of chasing a destroyed target.
    const takeTrackedForTarget = isTakeTracked(
      this.lastPickupController,
      this.pickupSlot,
      this.itemToPickUp,
    );
    const targetConsumed =
      this.itemToPickUp != null &&
      (this.itemToPickUp.valid === false || this.itemToPickUp.isDestroyed()) &&
      heldItem == null;
    this.isHoldingItem = heldItem === this.itemToPickUp || (takeTrackedForTarget && targetConsumed);
  }

  /** Ends a fetch whose take will not complete, forgetting the refusal. */
  private finishRefusedFetch(): void {
    // Forget the refusal so it cannot outlive the run. The slot holds no
    // hand prop, and the take moved nothing worth delivering — clear the
    // tracking without depositing (a real drop-off deposits via dropItem).
    clearTakeTracking(this.lastPickupController, this.pickupSlot);
    this.itemToPickUp = null;
    this.takeRefusals.reset();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
    this.isFinished = true;
  }

  private handleMovingToItem(actorPosXZ: Vec3, actorPos: Vec3): void {
    if (!this.itemToPickUp || !this.currentGotoBehavior) {
      return;
    }

    const itemTransform = this.itemToPickUp.getComponent(TransformComponent);
    if (!itemTransform) {
      return;
    }

    const itemPos = itemTransform.worldPosition;
    const itemPosXZ = new Vec3(itemPos.x, 0, itemPos.z);
    const distance = actorPosXZ.sub(itemPosXZ).magnitude();

    if (distance <= this.itemPickupRange) {
      this.pendingAction = PendingPickupAction.Pickup;
      // Halt here: the goto keeps its last target (the item's center) and
      // would otherwise walk the actor into the crate after arrival.
      this.currentGotoBehavior.targetPosition = actorPos;
    } else {
      this.currentGotoBehavior.targetPosition = new Vec3(itemPos.x, actorPos.y, itemPos.z);
    }
  }

  private handleMovingToDropOff(actorPosXZ: Vec3, actorPos: Vec3): void {
    if (!this.itemDropOffPoint || !this.currentGotoBehavior) {
      // No drop-off point — drop item at current location and finish
      this.pendingAction = PendingPickupAction.Drop;
      return;
    }

    const dropOffTransform = this.itemDropOffPoint.getComponent(TransformComponent);
    if (!dropOffTransform) {
      return;
    }

    const dropOffPos = dropOffTransform.worldPosition;
    const dropOffPosXZ = new Vec3(dropOffPos.x, 0, dropOffPos.z);
    const distance = actorPosXZ.sub(dropOffPosXZ).magnitude();

    if (distance <= this.itemPickupRange) {
      this.pendingAction = PendingPickupAction.Drop;
      // Halt here: same walk-into-the-target problem as the item approach.
      this.currentGotoBehavior.targetPosition = actorPos;
    } else {
      this.currentGotoBehavior.targetPosition = new Vec3(dropOffPos.x, actorPos.y, dropOffPos.z);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (!this.itemToPickUp || !this.currentGotoBehavior) {
      return -1;
    }

    if (controllerType === ActorPickupItemControllerTypeId) {
      return this.basePriority;
    }

    return this.currentGotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId) {
      const pickupController = controller as ActorPickupItemController;
      this.lastPickupController = pickupController;

      if (this.pendingAction === PendingPickupAction.Pickup && this.itemToPickUp) {
        pickupController.pickupItem(
          new ActorRequestPickupData(this.itemToPickUp, this.pickupSlot),
        );
        this.pendingAction = PendingPickupAction.None;
        // A fresh take going 'pending' starts a new answer cycle: the receipt
        // files after this pass, so without this the next identical refusal
        // would read as the same answer and the bound could never advance. A
        // backed-off send leaves the old refusal in place, so it reads as a
        // refusal here and advances nothing.
        if (readTakeOutcome(pickupController, this.pickupSlot, this.itemToPickUp) === 'pending') {
          this.takeRefusals.noteNonRefusal();
        }
      } else if (this.pendingAction === PendingPickupAction.Drop) {
        const delivered = this.itemToPickUp;
        // Read take state before dropItem clears its tracking. Only hand-prop
        // deliveries are remembered: a take-tracked slot's container may still
        // hold contents (partial), and excluding it would abandon the rest
        // after one trip.
        const takeDelivered = isTakeTracked(pickupController, this.pickupSlot, delivered);
        // A take-tracked slot delivers through the deposit: the drop moves
        // the take-receiving backpacks out as world loot at the drop-off
        // (see ActorPickupItemComponent.dropItem). A refused take moved
        // nothing, so its drop is a no-op deposit — still correct to run.
        pickupController.dropItem(new ActorRequestDropData(this.pickupSlot));
        this.pendingAction = PendingPickupAction.None;
        if (delivered != null && !takeDelivered && this.itemToPickUpTag.length > 0) {
          // Remembered across loop cycles through the starter-owned map, so a
          // restarted fetch never re-fetches the prop it just delivered (a
          // delivered hand prop keeps its tag). Anchored at the prop's own
          // drop-time position with it persisted in the map, so the exclusion
          // ends when the prop leaves that spot. Tag mode only: entity-ref
          // runs never consult the map.
          // The hand position, not the drop-off pivot: the drop fires a
          // stop-distance out and the prop falls from the hand, so the hand
          // is strictly closer to where it lands. Falls back to the drop
          // position when the prop has no readable transform.
          const anchor =
            delivered.getComponent(TransformComponent)?.worldPosition ?? this.dropAnchor();
          if (anchor) {
            this.tagExcluded.add(delivered);
            this.deliveredSink?.set(delivered, anchor);
            this.exclusionAnchors.set(delivered, anchor);
          }
        }
        this.itemToPickUp = null;
        this.isFinished = true;
      }
      return;
    }

    if (this.currentGotoBehavior) {
      this.currentGotoBehavior.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    super.onRemove();
    if (this.currentGotoBehavior) {
      this.currentGotoBehavior.onRemove();
    }
    this.currentGotoBehavior = null;
    if (this.tagTargeting) {
      this.tagTargeting.onRemove();
    }
    this.tagTargeting = null;
    this.tagExcluded.clear();
    this.exclusionAnchors.clear();
    this.itemToPickUp = null;
    this.isHoldingItem = false;
    this.pendingAction = PendingPickupAction.None;
    this.lastPickupController = null;
    this.takeRefusals.reset();
    this.partialTakeTarget = null;
    this.partialTakeCount = 0;
  }
}
