/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import type {Entity, PickupItemSlot} from 'meta/worlds';
import type {ItemRefusal} from '../../../ItemSystem/container/ItemRequest';

/**
 * Where an ItemSystem take of one loot entity stands: 'pending' while its
 * receipt is in flight, 'done' or 'partial' once the receipt files, the
 * server's `ItemRefusal` when it refused the take, and null when no take of
 * that loot is tracked. The refusals are ItemSystem's own set, so a refusal
 * ItemSystem adds reaches this type with it.
 */
export type ItemSystemTakeOutcome = 'pending' | 'done' | 'partial' | ItemRefusal | null;

/**
 * Optional extension for a pickup controller that routes ItemSystem loot
 * through takes (`ActorPickupItemComponent`). The SDK's
 * `ActorPickupItemController` cannot carry these queries, so callers
 * feature-detect each method with the guards below, as `StaggerBehavior`
 * detects `IActorLastAttackerProvider`. A slot that tracks a take reports
 * WORLD loot as its item: never destroy, move or transform-copy it.
 */
export interface IActorItemSystemTake {
  /** Whether `slot` tracks a take; with `entity`, a take of that entity. */
  isItemSystemTake(slot: PickupItemSlot, entity?: Entity | null): boolean;
  /** Where the take of `loot` in `slot` stands. */
  takeOutcome(slot: PickupItemSlot, loot: Entity): ItemSystemTakeOutcome;
  /** Forgets the take tracked on `slot` without depositing anything; true when one was tracked. */
  clearItemSystemTake(slot: PickupItemSlot): boolean;
}

/** Whether `controller` answers {@link IActorItemSystemTake.isItemSystemTake}. */
export function tracksItemSystemTakes(controller: unknown): controller is Pick<IActorItemSystemTake, 'isItemSystemTake'> {
  return (
    typeof controller === 'object' &&
    controller !== null &&
    'isItemSystemTake' in controller &&
    typeof controller.isItemSystemTake === 'function'
  );
}

/** Whether `controller` answers {@link IActorItemSystemTake.takeOutcome}. */
export function answersTakeOutcome(controller: unknown): controller is Pick<IActorItemSystemTake, 'takeOutcome'> {
  return (
    typeof controller === 'object' &&
    controller !== null &&
    'takeOutcome' in controller &&
    typeof controller.takeOutcome === 'function'
  );
}

/** Whether `controller` answers {@link IActorItemSystemTake.clearItemSystemTake}. */
export function clearsItemSystemTakes(controller: unknown): controller is Pick<IActorItemSystemTake, 'clearItemSystemTake'> {
  return (
    typeof controller === 'object' &&
    controller !== null &&
    'clearItemSystemTake' in controller &&
    typeof controller.clearItemSystemTake === 'function'
  );
}
