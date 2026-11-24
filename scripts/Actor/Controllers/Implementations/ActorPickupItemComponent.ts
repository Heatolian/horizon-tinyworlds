/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  component,
  Component,
  OnEntityCreateEvent,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  subscribe,
  subscribePropertyChange,
  OnEntityDestroyEvent,
  property,
  editor,
  TransformComponent,
  PhysicsBodyComponent,
  ExecuteOn,
  Vec3,
  Quaternion,
  type Entity,
  NetworkMode,
  WorldService,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {ActorFrameTicker, type FrameTickable} from '../../Utilities/ActorFrameTicker';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestPickupData,
  ActorPickupItemData,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';
import {dropItem as requestDropItem, interact, slot as containerSlot} from '../../../ItemSystem/container/ItemCommands';
import {ItemResult, type ItemRefusal, type SlotRef} from '../../../ItemSystem/container/ItemRequest';
import {ItemContainer, ContainerEquipMode, containerRegistry} from '../../../ItemSystem/container/ItemContainer';
import {characterOf} from '../../../ItemSystem/container/CharacterLookup';
import type {IActorItemSystemTake, ItemSystemTakeOutcome} from '../Definitions/IActorItemSystemTake';
import {Interactable} from '../../../ItemSystem/interaction/Interactable';

/** Seconds of world time a refused take waits before the slot tries the server again. */
const TAKE_RETRY_COOLDOWN_SECONDS = 1;

/** A take request sent for a slot. An entry means pending or confirmed — a refused take is deleted and its reason remembered separately. */
interface TrackedTake {
  loot: Entity;
  /** The loot's name captured at send: `name` throws once the loot is destroyed, so receipts must never read it live. */
  lootName: string;
  /** Null while the receipt is in flight; the server runs the handler before the promise settles. */
  result: ItemResult | null;
}

/** A refused take, remembered so behaviors can give up on loot that never moves. */
interface RefusedTake {
  loot: Entity;
  reason: ItemRefusal;
}

class PickupItemState {
  entity: Entity;
  slot: PickupItemSlot;
  originalCollisionEnabled: boolean | null = null;
  originalIsAffectedByGravity: boolean | null = null;
  gripPositionOffset: Vec3 = Vec3.zero;
  gripRotationOffset: Quaternion = Quaternion.identity;

  constructor(entity: Entity, slot: PickupItemSlot) {
    this.entity = entity;
    this.slot = slot;
  }
}

/**
 * ActorPickupItemComponent - Implements ActorPickupItemController for item pickup/drop.
 *
 * Two paths. A target offering the `take` interaction backed by a container is
 * ItemSystem loot: the server moves it into the character's containers through
 * one `interact` request, and the slot only tracks the take. Anything else is
 * a hand prop carried the legacy way below.
 *
 * Uses a transform-copy approach: per-frame copies worldPosition/worldRotation
 * from hand slot entity to held item, only while a hand prop is held (most
 * actors never hold one, so an idle component costs nothing per frame).
 * Supports both RightHand and LeftHand slots with physics state preservation
 * (disable on pickup, restore on drop).
 *
 * Hand slots are auto-resolved by searching for child entities named
 * "RightHandSocket"/"RightHandSlot" and "LeftHandSocket"/"LeftHandSlot".
 *
 * Networking: The server (Owner) performs pickup/drop logic. Held item entity
 * references are synced to the client via networked properties so the client
 * can do the per-frame transform copy where rendering happens; a client starts
 * and stops its copy when those properties change.
 */
@component({
  networkedRequirement: NetworkMode.Networked,
  description:
    'Lets the actor carry an item in a hand slot. Binds the slots by explicit entity reference, falling back to a child named RightHandSocket/LeftHandSocket when unset.',
})
export class ActorPickupItemComponent extends Component implements ActorPickupItemController, IActorItemSystemTake {
  @property()
  @editor({description: 'Right hand slot entity. Auto-resolves if not set.'})
  rightHandSlotEntity: Entity | null = null;

  @property()
  @editor({description: 'Left hand slot entity. Auto-resolves if not set.'})
  leftHandSlotEntity: Entity | null = null;

  @property()
  @editor({description: 'Enable debug logging.'})
  debugLogEnabled: boolean = false;

  // Networked held item references — server writes, client reads
  @property({isNetworked: true})
  @editor({show: false})
  netRightHandItem: Entity | null = null;

  @property({isNetworked: true})
  @editor({show: false})
  netLeftHandItem: Entity | null = null;

  /** Successful takes since start; polled client-side for take popups. */
  @property({isNetworked: true})
  @editor({show: false})
  netTakeSucceededCount: number = 0;

  /** Loot name of the most recent successful take. */
  @property({isNetworked: true})
  @editor({show: false})
  netLastTakeLootName: string = '';

