/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v4

import {NetworkMode, TemplateAsset, TransformComponent, WorldService, type Entity, type Vec3} from 'meta/worlds';
import {itemRegistry, type StatLimit} from '../items/ItemDefinition';
import {getStat, type ItemStack} from '../items/ItemStack';
import type {SlotMove} from './SlotOps';
import {accessAllowed, ContainerAccessMode, containerRegistry, ItemContainer} from './ItemContainer';
import {
  findItemRequestHandler,
  ItemResult,
  registerItemRequestHandler,
  type ItemRequest,
  type ItemRequestContext,
} from './ItemRequest';

/**
 * Everything the server does to containers on a character's behalf. Every
 * caller goes through `ItemCommands`: a player's request arrives through
 * `ItemRequestServer`, an NPC's runs here directly on the server. Each handler
 * re-validates the request against server state and returns what it did.
 */

/**
 * Server only. Runs `request` as `character`, against the containers
 * registered to that character, and resolves with what it did. The handler
 * runs before this returns; only a handler that has to wait (a drop) resolves
 * later. Never rejects: an unknown kind or a handler that throws resolves
 * `unhandled`.
 */
export function runItemRequest(character: Entity, request: ItemRequest): Promise<ItemResult> {
  const handler = findItemRequestHandler(request.kind);
  if (handler == null) {
    console.warn(`[RequestHandlers] no handler for request '${request.kind}'.`);
    return Promise.resolve(ItemResult.refused('unhandled'));
  }
  const containers = containerRegistry.all(character);
  let outcome: ItemResult | Promise<ItemResult>;
  try {
    outcome = handler({
      character,
      request,
      containers,
      containerFor: role => containers.find(container => container.role === role) ?? null,
      findStack: uid => {
        for (const container of containers) {
          const index = container.findUid(uid);
          const stack = container.getSlot(index);
          if (stack != null) {
            return {container, index, stack};
          }
        }
        return null;
      },
    });
  } catch (error: unknown) {
    return Promise.resolve(handlerFailed(request, error));
  }
  return Promise.resolve(outcome).catch((error: unknown) => handlerFailed(request, error));
}

function handlerFailed(request: ItemRequest, error: unknown): ItemResult {
  console.error(`[RequestHandlers] the '${request.kind}' handler failed.`, error);
  return ItemResult.refused('unhandled');
}

/** Whether `index` names a slot of `container`. */
function isSlotOf(container: ItemContainer, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < container.slotCount;
}

/**
 * Why `stack` did not (all) go into `destinations`: none of them accepts it
 * (`rejected`), or those that do have no room (`noRoom`). With no destination
 * at all there is simply no room.
 */
export function placementRefusal(
  stack: ItemStack,
  destinations: readonly {accepts(stack: ItemStack, slotIndex: number): boolean}[],
): 'rejected' | 'noRoom' {
  return destinations.length > 0 && !destinations.some(destination => destination.accepts(stack, -1)) ? 'rejected' : 'noRoom';
}

/** Moves up to `move.count` of one slot into one chosen slot (`ItemContainer.transfer`), and says how far it got. */
function transferBetween(move: SlotMove<ItemContainer>): ItemResult {
  const {from, fromIndex, to, toIndex, count} = move;
  const stack = from.getSlot(fromIndex);
  if (stack == null) {
    return ItemResult.refused('missing');
  }
  if (!(count >= 1) || !isSlotOf(to, toIndex) || (from === to && fromIndex === toIndex)) {
    return ItemResult.refused('invalid');
  }
  const wanted = Math.min(Math.floor(count), stack.count);
  const moved = ItemContainer.transfer(move);
  return moved >= wanted ? ItemResult.done(moved) : ItemResult.refused(placementRefusal(stack, [to]), moved);
}

// ---------------------------------------------------------------------------
// Own containers: move, swap, drop
// ---------------------------------------------------------------------------

/** Loot spawned for a dropped stack: an ItemContainer (1 slot), an Interactable and a LootVisual. */
const DROPPED_ITEM_TEMPLATE = new TemplateAsset('@Templates/ItemSystem/DroppedItem.hstf');

/** Meters in front of the character where dropped items appear. */
const DROP_DISTANCE = 1;

