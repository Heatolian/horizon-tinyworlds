/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v5

import type {Entity, Vec3} from 'meta/worlds';
import {ItemRequest, SlotRef, type ItemRequestInit, type ItemResult} from './ItemRequest';
import {sendItemRequest} from './ItemRequestServer';

/**
 * The one way UI, input, AI and features change a character's items. Every
 * call is one request to the server (`ItemRequestServer`; on the server, as for
 * NPCs, it runs directly); nothing changes locally, the containers arrive
 * through replication. Requests are handled in send order, by the handler
 * registered for their `kind`.
 *
 * Every call resolves with an `ItemResult`: how much the server did (each
 * command says what `amount` counts) and, short of the request, the
 * `ItemRefusal` that explains why. On the server the request has run before the
 * call returns and the promise resolves on the same frame; on a client it
 * resolves when the server's answer arrives. It never rejects. Callers that do
 * not need the answer drop it (`void dropItem(...)`); the answer is a receipt
 * for deciding what to do next, never inventory state.
 */

function send(character: Entity, init: ItemRequestInit): Promise<ItemResult> {
  return sendItemRequest(character, new ItemRequest(init));
}

type BeforeItemsLeave = (character: Entity) => void;
const beforeItemsLeave = new Set<BeforeItemsLeave>();

/**
 * Runs before a request that takes items out of the character's containers
 * (drop, put into a chest), so client-side state the server has not seen yet
 * (a gun's unconfirmed magazine) is reported while the item is still the
 * character's. Requests run in send order, so the report lands first.
 */
export function addBeforeItemsLeaveListener(listener: BeforeItemsLeave): () => void {
  beforeItemsLeave.add(listener);
  return () => beforeItemsLeave.delete(listener);
}

function flushBeforeItemsLeave(character: Entity): void {
  for (const listener of [...beforeItemsLeave]) {
    listener(character);
  }
}

/** Moves up to `count` from one of the character's slots into another. `amount`: items moved. */
export function moveItem(character: Entity, from: SlotRef, to: SlotRef, count: number): Promise<ItemResult> {
  return send(character, {kind: 'move', slots: [from, to], amount: count});
}

/** Exchanges two of the character's slots. `amount`: 1 when exchanged. */
export function swapItems(character: Entity, a: SlotRef, b: SlotRef): Promise<ItemResult> {
  return send(character, {kind: 'swap', slots: [a, b]});
}

/** Drops up to `count` from a slot. `amount`: items dropped. */
export function dropItem(character: Entity, from: SlotRef, count: number): Promise<ItemResult> {
  flushBeforeItemsLeave(character);
  return send(character, {kind: 'drop', slots: [from], amount: count});
}

/** A move between the character's containers and the container on `other` (a chest). */
export interface ExternalMove {
  other: Entity;
  from: SlotRef;
  to: SlotRef;
  count: number;
}

/** Takes from `move.other`'s container slot `from` into the character's slot `to`. `amount`: items taken. */
export function takeFrom(character: Entity, move: ExternalMove): Promise<ItemResult> {
  return send(character, {kind: 'external.take', other: move.other, slots: [move.from, move.to], amount: move.count});
}

/**
 * Takes slot `from` of `other`'s container into whichever of the character's
 * containers fit it (searching a bag). `amount`: items taken.
 */
export function takeFromAny(character: Entity, other: Entity, from: SlotRef): Promise<ItemResult> {
  return send(character, {kind: 'external.takeAny', other, slots: [from]});
}

/** Puts from the character's slot `from` into `move.other`'s container slot `to`. `amount`: items put. */
export function putInto(character: Entity, move: ExternalMove): Promise<ItemResult> {
  flushBeforeItemsLeave(character);
  return send(character, {kind: 'external.put', other: move.other, slots: [move.from, move.to], amount: move.count});
}

/** Uses the item in a slot (a medkit). `amount`: items consumed. */
export function useItem(character: Entity, from: SlotRef): Promise<ItemResult> {
  return send(character, {kind: 'use', slots: [from]});
}

/** Spends one of the character's stack `uid`, which must be `Expendable` (a thrown grenade). `amount`: 1 when spent. */
export function expendItem(character: Entity, uid: string): Promise<ItemResult> {
  return send(character, {kind: 'expend', uid});
}

/**
 * A round of a loud weapon (its delivery's `loudness` above 0) left the
 * character's stack `uid` at `origin`, along `direction`. The server checks it
 * against the weapon in hand and passes it to `addWeaponNoiseListener`, heard
 * where the server has the character. `amount`: 1 when accepted.
 */
export function reportShot(character: Entity, uid: string, origin: Vec3, direction: Vec3): Promise<ItemResult> {
  return send(character, {kind: 'weapon.shot', uid, position: origin, direction});
}

/**
 * `deployable`, thrown from a weapon of definition `defId`, went off. Named by
 * definition, not stack: the last one thrown is gone by then. The server hears
 * it where it has the deployable. `amount`: 1 when accepted.
 */
export function reportDetonation(character: Entity, defId: string, deployable: Entity): Promise<ItemResult> {
  return send(character, {kind: 'weapon.detonation', key: defId, other: deployable});
}

/**
 * Uses `target`'s `Interactable`, whose `action` must be `action` (e.g. `take`
 * on loot). The answer is the action's own: for `take`, `amount` is the items
 * taken and anything left behind is explained by the first item that stayed.
 */
export function interact(character: Entity, target: Entity, action: string): Promise<ItemResult> {
  return send(character, {kind: 'interact', other: target, key: action});
}

/**
 * The stack `uid` now has `value` of stat `key` (a gun's magazine after
 * firing); the server only accepts a decrease. `amount`: units spent.
 */
export function spendStat(character: Entity, uid: string, key: string, value: number): Promise<ItemResult> {
  return send(character, {kind: 'stat.spend', uid, key, amount: value});
}

/** Refills stat `key` of stack `uid` by up to `amount` from the character's matching items (reloading). `amount`: units refilled. */
export function refillStat(character: Entity, uid: string, key: string, amount: number): Promise<ItemResult> {
  return send(character, {kind: 'stat.refill', uid, key, amount});
}

export function slot(role: string, index: number): SlotRef {
  return new SlotRef(role, index);
}