  private actorLogicComponent: ActorSdkLogicComponent | null = null;
  // Resolved slot entities (may differ from @property values on client)
  private resolvedRightSlot: Entity | null = null;
  private resolvedLeftSlot: Entity | null = null;
  // Server-side pickup state (physics preservation, grip offsets)
  private pickupItems: Map<PickupItemSlot, PickupItemState> = new Map();
  // ItemSystem takes by slot. A target carrying an `Interactable` take action
  // plus an `ItemContainer` is loot, not a hand prop: the server moves it into
  // the character's containers, so there is no hand entity to transform-copy
  // and no physics to preserve — the slot only tracks the take. The take
  // receipt is the authority on the outcome (no local count-diffing):
  // confirmations track, refusals clear. Holding-state reads tracked takes
  // as held so fetch behaviors still complete; dropping a take-tracked slot
  // deposits the take-receiving backpacks as world loot (depositTakeReceivers),
  // while clearItemSystemTake forgets the tracking without depositing. The
  // reported entity is the WORLD loot, not something carried: behaviors must
  // never transform-copy, move, or destroy it, and
  // UseItemBehavior.destroyItemAfterUse must stay off for loot takes (it
  // destroys whatever getItemData reports).
  private itemSystemTakes: Map<PickupItemSlot, TrackedTake> = new Map();
  /** Last refusal per slot, backing takeOutcome. Cleared like the warn latch. */
  private takeRefusals: Map<PickupItemSlot, RefusedTake> = new Map();
  /**
   * Take goods moved into the inventory but not yet deposited. Receipts set
   * it whenever they move anything — even for a superseded or cleared take
   * whose entry is already gone — so a refused re-take cannot strand earlier
   * goods: the next drop deposits while the flag stands, even with no slot
   * entry. Cleared by depositTakeReceivers. clearItemSystemTake deliberately
   * leaves it: forgetting tracking must not forgive the delivery debt.
   */
  private depositOwed = false;
  /**
   * Slots whose take-tracked drop raced an in-flight receipt, by the loot
   * the receipt will file for. dropItem deletes tracking at once, so a
   * receipt landing after the sweep would otherwise find no entry and its
   * goods would strand undeposited. recordTakeOutcome deposits when the
   * matching receipt files, then forgets the slot. Loot-tagged (not just
   * slot-keyed) so a superseding re-take's receipt does not inherit the
   * earlier drop's delivery. The name rides along because `name` throws once
   * the loot is destroyed and the receipt must still label its warnings.
   */
  private pendingDepositDrops: Map<PickupItemSlot, {loot: Entity; lootName: string}> = new Map();
  /** Where a take request goes; replaced in tests (a real take needs containers and a server). */
  public itemTakeSource: (character: Entity, target: Entity) => Promise<ItemResult> = (character, target) =>
    interact(character, target, 'take');
  /** Where a take-tracked drop deposits; replaced in tests (a real drop needs containers and a server). */
  public itemDropSink: (character: Entity, from: SlotRef, count: number) => unknown = (
    character,
    from,
    count,
  ) => requestDropItem(character, from, Math.floor(count));

  /**
   * Whether `slot` tracks an ItemSystem take. Its reported entity is world
   * loot, never a carried prop: consumers (UseItemBehavior) must not destroy,
   * move, or transform-copy it. With `entity`, requires the tracked take to be
   * FOR that entity, so a stale take of other loot never counts.
   */
  public isItemSystemTake(slot: PickupItemSlot, entity?: Entity | null): boolean {
    const tracked = this.itemSystemTakes.get(slot);
    // A nullish entity asks only whether the slot tracks a take at all (the
    // UseItem probe passes the reported held item, which is nullish exactly
    // when the take was consumed). A take whose receipt is still in flight
    // counts as tracked.
    return tracked != null && (entity == null || tracked.loot === entity);
  }

  /**
   * What the last take for `slot` did about `loot`: 'pending' while its
   * receipt is in flight, 'done' once the server confirms the whole take,
   * 'partial' when some items moved but the server refused the rest, the
   * `ItemRefusal` when the server refused it with nothing moved, or null when
   * no take went out for this loot (or a newer take superseded it). Behaviors
   * wait out 'pending', finish on 'done', drain more on 'partial', and give up
   * on a terminal refusal (`rejected`, `notAllowed`, `missing`) instead of
   * retrying forever.
   */
  public takeOutcome(slot: PickupItemSlot, loot: Entity): ItemSystemTakeOutcome {
    const tracked = this.itemSystemTakes.get(slot);
    if (tracked != null && tracked.loot === loot) {
      if (tracked.result == null) {
        return 'pending';
      }
      return tracked.result.complete ? 'done' : 'partial';
    }
    const refused = this.takeRefusals.get(slot);
    if (refused != null && refused.loot === loot) {
      return refused.reason;
    }
    return null;
  }