function move({request, containerFor}: ItemRequestContext): ItemResult {
  const [from, to] = request.slots;
  const source = from != null ? containerFor(from.role) : null;
  const target = to != null ? containerFor(to.role) : null;
  if (source == null || target == null) {
    return ItemResult.refused('missing');
  }
  return transferBetween({from: source, fromIndex: from.index, to: target, toIndex: to.index, count: request.amount});
}

/** `amount` 1 when the two slots were exchanged. */
function swap({request, containerFor}: ItemRequestContext): ItemResult {
  const [a, b] = request.slots;
  const first = a != null ? containerFor(a.role) : null;
  const second = b != null ? containerFor(b.role) : null;
  if (first == null || second == null) {
    return ItemResult.refused('missing');
  }
  if (!isSlotOf(first, a.index) || !isSlotOf(second, b.index) || (first === second && a.index === b.index)) {
    return ItemResult.refused('invalid');
  }
  if (first.getSlot(a.index) == null && second.getSlot(b.index) == null) {
    return ItemResult.refused('missing');
  }
  return ItemContainer.swap(first, a.index, second, b.index) ? ItemResult.done(1) : ItemResult.refused('rejected');
}

/** Spawns loot in front of the owner and moves up to `amount` of the slot into it, found again by uid after the async spawn. */
function drop({request, containerFor, character}: ItemRequestContext): ItemResult | Promise<ItemResult> {
  const from = request.slots[0];
  const source = from != null ? containerFor(from.role) : null;
  const stack = source?.getSlot(from.index) ?? null;
  if (source == null || stack == null) {
    return ItemResult.refused('missing');
  }
  if (!(request.amount >= 1)) {
    return ItemResult.refused('invalid');
  }
  const uid = stack.uid;
  return WorldService.get()
    .spawnTemplate({
      templateAsset: DROPPED_ITEM_TEMPLATE,
      networkMode: NetworkMode.Networked,
      position: dropPosition(character.getComponent(TransformComponent), DROP_DISTANCE),
      rotation: null,
      scale: null,
    })
    .then(loot => {
      const lootContainer = loot.getComponent(ItemContainer);
      const index = source.findUid(uid);
      if (lootContainer != null) {
        lootContainer.spawnedAtRuntime = true;
        if (lootContainer.slotCount === 0) {
          lootContainer.setSlotCount(1);
        }
      }
      const moved =
        lootContainer != null && index !== -1
          ? ItemContainer.transfer({from: source, fromIndex: index, to: lootContainer, toIndex: 0, count: request.amount})
          : 0;
      if (moved === 0 && loot.valid) {
        loot.destroy();
      }
      if (moved > 0) {
        return ItemResult.done(moved);
      }
      // The stack can leave the slot while the loot spawns; anything else is a broken loot template.
      return ItemResult.refused(index === -1 ? 'missing' : 'unhandled');
    })
    .catch((error: unknown) => {
      console.error('[RequestHandlers] failed to spawn dropped item.', error);
      return ItemResult.refused('unhandled');
    });
}

function dropPosition(transform: TransformComponent | null, distance: number): Vec3 | null {
  return transform != null ? transform.worldPosition.add(transform.worldForward.mul(distance)) : null;
}

// ---------------------------------------------------------------------------
// Stats spent while an item is in use (a gun's magazine, a torch's battery).
// The holder's owner spends them at full speed through GAS; only the results
// come here, and the server bounds both directions, so a client can never
// create value -- only report spending it, or convert real items into it.
// ---------------------------------------------------------------------------

/** A client may only report less than the server already has; a non-number report changes nothing. */
export function acceptedSpend(current: number, reported: number, max: number): number {
  return Number.isFinite(reported) ? Math.max(0, Math.min(current, Math.floor(reported), max)) : current;
}

/** A refill is bounded by headroom, the request and the items actually available. */
export function refillAmount(current: number, max: number, requested: number, available: number): number {
  return Number.isFinite(requested) ? Math.max(0, Math.min(max - current, Math.floor(requested), available)) : 0;
}

/** The limit some fragment of the stack's definition declares for `key`, or null when none does. */
function statLimitOf(stack: ItemStack, key: string): StatLimit | null {
  for (const fragment of itemRegistry.get(stack.defId)?.fragments ?? []) {
    const limit = fragment.statLimit?.(key) ?? null;
    if (limit != null) {
      return limit;
    }
  }
  return null;
}

