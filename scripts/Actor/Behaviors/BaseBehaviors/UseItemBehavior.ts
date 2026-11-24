/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v33

import {
  TransformComponent,
  type Entity,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import {isTakeTracked, clearTakeTracking} from '../../Utilities/TakeOutcome';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';

export type UseItemCallback = (
  actorEntity: Entity,
  targetEntity: Entity,
  itemEntity: Entity,
  slot: PickupItemSlot,
) => void;

/**
 * UseItemBehavior - Makes an actor walk to a target entity and use a held item on it.
 *
 * When the actor reaches the target (within useRange), invokes the onUseItem
 * callback with the actor, target, and item entities. Game scripts provide
 * this callback to implement the "use" logic (open door, consume potion,
 * activate lever, etc.).
 *
 * After use, optionally drops or destroys the held item and/or target.
 *
 * Uses GotoBehavior internally for locomotion.
 */
export class UseItemBehavior extends ActorBehavior {
  override name: string = 'UseItemBehavior';

  targetEntity: Entity | null = null;
  useSlot: PickupItemSlot = PickupItemSlot.RightHand;
  useRange: number = 2.0;
  moveSpeed: number = 5.0;
  dropAfterUse: boolean = true;
  destroyItemAfterUse: boolean = false;
  destroyTargetAfterUse: boolean = false;
  onUseItem: UseItemCallback | null = null;

  /**
   * Seconds to stay dormant before doing anything, matching
   * `SimpleFetchBehavior` and `SearchAndPickupBehavior`.
   *
   * This is what lets a fetch and a use be sequenced on ONE actor. `executeUse`
   * gives up the moment it finds an empty slot, so without a delay the use
   * fires before any pickup starter has run and finishes immediately —
   * `UseItemBehavior: no item held in slot`. Set it longer than the fetching
   * starter's own `startDelay` plus the time that fetch needs.
   */
  startDelay: number = 0;

  private currentGotoBehavior: GotoBehavior | null = null;
  private actorTransform: TransformComponent | null = null;
  private pendingUse: boolean = false;
  private started: boolean = false;
  private elapsedTime: number = 0;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);

    this.currentGotoBehavior = new GotoBehavior();
    this.currentGotoBehavior.desiredSpeed = this.moveSpeed;
    this.currentGotoBehavior.basePriority = this.basePriority;
    // Preserve prior behavior: UseItem does not control body direction, so keep
    // the nested goto from claiming the body-direction controller.
    this.currentGotoBehavior.shouldFaceDirection = false;

    const actorPos = this.actorTransform?.worldPosition;
    if (this.targetEntity) {
      const targetTransform = this.targetEntity.getComponent(TransformComponent);
      if (targetTransform) {
        this.currentGotoBehavior.targetPosition = targetTransform.worldPosition;
      } else if (actorPos) {
        this.currentGotoBehavior.targetPosition = actorPos;
      }
    } else if (actorPos) {
      this.currentGotoBehavior.targetPosition = actorPos;
    }

    if (this.behaviorManager) {
      void this.currentGotoBehavior.initialize(this.behaviorManager);
    }
  }

  /**
   * Dormant until `startDelay` elapses. Gated on the delay being set rather
   * than on `started` alone, so the default 0 keeps the previous first-frame
   * behaviour exactly.
   */
  private isWaitingToStart(): boolean {
    return !this.started && this.startDelay > 0;
  }

  override update(deltaTime: number): void {
    if (!this.started) {
      this.elapsedTime += deltaTime;
      if (this.elapsedTime < this.startDelay) {
        return;
      }
      this.started = true;
    }

    if (!this.currentGotoBehavior || !this.targetEntity || !this.actorTransform) {
      return;
    }

    if (this.targetEntity.isDestroyed()) {
      this.isFinished = true;
      return;
    }

    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      console.warn('UseItemBehavior: target entity has no TransformComponent — finishing behavior.');
      this.isFinished = true;
      return;
    }

    this.currentGotoBehavior.targetPosition = targetTransform.worldPosition;

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ <= this.useRange) {
      this.pendingUse = true;
    } else {
      this.pendingUse = false;
      void this.currentGotoBehavior.update(deltaTime);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    // Claiming NOTHING while dormant is the point: a fetch sharing this actor
    // needs the movement controller during the delay, and taking it here would
    // walk the actor to the target before it has the item.
    if (!this.targetEntity || this.isFinished || this.isWaitingToStart()) {
      return -1;
    }

    if (controllerType === ActorPickupItemControllerTypeId) {
      return this.pendingUse ? this.basePriority : -1;
    }

    if (this.currentGotoBehavior && !this.pendingUse) {
      return this.currentGotoBehavior.getControllerUsePriority(controllerType);
    }

    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId) {
      if (this.pendingUse) {
        this.executeUse(controller as ActorPickupItemController);
      }
      return;
    }

    if (this.currentGotoBehavior && !this.pendingUse) {
      this.currentGotoBehavior.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    this.currentGotoBehavior?.onRemove();
    this.currentGotoBehavior = null;
    this.targetEntity = null;
    this.onUseItem = null;
    super.onRemove();
  }

  private executeUse(pickupController: ActorPickupItemController): void {
    const itemData = pickupController.getItemData();
    const heldItem = itemData.getPickupItem(this.useSlot);

    // A take-tracked slot reports WORLD loot, never a carried prop — and a
    // consumed take reports nothing at all. Forget the tracking (even when
    // nothing is reported), use a surviving take whether or not anyone
    // listens, and never destroy either. clearTakeTracking deposits nothing:
    // using loot must not empty the backpack — only a real drop-off (dropItem)
    // does that. Checked before the empty-slot guard below, which would
    // otherwise skip the clear for a consumed take and leave it tracked
    // forever.
    const takeTracked = isTakeTracked(pickupController, this.useSlot, heldItem ?? null);
    if (takeTracked) {
      clearTakeTracking(pickupController, this.useSlot);
      if (
        heldItem != null &&
        heldItem.valid !== false &&
        !heldItem.isDestroyed() &&
        this.targetEntity != null
      ) {
        this.onUseItem?.(this.getEntity(), this.targetEntity, heldItem, this.useSlot);
      } else {
        // Nothing was used — a consumed take reports nothing, or there is no
        // target to use it on. A take-consumed loot has no world entity (and
        // no inventory-item handle yet) to hand the callback, so fetch→use
        // over takes ends here: handing take-loot to a use callback is
        // follow-up work. Finish without reaching the
        // shared destroy-target tail below, which a use that never happened
        // must not trigger.
        console.warn(
          'UseItemBehavior: take-consumed loot cannot be used yet (no item handle to pass onUseItem) — finishing behavior.',
        );
        this.isFinished = true;
        return;
      }
    } else {
      if (!heldItem || !this.targetEntity) {
        console.warn('UseItemBehavior: no item held in slot — finishing behavior.');
        this.isFinished = true;
        return;
      }

      if (this.onUseItem) {
        this.onUseItem(this.getEntity(), this.targetEntity, heldItem, this.useSlot);
      }

      if (heldItem.valid && !heldItem.isDestroyed()) {
        if (this.destroyItemAfterUse) {
          pickupController.dropItem(new ActorRequestDropData(this.useSlot));
          heldItem.destroy();
        } else if (this.dropAfterUse) {
          pickupController.dropItem(new ActorRequestDropData(this.useSlot));
        }
      }
    }

    if (
      this.destroyTargetAfterUse &&
      this.targetEntity != null &&
      this.targetEntity.valid &&
      !this.targetEntity.isDestroyed()
    ) {
      this.targetEntity.destroy();
    }

    this.isFinished = true;
  }
}