  /**
   * Files the server's answer to a take. A confirmation fills the pending
   * entry the synchronous checks left — whole or partial; 'partial' keeps the
   * leftovers drainable. A refusal with nothing moved deletes the entry — the
   * server is the authority — and remembers the reason for takeOutcome,
   * backing the slot off and warning once. Answers for a dropped or superseded
   * take are ignored.
   */
  private recordTakeOutcome(slot: PickupItemSlot, loot: Entity, result: ItemResult): void {
    // A drop that raced this receipt asked for delivery before the goods
    // moved: deposit on settle (the sweep is idempotent — calls that move
    // nothing destroy their spawned loot server-side). Runs before the
    // tracked-entry check below, which no-ops on the deleted entry. Falling
    // through to a re-tracked same-loot entry files the outcome there, but
    // the success edge and the deposit-debt count once per receipt, not once
    // per block.
    let deposited = false;
    let skippedAny = false;
    const deferred = this.pendingDepositDrops.get(slot);
    if (deferred != null && deferred.loot === loot) {
      this.pendingDepositDrops.delete(slot);
      if (result.complete && result.amount > 0) {
        this.netTakeSucceededCount += 1;
        this.netLastTakeLootName = deferred.lootName;
        console.log(
          `[ActorPickupItemComponent] take succeeded for '${deferred.lootName}' x${result.amount}.`,
        );
      }
      skippedAny = this.depositTakeReceivers();
      deposited = true;
    }
    const counted = deposited && result.complete && result.amount > 0;
    const tracked = this.itemSystemTakes.get(slot);
    if (tracked == null || tracked.loot !== loot) {
      // A superseded or cleared take whose receipt still moved goods: the
      // goods sit undelivered with no entry left to trigger the deposit, so
      // the flag carries the debt to the next drop instead of stranding —
      // unless the deferred branch above just deposited them.
      if (result.amount > 0 && !deposited) {
        this.depositOwed = true;
      }
      return;
    }
    if (result.complete || result.amount > 0) {
      tracked.result = result;
      if (result.amount > 0 && (!deposited || skippedAny)) {
        this.depositOwed = true;
      }
      // Take-success edge for client-side take popups (experiments overlays
      // poll the networked counters; the server receipt is the only place
      // that knows what moved). Skipped when the deferred branch above
      // already counted this receipt.
      if (result.complete && result.amount > 0 && !counted) {
        this.netTakeSucceededCount += 1;
        this.netLastTakeLootName = tracked.lootName;
        console.log(
          `[ActorPickupItemComponent] take succeeded for '${tracked.lootName}' x${result.amount}.`,
        );
      }
      this.warnedTakeRefusedSlots.delete(slot);
      this.takeRefusedAt.delete(slot);
      this.takeRefusals.delete(slot);
      if (result.complete) {
        this.takePartialAt.delete(slot);
      } else {
        // Partial: more takes will follow — pace them like refusals (see the
        // send gate) instead of re-sending every frame for loot that never
        // drains.
        this.takePartialAt.set(slot, {loot, at: WorldService.get().getWorldTime()});
      }
      if (this.debugLogEnabled) {
        console.log(
          `[ActorPickupItemComponent] Take confirmed in ${slot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
        );
      }
      return;
    }
    this.itemSystemTakes.delete(slot);
    this.takeRefusedAt.set(slot, WorldService.get().getWorldTime());
    this.takePartialAt.delete(slot);
    const reason = result.reason ?? 'unhandled';
    this.takeRefusals.set(slot, {loot, reason});
    // Permanent refusals (no room, no access) would otherwise warn on
    // every retry: say so once per slot until progress clears it.
    if (!this.warnedTakeRefusedSlots.has(slot)) {
      this.warnedTakeRefusedSlots.add(slot);
      console.warn(
        `[ActorPickupItemComponent] Take of '${tracked.lootName}' refused (${reason}); leaving the slot empty.`,
      );
    }
  }
  // Client-side: tracks which items we're transform-copying (built from networked refs)
  private clientPickupItems: Map<PickupItemSlot, PickupItemState> = new Map();
  private slotsResolved: boolean = false;
  /** The per-frame transform copy, ticking only while a hand prop is held (or a client waits for one to arrive). */
  private readonly heldTicker: FrameTickable = {onFrameTick: (): void => this.onUpdate()};
  private warnedNoTicker = false;

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Owner})
  onCreate(): void {
    this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
    this.tryResolveSlots();
    this.registerActorController();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    ActorFrameTicker.tryGet()?.stop(this.heldTicker);
    // Only restore physics and unregister on Owner (where pickupItems is populated)
    if (this.entity.isOwned()) {
      // Teardown is not a delivery: the take receivers go with the actor, so
      // settle the deposit debt before releasing the hand props.
      this.depositOwed = false;
      this.itemSystemTakes.clear();
      this.pendingDepositDrops.clear();
      for (const [slot] of this.pickupItems) {
        this.dropItem(new ActorRequestDropData(slot));
      }
      this.takeRefusals.clear();
      this.warnedTakeRefusedSlots.clear();
      this.takeRefusedAt.clear();
      this.takePartialAt.clear();
      this.unregisterActorController();
    }
  }

  /** A client joining after an item was picked up gets no change event for it, so it reads the held items once here. */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStartEverywhere(): void {
    this.onNetHeldItemsChanged();
  }

  /**
   * The copy follows a change of owner: a new owner counts only its own
   * pickups (the owner's map does not travel with ownership), and a machine
   * that is a client again copies the replicated props, though they have not
   * changed.
   */
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer(): void {
    if (!this.entity.isOwned()) {
      this.syncClientPickupState();
    }
    this.refreshHeldTick();
  }

  @subscribePropertyChange('netRightHandItem')
  private onNetRightHandItemChanged(): void {
    this.onNetHeldItemsChanged();
  }

  @subscribePropertyChange('netLeftHandItem')
  private onNetLeftHandItemChanged(): void {
    this.onNetHeldItemsChanged();
  }

  /** Client: picks up the replicated held items and starts or stops the copy. The owner tracks its own pickups. */
  private onNetHeldItemsChanged(): void {
    if (this.entity.isOwned()) {
      return;
    }
    this.syncClientPickupState();
    this.refreshHeldTick();
  }

  /**
   * Runs the per-frame copy while there is something to copy on this machine:
   * the owner's held hand props, or a client's replicated ones, including a
   * reference whose entity has not arrived yet, which the copy keeps
   * re-reading until it does. Each side reads only its own map, and
   * {@link onOwnershipTransfer} refreshes it when the owner changes. The copy
   * starts and stops with every pickup and drop, so it ticks from
   * `ActorFrameTicker` rather than its own subscription.
   */
  private refreshHeldTick(): void {
    const working = this.entity.isOwned()
      ? this.pickupItems.size > 0
      : this.clientPickupItems.size > 0 || this.awaitingClientItem();
    const ticker = ActorFrameTicker.tryGet();
    if (ticker == null) {
      // Services start before any component is created, so this happens only
      // once they have stopped, at teardown.
      if (working && !this.warnedNoTicker) {
        this.warnedNoTicker = true;
        console.warn(
          `[ActorPickupItemComponent] '${String(this.entity.name)}': ActorFrameTicker is not running, so a held prop does not follow the hand.`,
        );
      }
      return;
    }
    if (working) {
      ticker.start(this.heldTicker);
    } else {
      ticker.stop(this.heldTicker);
    }
  }

  private awaitingClientItem(): boolean {
    if (this.entity.isOwned()) {
      return false;
    }
    return (
      (this.netRightHandItem != null && !this.clientPickupItems.has(PickupItemSlot.RightHand)) ||
      (this.netLeftHandItem != null && !this.clientPickupItems.has(PickupItemSlot.LeftHand))
    );
  }

  /** One frame of the transform copy; runs only while {@link refreshHeldTick} keeps it ticking. */
  onUpdate(): void {
    // A client resolves its slots here: onCreate runs only on the owner, and
    // template children may not exist yet. The owner also resolves on demand
    // in pickupItem.
    if (!this.slotsResolved) {
      this.tryResolveSlots();
    }

    if (this.entity.isOwned()) {
      // Server: use authoritative pickupItems map
      this.updateSlotTransform(PickupItemSlot.RightHand, this.resolvedRightSlot, this.pickupItems);
      this.updateSlotTransform(PickupItemSlot.LeftHand, this.resolvedLeftSlot, this.pickupItems);
    } else {
      // Client: sync from networked entity refs, then do transform copy
      this.syncClientPickupState();
      this.updateSlotTransform(PickupItemSlot.RightHand, this.resolvedRightSlot, this.clientPickupItems);
      this.updateSlotTransform(PickupItemSlot.LeftHand, this.resolvedLeftSlot, this.clientPickupItems);
      // An awaited item that arrived, or one dropped before it did, may leave nothing to copy.
      this.refreshHeldTick();
    }
  }

  /**
   * Client-side: read networked entity refs and build local pickup state for transform copy.
   */
  private syncClientPickupState(): void {
    this.syncClientSlot(PickupItemSlot.RightHand, this.netRightHandItem);
    this.syncClientSlot(PickupItemSlot.LeftHand, this.netLeftHandItem);
  }

  private syncClientSlot(slot: PickupItemSlot, netItem: Entity | null): void {
    if (netItem && netItem.valid) {
      if (!this.clientPickupItems.has(slot)) {
        const state = new PickupItemState(netItem, slot);
        const gripPoints = netItem.findChildrenWithName('GripPoint', true);
        if (gripPoints.length > 0) {
          const gripTransform = gripPoints[0].getComponent(TransformComponent);
          if (gripTransform) {
            state.gripPositionOffset = gripTransform.localPosition.mul(-1);
            state.gripRotationOffset = gripTransform.localRotation.inverse();
          }
        }
        const physicsBody = netItem.getComponent(PhysicsBodyComponent);
        if (physicsBody) {
          state.originalCollisionEnabled = physicsBody.collisionEnabled;
          state.originalIsAffectedByGravity = physicsBody.isAffectedByGravity;
          physicsBody.collisionEnabled = false;
          physicsBody.isAffectedByGravity = false;
        }
        this.clientPickupItems.set(slot, state);
      }
    } else {
      const prevState = this.clientPickupItems.get(slot);
      if (prevState) {
        if (prevState.entity.valid) {
          const physicsBody = prevState.entity.getComponent(PhysicsBodyComponent);
          if (
            physicsBody &&
            prevState.originalCollisionEnabled !== null &&
            prevState.originalIsAffectedByGravity !== null
          ) {
            physicsBody.collisionEnabled = prevState.originalCollisionEnabled;
            physicsBody.isAffectedByGravity = prevState.originalIsAffectedByGravity;
          }
        }
        this.clientPickupItems.delete(slot);
      }
    }
  }

  private tryResolveSlots(): void {
    // Use @property values first (set in editor/template), then auto-resolve by name.
    // Write to private fields (not @property) so this works on both server and client.
    if (!this.resolvedRightSlot) {
      this.resolvedRightSlot = this.rightHandSlotEntity ?? this.findHandSlotEntity('RightHandSocket', 'RightHandSlot');
    }
    if (!this.resolvedLeftSlot) {
      this.resolvedLeftSlot = this.leftHandSlotEntity ?? this.findHandSlotEntity('LeftHandSocket', 'LeftHandSlot');
    }

    if (this.resolvedRightSlot || this.resolvedLeftSlot) {
      this.slotsResolved = true;
      if (this.debugLogEnabled) {
        console.log(
          `[ActorPickupItemComponent] Slots resolved: rightSlot=${String(!!this.resolvedRightSlot)} leftSlot=${String(!!this.resolvedLeftSlot)}`,
        );
      }
    }
  }

  private updateSlotTransform(
    slot: PickupItemSlot,
    slotEntity: Entity | null,
    items: Map<PickupItemSlot, PickupItemState>,
  ): void {
    if (!slotEntity || !slotEntity.valid) {
      return;
    }

    const itemState = items.get(slot);
    if (!itemState || !itemState.entity.valid) {
      return;
    }

    const slotTransform = slotEntity.getComponent(TransformComponent);
    const itemTransform = itemState.entity.getComponent(TransformComponent);

    if (!slotTransform || !itemTransform) {
      return;
    }

    const handRot = slotTransform.worldRotation;
    const finalRotation = handRot.mul(itemState.gripRotationOffset);
    const rotatedGripOffset = handRot.mulVec3(itemState.gripPositionOffset);
    const finalPosition = slotTransform.worldPosition.add(rotatedGripOffset);

    itemTransform.worldPosition = finalPosition;
    itemTransform.worldRotation = finalRotation;
  }

  // #region ActorPickupItemController

  pickupItem(data: ActorRequestPickupData): void {
    if (
      data.pickupItemSlot !== PickupItemSlot.RightHand &&
      data.pickupItemSlot !== PickupItemSlot.LeftHand
    ) {
      console.warn(`[ActorPickupItemComponent] Invalid pickup slot: ${data.pickupItemSlot}. Use PickupItemSlot.RightHand or LeftHand.`);
      return;
    }

    if (!data.pickupItemEntity) {
      console.warn('[ActorPickupItemComponent] pickupItem called with no entity.');
      return;
    }

    if (this.pickupItems.has(data.pickupItemSlot)) {
      if (this.debugLogEnabled) {
        console.log(`[ActorPickupItemComponent] Slot ${data.pickupItemSlot} already occupied`);
      }
      return;
    }
    const inFlightTake = this.itemSystemTakes.get(data.pickupItemSlot);
    // Only a live take whose receipt is still in flight blocks: its answer is
    // coming. Anything else falls through — the send path below overwrites
    // the entry when it actually sends. In particular a backed-off pass must
    // leave a settled entry in place: clearing it would read as nothing filed
    // and burn the behaviors' unresolved-slot bound.
    // Positive checks only: stub entities in tests carry no `valid` field.
    if (
      inFlightTake != null &&
      inFlightTake.result == null &&
      inFlightTake.loot.valid !== false &&
      !inFlightTake.loot.isDestroyed()
    ) {
      if (this.debugLogEnabled) {
        console.log(`[ActorPickupItemComponent] Slot ${data.pickupItemSlot} already taking`);
      }
      return;
    }

    // ItemSystem loot goes through the server: the character's containers take
    // it, with range and access re-validated there — no client-side range
    // gate, the receipt carries the server's own `outOfReach`. Anything else
    // is a hand prop carried below. The receipt settles the same frame on the
    // server and is the authority on what moved — no local count-diffing — so
    // a refused take leaves the slot empty for the behaviors' retry paths
    // instead of reporting a pickup that never happened. An actor with no
    // drainable container keeps the legacy hand-carry: takes route only
    // into storage receivers (priority > 0, equipMode None — the deposit
    // can only drain those), and the server places takes only into
    // autoPlaceOrder (priority > 0) — so an actor with none, or only
    // priority-0 or equipped containers, would otherwise lose the
    // hand-carry fallback for every loot.
    // The retry and pacing decisions below live here, with the send: this is
    // the seam's own request coherency (one take in flight per slot, answered
    // takes not re-sent hot), not a GAS eligibility gate — it duplicates no
    // ability cooldown, and no behavior can pace what only this entry sees.
    // The character is GAS-resolved, not assumed to be this entity: the
    // controller can sit on an ItemSystem child below the character root.
    // Deliver flows take note: a routed take drains the loot into the actor's
    // inventory (possibly destroying it), so a fetch→drop-off or fetch→use
    // over loot-shaped targets no longer has a physical item to deliver or
    // use — delivery runs through the deposit (dropItem on a take-tracked
    // slot sweeps the take-receiving backpacks into world loot), while
    // take-use handles are follow-up work: a consumed take has no item
    // handle to hand a use callback yet.
    // Ordered cheapest-first: the loot check is two component reads, while
    // the registry scan below runs only for loot that can take.
    const character = characterOf(this.entity) ?? this.entity;
    const isLoot = this.isItemSystemLoot(data.pickupItemEntity);
    const receivers = isLoot
      ? containerRegistry
          .all(character)
          .filter(
            container =>
              container.autoPlacePriority > 0 && container.equipMode === ContainerEquipMode.None,
          )
      : [];
    if (isLoot && receivers.length > 0) {
      // The server still places takes into equipped priority > 0 containers
      // (autoPlaceOrder ignores equipMode), where the deposit never drains
      // them — say so once per actor instead of stranding silently.
      if (
        !this.warnedEquippedTakeReceiver &&
        containerRegistry
          .all(character)
          .some(
            container =>
              container.autoPlacePriority > 0 && container.equipMode !== ContainerEquipMode.None,
          )
      ) {
        this.warnedEquippedTakeReceiver = true;
        console.warn(
          `[ActorPickupItemComponent] take-routed '${String(character.name)}' has an equipped container with autoPlacePriority > 0: takes landing there are never deposited; keep equipped containers at priority 0`,
        );
      }
      const loot = data.pickupItemEntity;
      const slot = data.pickupItemSlot;
      // A refused take stays refused until something changes: back the retry
      // off instead of sending a server request every frame. Keyed to the
      // refused loot, not the slot — other loot still sends immediately, so a
      // retired target never starves the next one.
      const now = WorldService.get().getWorldTime();
      const lastRefusal = this.takeRefusals.get(slot);
      const backedOff =
        lastRefusal != null &&
        lastRefusal.loot === loot &&
        (this.takeRefusedAt.get(slot) ?? Number.NEGATIVE_INFINITY) + TAKE_RETRY_COOLDOWN_SECONDS >
          now;
      // A partial take re-sends, but paced like a refusal: without this the
      // settled entry clears on send and a container that never drains
      // re-sends a server take every frame.
      const lastPartial = this.takePartialAt.get(slot);
      const partialBackedOff =
        lastPartial != null &&
        lastPartial.loot === loot &&
        lastPartial.at + TAKE_RETRY_COOLDOWN_SECONDS > now;
      if (backedOff || partialBackedOff) {
        return;
      }
      // Pending until the receipt files the outcome: the guard above treats
      // this as in flight, and holding-state reports it while live so the
      // behaviors' same-frame read-back still sees the loot. A new take
      // supersedes the slot's remembered refusal: without this, a later pass
      // would read the old refusal as the new take's answer. (The warn latch
      // stays until progress, so one refusal still warns once.) It also
      // supersedes a deferred deposit from a racing drop: the slot moved on,
      // and the new take's own drop sweeps whatever settles.
      this.takeRefusals.delete(slot);
      this.pendingDepositDrops.delete(slot);
      // The name is captured now, while the loot is live: `name` throws once
      // the take destroys it, so the entry and the rejection closure below
      // must never read it from the entity.
      const lootName = loot.name ?? '';
      // Overwriting a receipt that is still in flight orphans it: the guard
      // above only lets this through for destroyed loot, whose waiter is
      // gone — say so instead of replacing it silently. Moved goods still
      // deposit through the deposit-owed flag.
      const inFlight = this.itemSystemTakes.get(slot);
      if (inFlight != null && inFlight.result == null) {
        console.warn(
          `[ActorPickupItemComponent] superseding in-flight take of '${inFlight.lootName}' for '${lootName}'; the earlier receipt will not file against the slot`,
        );
      }
      this.itemSystemTakes.set(slot, {loot, lootName, result: null});
      console.log(
        `[ActorPickupItemComponent] '${String(character.name)}' take sent for '${lootName}' ` +
          `(${receivers.length} storage receiver(s)).`,
      );
      // The commands never reject, but the seam is a bare promise: a rejection
      // files as `unhandled` instead of stranding the slot in 'pending' (and
      // SearchAndPickup waiting on it) forever.
      void this.itemTakeSource(character, loot).then(
        result => this.recordTakeOutcome(slot, loot, result),
        error => {
          // The commands never reject in practice, so a rejection is a genuine
          // bug or exception in the take path — say so instead of silently
          // converting it. It still files as `unhandled` (retryable) so the
          // slot never strands in 'pending'.
          console.warn(
            `[ActorPickupItemComponent] Take of '${lootName}' threw; filing 'unhandled'.`,
            error,
          );
          this.recordTakeOutcome(slot, loot, ItemResult.refused('unhandled'));
        },
      );
      return;
    }

    // Template children may not exist at onCreate time, and nothing polls for
    // them while the hands are empty: resolve on demand.
    if (!this.slotsResolved) {
      this.tryResolveSlots();
    }
    const slotEntity =
      data.pickupItemSlot === PickupItemSlot.RightHand
        ? this.resolvedRightSlot
        : this.resolvedLeftSlot;
    if (!slotEntity) {
      console.warn(
        `[ActorPickupItemComponent] No slot entity for ${data.pickupItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}. Set rightHandSlotEntity/leftHandSlotEntity or add a child named RightHandSocket/LeftHandSocket.`,
      );
      return;
    }

    if (this.isItemSystemLoot(data.pickupItemEntity)) {
      const held = containerRegistry
        .all(character)
        .map(c => `${c.role}(p=${c.autoPlacePriority},mode=${c.equipMode})`)
        .join(' ');
      console.warn(
        `[ActorPickupItemComponent] '${String(character.name)}' hand-grabbing take-loot ` +
          `'${data.pickupItemEntity.name ?? ''}': no storage receiver (priority > 0, ` +
          `unequipped container) on the character, so the take cannot route. ` +
          `Registry holds: [${held}].`,
      );
    }
    const itemState = new PickupItemState(data.pickupItemEntity, data.pickupItemSlot);

    const gripPoints = data.pickupItemEntity.findChildrenWithName('GripPoint', true);
    if (gripPoints.length > 0) {
      const gripTransform = gripPoints[0].getComponent(TransformComponent);
      if (gripTransform) {
        itemState.gripPositionOffset = gripTransform.localPosition.mul(-1);
        itemState.gripRotationOffset = gripTransform.localRotation.inverse();
      }
    } else {
      console.warn(
        `[ActorPickupItemComponent] item '${data.pickupItemEntity.name ?? ''}' has no GripPoint child entity. It will be held at its origin. Add a child entity named "GripPoint" to control grip position/rotation.`,
      );
    }

    const physicsBody = data.pickupItemEntity.getComponent(PhysicsBodyComponent);
    if (physicsBody) {
      itemState.originalCollisionEnabled = physicsBody.collisionEnabled;
      itemState.originalIsAffectedByGravity = physicsBody.isAffectedByGravity;

      physicsBody.collisionEnabled = false;
      physicsBody.isAffectedByGravity = false;
    }

    // A hand prop replaces whatever take tracking the slot holds: a settled
    // take left over from an earlier pickup must not shadow the prop (its
    // entry would keep reporting the old loot and swallow the next drop).
    // A live in-flight take cannot reach here — it returns above. A
    // deferred deposit from a racing drop is cancelled too: the slot moved
    // on, and the full sweep heals stranded goods on the next delivery.
    this.itemSystemTakes.delete(data.pickupItemSlot);
    this.pendingDepositDrops.delete(data.pickupItemSlot);
    this.takeRefusals.delete(data.pickupItemSlot);
    this.takeRefusedAt.delete(data.pickupItemSlot);
    this.takePartialAt.delete(data.pickupItemSlot);

    this.pickupItems.set(data.pickupItemSlot, itemState);
    this.refreshHeldTick();

    // Sync to networked properties for client replication
    if (data.pickupItemSlot === PickupItemSlot.RightHand) {
      this.netRightHandItem = data.pickupItemEntity;
    } else {
      this.netLeftHandItem = data.pickupItemEntity;
    }

    if (this.debugLogEnabled) {
      console.log(
        `[ActorPickupItemComponent] Picked up item in ${data.pickupItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
      );
    }
  }

  /**
   * Forgets the take tracked on `slot` without depositing and without
   * touching hand props: no backpack sweep, no physics restore. Give-up,
   * refusal and pre-use paths use this — the goods stay in the inventory
   * and only the tracking (plus refusal/progress state, like dropItem
   * clears) is forgotten. Abandon is total: a pending deferred deposit for
   * the slot is cancelled too (the full sweep heals stranded goods on the
   * next delivery). Delivery paths use dropItem, which deposits the
   * take-receiving backpacks as world loot. Returns whether a take was
   * tracked.
   */
  public clearItemSystemTake(slot: PickupItemSlot): boolean {
    if (slot !== PickupItemSlot.RightHand && slot !== PickupItemSlot.LeftHand) {
      return false;
    }
    this.warnedTakeRefusedSlots.delete(slot);
    this.takeRefusedAt.delete(slot);
    this.takePartialAt.delete(slot);
    this.takeRefusals.delete(slot);
    this.pendingDepositDrops.delete(slot);
    return this.itemSystemTakes.delete(slot);
  }

  dropItem(data: ActorRequestDropData): void {
    if (
      data.dropItemSlot !== PickupItemSlot.RightHand &&
      data.dropItemSlot !== PickupItemSlot.LeftHand
    ) {
      return;
    }
    this.warnedTakeRefusedSlots.delete(data.dropItemSlot);
    this.takeRefusedAt.delete(data.dropItemSlot);
    this.takePartialAt.delete(data.dropItemSlot);
    this.takeRefusals.delete(data.dropItemSlot);

    // An ItemSystem take leaves nothing in the hand: the loot is in the
    // character's containers (or the take was refused server-side). Dropping
    // a take-tracked slot deposits those containers' contents as world loot
    // at the actor (see depositTakeReceivers): takes have no other sink, so
    // without this a looped collector saturates into `noRoom` and stalls.
    // The deposit is owed by the goods, not the entry: a refused re-take
    // deletes the slot's entry while earlier goods sit undelivered, so the
    // depositOwed flag triggers it too — any drop settles the debt.
    //
    // No early return: a hand prop picked up into a slot with leftover take
    // tracking shares it, and still needs its release (and physics restore)
    // below.
    const tracked = this.itemSystemTakes.get(data.dropItemSlot);
    this.itemSystemTakes.delete(data.dropItemSlot);
    if (tracked != null || this.depositOwed) {
      if (tracked != null && tracked.result == null) {
        // The receipt is still in flight: sweeping now would miss goods the
        // server is about to move, so the deposit waits for the receipt
        // (see pendingDepositDrops). The slot still reads clear below.
        this.pendingDepositDrops.set(data.dropItemSlot, {
          loot: tracked.loot,
          lootName: tracked.lootName,
        });
      } else {
        this.depositTakeReceivers();
      }
      if (tracked != null && this.debugLogEnabled) {
        console.log(
          `[ActorPickupItemComponent] Cleared ItemSystem take from ${data.dropItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
        );
      }
    }

    const itemState = this.pickupItems.get(data.dropItemSlot);
    if (!itemState) {
      return;
    }

    if (itemState.entity.valid) {
      const physicsBody = itemState.entity.getComponent(PhysicsBodyComponent);
      if (
        physicsBody &&
        itemState.originalCollisionEnabled !== null &&
        itemState.originalIsAffectedByGravity !== null
      ) {
        physicsBody.collisionEnabled = itemState.originalCollisionEnabled;
        physicsBody.isAffectedByGravity = itemState.originalIsAffectedByGravity;
      }
    }

    this.pickupItems.delete(data.dropItemSlot);
    this.refreshHeldTick();

    // Clear networked reference
    if (data.dropItemSlot === PickupItemSlot.RightHand) {
      this.netRightHandItem = null;
    } else {
      this.netLeftHandItem = null;
    }

    if (this.debugLogEnabled) {
      console.log(
        `[ActorPickupItemComponent] Dropped item from ${data.dropItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
      );
    }
  }

  /**
   * Deposits everything in the character's take-receiving storage as world
   * loot at the actor's feet. Sweeps the storage containers takes can land
   * in (`autoPlacePriority` > 0 with `equipMode` None), so a take that
   * overflowed past the backpack into another receiver is still delivered
   * instead of stranded — while an equipped hotbar or armour container is
   * never looted even at default priority. Take-flow actors keep equipped
   * containers at priority 0, so takes cannot land where the deposit will
   * not deliver them. Receivers sharing a role (or an empty role) are
   * skipped with a warning: SlotRefs address containers by role, so only
   * one container per role can deposit. The drop handler spawns one `DroppedItem` loot
   * per call in front of the character and moves the stack into it; calls
   * that move nothing destroy their spawned loot server-side, so this is
   * safe to run even when a slot just drained. A rejected or refused drop
   * warns instead of vanishing: the take source already files rejections as
   * `unhandled`, and the deposit owes the same visibility.
   *
   * Per-actor, not per-slot, by design: takes carry no container identity in
   * their receipts, so a slot's share of a shared backpack cannot be told
   * apart — a drop delivers the whole take-receiving inventory as the one
   * pile the behaviors walk to. A co-tracked slot keeps reporting held until
   * its own run drops (a no-op sweep) or clears; the goods are already
   * delivered, so the window only ever ends at the drop-off.
   *
   * Returns whether any receiver was skipped: skipped goods stay owed, so
   * the caller keeps the deposit debt instead of clearing it.
   */
  private depositTakeReceivers(): boolean {
    const character = characterOf(this.entity) ?? this.entity;
    // Snapshot the sweep first, then issue the drops: a sink that removes or
    // compacts stacks synchronously would otherwise shift live indices under
    // the loop and skip stacks. Stale counts are safe — a drop that moves
    // nothing destroys its spawned loot server-side.
    const sweep: Array<{role: string; index: number; count: number}> = [];
    // Receivers the deposit can drain: storage containers takes can land in.
    const receivers = containerRegistry.all(character).filter(
      container =>
        container.autoPlacePriority > 0 && container.equipMode === ContainerEquipMode.None,
    );
    // SlotRefs address containers by role, and the server resolves each role
    // to its first container — so an empty role, or one shared with any
    // other container (even an equipped or non-receiver one), would drop
    // from the wrong container (or twice). Skip those receivers with a
    // warning instead of corrupting: roles must be unique on take-flow
    // actors. Skipped receivers keep the deposit owed for the next drop.
    const roleCounts = new Map<string, number>();
    for (const container of containerRegistry.all(character)) {
      roleCounts.set(container.role, (roleCounts.get(container.role) ?? 0) + 1);
    }
    let skipped = false;
    for (const container of receivers) {
      if (container.role === '' || (roleCounts.get(container.role) ?? 0) > 1) {
        skipped = true;
        if (!this.warnedAmbiguousDepositRoles) {
          this.warnedAmbiguousDepositRoles = true;
          console.warn(
            `[ActorPickupItemComponent] skipping deposit for role '${container.role}': take-receiving container roles must be unique (the server resolves each role to one container)`,
          );
        }
        continue;
      }
      for (let index = 0; index < container.slotCount; index++) {
        const stack = container.getSlot(index);
        if (stack == null || !(stack.count >= 1)) {
          continue;
        }
        sweep.push({role: container.role, index, count: stack.count});
      }
    }
    for (const {role, index, count} of sweep) {
      // A bare promise observes nothing until awaited: attach here so a
      // rejected drop warns instead of vanishing with the tracking already
      // deleted. Called directly (not via Promise.resolve) so synchronous
      // rejections stay synchronous.
      const outcome = this.itemDropSink(character, containerSlot(role, index), count);
      if (
        outcome != null &&
        typeof (outcome as PromiseLike<unknown>).then === 'function'
      ) {
        // Two-arg then (not .catch): the sink may return a bare thenable
        // without a .catch method. The identity fulfillment keeps the
        // rejection handler without passing `undefined` as an argument.
        // A refused (not just rejected) drop warns too: the commands
        // resolve refusals instead of rejecting, so rejection alone would
        // leave refused deposits silent.
        (outcome as PromiseLike<unknown>).then(
          value => {
            const refusal = value instanceof ItemResult ? value.refusal : '';
            if (refusal !== '') {
              console.warn(
                `[ActorPickupItemComponent] deposit drop refused for ${role}[${index}] x${count}: ${refusal}`,
              );
            }
            return value;
          },
          (error: unknown) => {
            console.warn(
              `[ActorPickupItemComponent] deposit drop failed for ${role}[${index}] x${count}: ${String(error)}`,
            );
          },
        );
      }
    }
    if (!skipped) {
      this.depositOwed = false;
    }
    return skipped;
  }

  getItemData(): ActorPickupItemData {
    const itemData = new ActorPickupItemData();

    for (const [slot, itemState] of this.pickupItems) {
      itemData.setPickupItem(slot, itemState.entity);
    }
    // Takes report only while their loot is still a live world entity — a
    // pending take reads as held so the behaviors' same-frame read-back still
    // sees the loot. A consumed take stays TRACKED (isItemSystemTake) so
    // completion flows that key off the tracking keep working, but it is
    // never REPORTED as held: no consumer ever receives a destroyed entity
    // from here.
    for (const [slot, take] of this.itemSystemTakes) {
      const target = take.loot;
      if (target.valid !== false && !target.isDestroyed()) {
        itemData.setPickupItem(slot, target);
      }
    }

    return itemData;
  }

  /** Slots already warned for a refused take; progress (a tracked take, a drop, teardown) clears them. */
  private warnedTakeRefusedSlots = new Set<PickupItemSlot>();

  /** Fired once per actor: takes can strand in its equipped priority > 0 container, which the deposit never drains. */
  private warnedEquippedTakeReceiver = false;

  /** Fired once per actor: a take-receiving container role the deposit had to skip as empty or shared. */
  private warnedAmbiguousDepositRoles = false;

  /** World time (s) of the last server refusal per slot, for retry backoff. Cleared like the warn latch. */
  private takeRefusedAt = new Map<PickupItemSlot, number>();

  /** Last partial receipt per slot and its world time (s), for pacing re-takes. Cleared with the refusal state. */
  private takePartialAt = new Map<PickupItemSlot, {loot: Entity; at: number}>();

  /**
   * Loot, not a hand prop: an entity offering the `take` interaction backed by
   * a container. Both halves are required: a `take` action with no container
   * (or a container with no take action) falls through to the legacy path.
   */
  private isItemSystemLoot(target: Entity): boolean {    const interactable = target.getComponent(Interactable);
    return (
      interactable != null &&
      interactable.action === 'take' &&
      target.getComponent(ItemContainer) != null
    );
  }

  // #endregion

  // #region ActorController

  registerActorController(): void {
    if (this.actorLogicComponent) {
      this.actorLogicComponent.registerController(ActorPickupItemControllerTypeId, this);
    }
  }

  unregisterActorController(): void {
    if (this.actorLogicComponent) {
      this.actorLogicComponent.unregisterController(this);
    }
  }

  // #endregion

  // #region Private

  private findHandSlotEntity(...names: string[]): Entity | null {
    for (const name of names) {
      const matches = this.entity.findChildrenWithName(name, true);
      if (matches.length > 0) {
        if (this.debugLogEnabled) {
          console.log(`[ActorPickupItemComponent] Auto-resolved slot via findChildrenWithName: "${name}"`);
        }
        return matches[0];
      }
    }

    if (this.debugLogEnabled) {
      console.warn(
        `[ActorPickupItemComponent] Could not auto-resolve slot entity for names: ${names.join(', ')}`,
      );
    }
    return null;
  }

  // #endregion
}