/** `amount` is how much was spent; a report of more than the stack has is `invalid` and changes nothing. */
function spendStat({request, findStack}: ItemRequestContext): ItemResult {
  const found = findStack(request.uid);
  const limit = found != null ? statLimitOf(found.stack, request.key) : null;
  if (found == null || limit == null) {
    return ItemResult.refused('missing');
  }
  const current = getStat(found.stack, request.key) ?? limit.max;
  if (!Number.isFinite(request.amount) || Math.floor(request.amount) > current) {
    return ItemResult.refused('invalid');
  }
  const next = acceptedSpend(current, request.amount, limit.max);
  if (next !== current) {
    found.container.updateStats(request.uid, stats => stats.set(request.key, next));
  }
  return ItemResult.done(current - next);
}

/** `amount` is how much was refilled: short of the request is `missing` (too few items), nothing to refill is `noRoom`. */
function refillStat({request, findStack, containers}: ItemRequestContext): ItemResult {
  const found = findStack(request.uid);
  const limit = found != null ? statLimitOf(found.stack, request.key) : null;
  const tag = limit?.refillTag;
  if (found == null || limit == null || tag == null) {
    return ItemResult.refused('missing');
  }
  if (!(request.amount >= 1)) {
    return ItemResult.refused('invalid');
  }
  const current = getStat(found.stack, request.key) ?? limit.max;
  if (current >= limit.max) {
    return ItemResult.refused('noRoom');
  }
  const sources = containers.filter(container => container.countWithTag(tag) > 0);
  let remaining = refillAmount(
    current,
    limit.max,
    request.amount,
    sources.reduce((sum, container) => sum + container.countWithTag(tag), 0),
  );
  let taken = 0;
  for (const source of sources) {
    if (remaining <= 0) {
      break;
    }
    const removed = source.removeItemsWithTag(tag, remaining);
    taken += removed;
    remaining -= removed;
  }
  if (taken > 0) {
    found.container.updateStats(request.uid, stats => stats.set(request.key, current + taken));
  }
  const wanted = Math.min(limit.max - current, Math.floor(request.amount));
  return taken >= wanted ? ItemResult.done(taken) : ItemResult.refused('missing', taken);
}

// ---------------------------------------------------------------------------
// Another entity's container (a chest, ground loot). The character's side is
// its own because `runItemRequest` resolves it through `containerRegistry`;
// the other side must pass its container's `accessMode`.
// ---------------------------------------------------------------------------

/** Meters between two entities; Infinity when either has no transform. */
export function distanceBetween(a: Entity, b: Entity): number {
  const here = a.getComponent(TransformComponent)?.worldPosition;
  const there = b.getComponent(TransformComponent)?.worldPosition;
  return here != null && there != null ? here.sub(there).magnitude() : Infinity;
}

/**
 * Server: why `character` may not take from or put into `container`, which is
 * not its own, or null when it may. Only a Proximity container can let the
 * character in from closer.
 */
export function reachRefusal(container: ItemContainer, character: Entity): 'notAllowed' | 'outOfReach' | null {
  const distance = distanceBetween(container.entity, character);
  if (accessAllowed(container.accessMode, container.ownerCharacter === character, distance, container.accessRange)) {
    return null;
  }
  return container.accessMode === ContainerAccessMode.Proximity ? 'outOfReach' : 'notAllowed';
}

function otherContainer(other: Entity | null, role: string): ItemContainer | null {
  return other?.valid === true ? (other.getComponents(ItemContainer).find(c => c.role === role) ?? null) : null;
}

function handleExternalTake({request, containerFor, character}: ItemRequestContext): ItemResult {
  const [from, to] = request.slots;
  const source = from != null ? otherContainer(request.other, from.role) : null;
  const target = to != null ? containerFor(to.role) : null;
  if (source == null || target == null) {
    return ItemResult.refused('missing');
  }
  const reach = reachRefusal(source, character);
  if (reach != null) {
    return ItemResult.refused(reach);
  }
  const result = transferBetween({from: source, fromIndex: from.index, to: target, toIndex: to.index, count: request.amount});
  removeIfEmptied(source, result.amount);
  return result;
}

