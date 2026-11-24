/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {type ItemRegistry, Stackable} from '../items/ItemDefinition';
import {canStackTogether, withCount, withUid, type ItemStack} from '../items/ItemStack';

export type Slot = ItemStack | null;

/** One container's slots while a change runs, plus its accept rule. Ops edit `slots` in place; the container commits it after. */
export interface SlotDraft {
  readonly slots: Slot[];
  accepts(stack: ItemStack, slotIndex: number): boolean;
}

export interface SlotOpsDeps {
  registry: ItemRegistry;
  mintUid: () => string;
}

function maxStack(stack: ItemStack, deps: SlotOpsDeps): number {
  const definition = deps.registry.get(stack.defId);
  return definition != null ? Stackable.maxOf(definition) : stack.count;
}

function isIndex(draft: SlotDraft, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < draft.slots.length;
}

function findFirstEmpty(draft: SlotDraft, stack: ItemStack): number {
  return draft.slots.findIndex((slot, i) => slot == null && draft.accepts(stack, i));
}

/** Puts a whole stack into an empty slot (`-1` = first empty one that accepts it). */
export function placeStack(draft: SlotDraft, stack: ItemStack, slotIndex: number, deps: SlotOpsDeps): boolean {
  const index = slotIndex === -1 ? findFirstEmpty(draft, stack) : slotIndex;
  if (
    !isIndex(draft, index) ||
    draft.slots[index] != null ||
    !draft.accepts(stack, index) ||
    stack.count < 1 ||
    stack.count > maxStack(stack, deps)
  ) {
    return false;
  }
  draft.slots[index] = stack;
  return true;
}

/**
 * Adds `count` new items: tops up mergeable stacks first, then opens empty
 * slots. Returns how many were added; the caller decides what to do with the rest.
 */
export function addItems(draft: SlotDraft, defId: string, count: number, deps: SlotOpsDeps): number {
  const template = deps.registry.createStack(defId, 1, '');
  if (template == null || !(count >= 1)) {
    return 0;
  }
  const max = maxStack(template, deps);
  let remaining = Math.floor(count);
  for (let i = 0; i < draft.slots.length && remaining > 0; i++) {
    const slot = draft.slots[i];
    if (slot != null && slot.count < max && canStackTogether(slot, template) && draft.accepts(slot, i)) {
      const moved = Math.min(max - slot.count, remaining);
      draft.slots[i] = withCount(slot, slot.count + moved);
      remaining -= moved;
    }
  }
  while (remaining > 0) {
    const stack = deps.registry.createStack(defId, Math.min(remaining, max), deps.mintUid());
    if (stack == null || !placeStack(draft, stack, -1, deps)) {
      break;
    }
    remaining -= stack.count;
  }
  return Math.floor(count) - remaining;
}

/** Takes up to `count` matching items, last slot first. Emptied slots become null. */
export function removeItems(draft: SlotDraft, match: (stack: ItemStack) => boolean, count: number): number {
  if (!(count >= 1)) {
    return 0;
  }
  let remaining = Math.floor(count);
  for (let i = draft.slots.length - 1; i >= 0 && remaining > 0; i--) {
    const slot = draft.slots[i];
    if (slot != null && match(slot)) {
      const taken = Math.min(slot.count, remaining);
      draft.slots[i] = slot.count > taken ? withCount(slot, slot.count - taken) : null;
      remaining -= taken;
    }
  }
  return Math.floor(count) - remaining;
}

export function countMatching(slots: readonly Slot[], match: (stack: ItemStack) => boolean): number {
  let total = 0;
  for (const slot of slots) {
    if (slot != null && match(slot)) {
      total += slot.count;
    }
  }
  return total;
}

/** Up to `count` items from `from[fromIndex]` to `to[toIndex]`; `from` and `to` may be the same. */
export interface SlotMove<T> {
  from: T;
  fromIndex: number;
  to: T;
  toIndex: number;
  count: number;
}

/**
 * Empty target: whole stack keeps its uid, a partial move splits off a new uid.
 * Same mergeable item: merges up to the stack limit, rest stays in the source.
 * Different item: refused; use `swap`. Returns how many moved.
 */
export function transfer(move: SlotMove<SlotDraft>, deps: SlotOpsDeps): number {
  const {from, fromIndex, to, toIndex, count} = move;
  if (!isIndex(from, fromIndex) || !isIndex(to, toIndex) || (from === to && fromIndex === toIndex)) {
    return 0;
  }
  const source = from.slots[fromIndex];
  if (source == null || !(count >= 1)) {
    return 0;
  }
  const amount = Math.min(Math.floor(count), source.count);
  const target = to.slots[toIndex];

  if (target == null) {
    const moving = amount === source.count ? source : withUid(withCount(source, amount), deps.mintUid());
    if (!to.accepts(moving, toIndex)) {
      return 0;
    }
    to.slots[toIndex] = moving;
    from.slots[fromIndex] = amount === source.count ? null : withCount(source, source.count - amount);
    return amount;
  }

  if (!canStackTogether(source, target)) {
    return 0;
  }
  const moved = Math.min(amount, maxStack(target, deps) - target.count);
  if (moved <= 0) {
    return 0;
  }
  to.slots[toIndex] = withCount(target, target.count + moved);
  from.slots[fromIndex] = source.count > moved ? withCount(source, source.count - moved) : null;
  return moved;
}

/**
 * Moves as much of one slot as fits anywhere in `to`: mergeable stacks first,
 * then the first accepting empty slot. The remainder keeps the source uid.
 */
export function transferToAny(from: SlotDraft, fromIndex: number, to: SlotDraft, deps: SlotOpsDeps): number {
  if (!isIndex(from, fromIndex)) {
    return 0;
  }
  let source = from.slots[fromIndex];
  if (source == null) {
    return 0;
  }
  const original = source.count;
  const max = maxStack(source, deps);
  for (let i = 0; i < to.slots.length && source != null; i++) {
    const slot = to.slots[i];
    if ((from === to && i === fromIndex) || slot == null || slot.count >= max || !canStackTogether(slot, source)) {
      continue;
    }
    const moved = Math.min(max - slot.count, source.count);
    to.slots[i] = withCount(slot, slot.count + moved);
    source = source.count > moved ? withCount(source, source.count - moved) : null;
  }
  if (source != null) {
    const empty = findFirstEmpty(to, source);
    if (empty !== -1) {
      to.slots[empty] = source;
      source = null;
    }
  }
  from.slots[fromIndex] = source;
  return original - (source?.count ?? 0);
}

/** Exchanges two slots when each occupant is accepted at its new place. */
export function swap(a: SlotDraft, aIndex: number, b: SlotDraft, bIndex: number): boolean {
  if (!isIndex(a, aIndex) || !isIndex(b, bIndex) || (a === b && aIndex === bIndex)) {
    return false;
  }
  const first = a.slots[aIndex];
  const second = b.slots[bIndex];
  if (first == null && second == null) {
    return false;
  }
  if ((first != null && !b.accepts(first, bIndex)) || (second != null && !a.accepts(second, aIndex))) {
    return false;
  }
  a.slots[aIndex] = second;
  b.slots[bIndex] = first;
  return true;
}
