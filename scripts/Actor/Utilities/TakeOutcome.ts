/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import type {Entity, PickupItemSlot} from 'meta/worlds';
import {
  answersTakeOutcome,
  clearsItemSystemTakes,
  tracksItemSystemTakes,
  type ItemSystemTakeOutcome,
} from '../Controllers/Definitions/IActorItemSystemTake';

/**
 * What `ActorPickupItemComponent.takeOutcome` answers for one loot entity
 * ({@link ItemSystemTakeOutcome}): the refusals are ItemSystem's `ItemRefusal`
 * set, the one the server's handlers return, so a refusal ItemSystem adds
 * reaches this type with it. `isTerminalTakeRefusal` below is the one place
 * that lists the terminal set.
 */
export type TakeOutcome = ItemSystemTakeOutcome;

/**
 * Whether a take outcome is terminal: retrying the same take cannot succeed,
 * so the fetch flow should give up on the loot instead of retrying it.
 * - `rejected`: the destination's tags refuse the item.
 * - `notAllowed`: the target refuses this character outright.
 * - `missing`: what the take acts on is gone — or a live container that is
 *   merely empty right now (the server answers 'missing' for zero items, so
 *   refillable containers read as missing too). Terminal for the run, but NOT
 *   remembered across runs: see `rememberRefusedLoot`.
 * - `invalid`: the request asks for something that cannot be done.
 *
 * Every other outcome — 'pending', 'done', 'partial', `outOfReach`, `noRoom`,
 * `unhandled`, `lost`, or null (no take) — stays retryable: closer, freer,
 * or later can change it. Shared by the fetch behaviors so the give-up set
 * cannot drift apart between them.
 */
export function isTerminalTakeRefusal(outcome: TakeOutcome): boolean {
  return (
    outcome === 'rejected' ||
    outcome === 'notAllowed' ||
    outcome === 'missing' ||
    outcome === 'invalid'
  );
}

/**
 * The controller's take outcome for one loot entity, feature-detected: only
 * `ActorPickupItemComponent` answers the query; a controller that only tracks
 * takes maps that probe onto it (a tracked take of destroyed loot reads as
 * 'done').
 */
export function readTakeOutcome(
  controller: unknown,
  slot: PickupItemSlot,
  loot: Entity,
): TakeOutcome {
  if (answersTakeOutcome(controller)) {
    return controller.takeOutcome(slot, loot);
  }
  const trackedTakeSucceeded =
    tracksItemSystemTakes(controller) &&
    controller.isItemSystemTake(slot, loot) &&
    (loot.valid === false || loot.isDestroyed());
  return trackedTakeSucceeded ? 'done' : null;
}

/**
 * Whether the controller tracks a take for this slot (and loot, when given).
 * Feature-detected: prefers the controller's own tracking when it has it — a
 * filed refusal is NOT a tracked take (its entry is gone), even though
 * `takeOutcome` still reports it — and otherwise accepts only a live outcome.
 */
export function isTakeTracked(
  controller: unknown,
  slot: PickupItemSlot,
  entity?: Entity | null,
): boolean {
  if (tracksItemSystemTakes(controller)) {
    return controller.isItemSystemTake(slot, entity ?? null);
  }
  if (entity != null && answersTakeOutcome(controller)) {
    const outcome = controller.takeOutcome(slot, entity);
    return outcome === 'pending' || outcome === 'done' || outcome === 'partial';
  }
  return false;
}

/**
 * Forgets the take tracked on `slot` without depositing or releasing — the
 * give-up, refusal and pre-use path. Feature-detected like the probes above:
 * only `ActorPickupItemComponent` answers it (anything else returns false),
 * so the SDK-owned controller interface needs no new method. Delivery paths
 * use `dropItem` instead, which deposits the take-receiving backpacks.
 */
export function clearTakeTracking(controller: unknown, slot: PickupItemSlot): boolean {
  return clearsItemSystemTakes(controller) && controller.clearItemSystemTake(slot);
}

/**
 * Counts filed take-refusal answers, not frames: the controller keeps one
 * filed refusal until a new take goes out, so re-reading the same refusal —
 * every frame in `SimpleFetchBehavior.update`, or after a backed-off send in
 * `SearchAndPickupBehavior` — must not advance the bound. The count advances
 * only when the outcome for this loot changes; any other observation (a fresh
 * take going pending, progress, nothing filed) breaks the identity without
 * losing the cumulative count, so the next identical refusal counts as the new
 * answer it is.
 */
export class TakeRefusalCounter {
  private target: Entity | null = null;
  private lastOutcome: TakeOutcome = null;
  private attempts: number = 0;

  count(target: Entity, outcome: TakeOutcome): number {
    if (this.target !== target) {
      this.target = target;
      this.lastOutcome = outcome;
      this.attempts = 1;
      return this.attempts;
    }
    if (this.lastOutcome !== outcome) {
      this.lastOutcome = outcome;
      this.attempts += 1;
    }
    return this.attempts;
  }

  noteNonRefusal(): void {
    this.lastOutcome = null;
  }

  reset(): void {
    this.target = null;
    this.lastOutcome = null;
    this.attempts = 0;
  }
}