function handleExternalPut({request, containerFor, character}: ItemRequestContext): ItemResult {
  const [from, to] = request.slots;
  const source = from != null ? containerFor(from.role) : null;
  const target = to != null ? otherContainer(request.other, to.role) : null;
  if (source == null || target == null) {
    return ItemResult.refused('missing');
  }
  const reach = reachRefusal(target, character);
  if (reach != null) {
    return ItemResult.refused(reach);
  }
  return transferBetween({from: source, fromIndex: from.index, to: target, toIndex: to.index, count: request.amount});
}

// ---------------------------------------------------------------------------
// Items arriving without a chosen slot: the `take` interaction
// (`interact.take`, everything that fits from loot or a chest; `Interactable`
// has already checked the action and its `maxDistance`, and the source
// container's `accessRange` applies too) and searching a bag one slot at a time
// (`external.takeAny`).
// ---------------------------------------------------------------------------

/** Containers that accept items without a chosen slot, highest `autoPlacePriority` first; ties keep their order. */
export function autoPlaceOrder<T extends {readonly autoPlacePriority: number}>(containers: readonly T[]): T[] {
  return containers.filter(container => container.autoPlacePriority > 0).sort((a, b) => b.autoPlacePriority - a.autoPlacePriority);
}

/** Moves as much of one slot as fits into `destinations`, in order. Returns how many moved. */
function placeSlot(source: ItemContainer, index: number, destinations: readonly ItemContainer[]): number {
  let moved = 0;
  for (const destination of destinations) {
    if (source.getSlot(index) == null) {
      break;
    }
    moved += ItemContainer.transferToAny(source, index, destination);
  }
  return moved;
}

function removeIfEmptied(source: ItemContainer, moved: number): void {
  if (moved === 0 || !source.removeWhenEmpty || source.count(() => true) > 0 || !source.entity.valid) {
    return;
  }
  if (source.spawnedAtRuntime) {
    source.entity.destroy();
  } else {
    source.entity.enabledSelf = false;
  }
}

/**
 * Moves everything it can from the target's container into the character's
 * containers in `autoPlaceOrder`. Each container's `acceptTags` filters what it
 * takes, so ammo skips a weapons-only hotbar. The target's `accessMode` decides
 * whether this character may take at all, its `removeWhenEmpty` whether it goes
 * away once emptied. `amount` is how many items moved; anything left behind is
 * explained by the first item that stayed.
 */
function takeItems({request, character, containers}: ItemRequestContext): ItemResult {
  const source = request.other?.valid === true ? request.other.getComponent(ItemContainer) : null;
  if (source == null || source.count(() => true) === 0) {
    return ItemResult.refused('missing');
  }
  const reach = reachRefusal(source, character);
  if (reach != null) {
    return ItemResult.refused(reach);
  }
  const destinations = autoPlaceOrder(containers);
  let moved = 0;
  for (let index = 0; index < source.slotCount; index++) {
    moved += placeSlot(source, index, destinations);
  }
  const left = source.slots().find(stack => stack != null) ?? null;
  removeIfEmptied(source, moved);
  return left == null ? ItemResult.done(moved) : ItemResult.refused(placementRefusal(left, destinations), moved);
}

function handleExternalTakeAny({request, character, containers}: ItemRequestContext): ItemResult {
  const from = request.slots[0];
  const source = from != null ? otherContainer(request.other, from.role) : null;
  const stack = source?.getSlot(from.index) ?? null;
  if (source == null || stack == null) {
    return ItemResult.refused('missing');
  }
  const reach = reachRefusal(source, character);
  if (reach != null) {
    return ItemResult.refused(reach);
  }
  const destinations = autoPlaceOrder(containers);
  const moved = placeSlot(source, from.index, destinations);
  removeIfEmptied(source, moved);
  return moved >= stack.count ? ItemResult.done(moved) : ItemResult.refused(placementRefusal(stack, destinations), moved);
}

registerItemRequestHandler('move', move);
registerItemRequestHandler('swap', swap);
registerItemRequestHandler('drop', drop);
registerItemRequestHandler('stat.spend', spendStat);
registerItemRequestHandler('stat.refill', refillStat);
registerItemRequestHandler('external.take', handleExternalTake);
registerItemRequestHandler('external.put', handleExternalPut);
registerItemRequestHandler('external.takeAny', handleExternalTakeAny);
registerItemRequestHandler('interact.take', takeItems);
// A game shows a search window through `registerLocalInteraction('search', ...)` and never sends this; without one, searching takes everything.
registerItemRequestHandler('interact.search', takeItems);
