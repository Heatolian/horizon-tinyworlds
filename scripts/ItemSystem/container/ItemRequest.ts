/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v5

import {property, serializable, Vec3, type Entity, type Maybe} from 'meta/worlds';
import type {ItemStack} from '../items/ItemStack';
import type {ItemContainer} from './ItemContainer';

/** Names a slot of one of a holder's containers in an RPC: container role + slot index. */
@serializable()
export class SlotRef {
  @property()
  readonly role: string = '';

  @property()
  readonly index: number = 0;

  constructor(role?: string, index?: number) {
    if (role !== undefined) {
      this.role = role;
    }
    if (index !== undefined) {
      this.index = index;
    }
  }
}

export interface ItemRequestInit {
  kind: string;
  slots?: readonly SlotRef[];
  uid?: string;
  key?: string;
  amount?: number;
  other?: Maybe<Entity>;
  position?: Vec3;
  direction?: Vec3;
}

/**
 * One request from a holder to the server about its items, about another
 * entity's container (a chest, a shop), or about what its weapon did (a shot
 * the server should know of). A single serializable shape so every
 * request travels through one RPC on one component, in order. `ItemCommands`
 * builds and sends them; handlers read only the fields their `kind` uses.
 */
@serializable()
export class ItemRequest {
  @property()
  readonly kind: string = '';

  @property()
  readonly slots: readonly SlotRef[] = [];

  @property()
  readonly uid: string = '';

  @property()
  readonly key: string = '';

  @property()
  readonly amount: number = 0;

  /** The entity holding the other container, for requests that reach outside the holder's own. */
  @property()
  readonly other: Maybe<Entity> = null;

  /** A point in the world: where a shot left the weapon. */
  @property()
  readonly position: Vec3 = Vec3.zero;

  /** Which way a shot went. */
  @property()
  readonly direction: Vec3 = Vec3.zero;

  constructor(init?: ItemRequestInit) {
    if (init !== undefined) {
      this.kind = init.kind;
      this.slots = init.slots ?? [];
      this.uid = init.uid ?? '';
      this.key = init.key ?? '';
      this.amount = init.amount ?? 0;
      this.other = init.other ?? null;
      this.position = init.position ?? Vec3.zero;
      this.direction = init.direction ?? Vec3.zero;
    }
  }
}

/**
 * Why the server did not carry out (all of) a request:
 * - `missing`: what it acts on is not there: no such container or stack, an
 *   empty slot, a target that is gone, too few items.
 * - `invalid`: it asks for something that cannot be done: a count below 1, a
 *   slot outside the container, using an item that is not usable.
 * - `notAllowed`: the target refuses this character outright: an owner-only or
 *   trade container, an interaction that offers another action.
 * - `outOfReach`: the character is too far from the target (past the
 *   interaction's `maxDistance` or a Proximity container's `accessRange`).
 *   Coming closer can change it.
 * - `rejected`: the destination's `acceptTags` / `rejectTags` refuse the item.
 * - `noRoom`: the destination takes the item but has no room for (all of) it,
 *   or the stat is already full.
 * - `unhandled`: no handler for the request's kind, or its handler failed.
 * - `lost`: client only. The request never reached the server, or its answer
 *   can no longer arrive (the character's request channel went away).
 */
export type ItemRefusal = 'missing' | 'invalid' | 'notAllowed' | 'outOfReach' | 'rejected' | 'noRoom' | 'unhandled' | 'lost';

/**
 * What the server did with one request: how much (`amount`; each command in
 * `ItemCommands` says what it counts) and, when that is not all the request
 * asked for, why (`refusal`). A receipt for deciding what to do next, not
 * state: the containers themselves arrive through replication.
 */
@serializable()
export class ItemResult {
  /** Items moved, used or spent, or stat units changed. 0 when nothing changed. */
  @property()
  readonly amount: number = 0;

  /** An `ItemRefusal`, or '' when the request was carried out in full. */
  @property()
  readonly refusal: string = '';

  constructor(amount?: number, refusal?: ItemRefusal) {
    if (amount !== undefined) {
      this.amount = amount;
    }
    if (refusal !== undefined) {
      this.refusal = refusal;
    }
  }

  /** Carried out in full; `amount` is what it did. */
  static done(amount: number): ItemResult {
    return new ItemResult(amount);
  }

  /** Not carried out, or only `amount` of it, because of `reason`. */
  static refused(reason: ItemRefusal, amount: number = 0): ItemResult {
    return new ItemResult(amount, reason);
  }

  /** True when the request was carried out in full. */
  get complete(): boolean {
    return this.refusal === '';
  }

  /** Why it was not carried out in full, or null when it was. */
  get reason(): ItemRefusal | null {
    return this.refusal === '' ? null : (this.refusal as ItemRefusal);
  }
}

export interface FoundStack {
  readonly container: ItemContainer;
  readonly index: number;
  readonly stack: ItemStack;
}

/** What a handler gets on the server. `containers` are the character's own (found through `containerRegistry`). */
export interface ItemRequestContext {
  readonly character: Entity;
  readonly request: ItemRequest;
  readonly containers: readonly ItemContainer[];
  containerFor(role: string): ItemContainer | null;
  findStack(uid: string): FoundStack | null;
}

/**
 * Runs on the server; must re-validate everything in the request against
 * server state, and say what it did. A handler that has to wait (spawning the
 * loot a drop moves into) returns a promise of its result.
 */
export type ItemRequestHandler = (ctx: ItemRequestContext) => ItemResult | Promise<ItemResult>;

const handlers = new Map<string, ItemRequestHandler>();

/** A module registers each request kind it implements. Built-in kinds live in `RequestHandlers.ts`. */
export function registerItemRequestHandler(kind: string, handler: ItemRequestHandler): void {
  if (handlers.has(kind)) {
    console.warn(`[ItemRequest] handler for '${kind}' is already registered; keeping the first.`);
    return;
  }
  handlers.set(kind, handler);
}

export function findItemRequestHandler(kind: string): ItemRequestHandler | null {
  return handlers.get(kind) ?? null;
}
