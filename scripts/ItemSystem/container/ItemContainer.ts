/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v4

import {
  Component,
  component,
  editor,
  ExecuteOn,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  property,
  subscribe,
  subscribePropertyChange,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {itemRegistry, type ItemRegistry} from '../items/ItemDefinition';
import {canStackTogether, ItemStack, newItemUid, withStats, type ItemStatsBuilder} from '../items/ItemStack';
import {characterOf} from './CharacterLookup';
import * as SlotOps from './SlotOps';
import type {Slot, SlotDraft, SlotMove, SlotOpsDeps} from './SlotOps';

/**
 * Who may take from or put into a container that is not their own. The same
 * `ItemContainer` is a backpack, a chest or a shop; only its modes differ.
 */
export enum ContainerAccessMode {
  /** Only the owning character (a backpack, a hotbar). */
  Owner,
  /** Any character within range (a chest, loot on the ground). */
  Proximity,
  /** Nobody takes or puts directly; only trade requests move items (a shop). */
  Trade,
}

/** Whether items in a character's container take effect on that character (through `EquipmentBinder`). */
export enum ContainerEquipMode {
  /** Storage only (backpack, chest, shop, loot). */
  None,
  /** Only the selected slot takes effect (a hotbar: one gun in hand). */
  Selected,
  /** Every slot takes effect (armour, trinkets). */
  All,
}

export function accessAllowed(mode: ContainerAccessMode, isOwner: boolean, distance: number, range: number): boolean {
  switch (mode) {
    case ContainerAccessMode.Owner:
      return isOwner;
    case ContainerAccessMode.Proximity:
      return isOwner || distance <= range;
    case ContainerAccessMode.Trade:
      return false;
  }
}

/** The registry only needs these two facts about a container. */
export interface RegisteredContainer {
  readonly role: string;
  readonly ownerCharacter: Entity | null;
}

type RegistryListener = (owner: Entity) => void;

/**
 * Containers indexed by the character they belong to, on every machine. A
 * player's containers live on a separate server-owned entity, so this is how
 * the character finds them; it also covers late joiners because each
 * container registers itself when it starts or its owner replicates.
 */
export class ContainerRegistry<T extends RegisteredContainer = RegisteredContainer> {
  private readonly byOwner = new Map<Entity, Set<T>>();
  private readonly listeners = new Set<RegistryListener>();

  register(container: T, owner: Entity): void {
    let set = this.byOwner.get(owner);
    if (set == null) {
      set = new Set();
      this.byOwner.set(owner, set);
    }
    if (!set.has(container)) {
      set.add(container);
      this.notify(owner);
    }
  }

  unregister(container: T, owner: Entity): void {
    const set = this.byOwner.get(owner);
    if (set?.delete(container) === true) {
      if (set.size === 0) {
        this.byOwner.delete(owner);
      }
      this.notify(owner);
    }
  }

  find(owner: Entity, role: string): T | null {
    for (const container of this.byOwner.get(owner) ?? []) {
      if (container.role === role) {
        return container;
      }
    }
    return null;
  }

  all(owner: Entity): T[] {
    return [...(this.byOwner.get(owner) ?? [])];
  }

  /** Called with the owner whenever one of its containers registers or unregisters. */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(owner: Entity): void {
    for (const listener of [...this.listeners]) {
      listener(owner);
    }
  }
}

export interface SlotChange {
  readonly index: number;
  readonly before: Slot;
  readonly after: Slot;
}

export type SlotListener = (container: ItemContainer, changes: readonly SlotChange[]) => void;

export const containerRegistry = new ContainerRegistry<ItemContainer>();

/**
 * Containers on `root` and its descendants. Each container needs its own
 * entity: two components of the same class on one entity end up sharing one
 * data block at runtime (a loadout and a backpack both became "backpack").
 */
export function containersIn(root: Entity): ItemContainer[] {
  return [root, ...root.getChildrenWithComponent(ItemContainer, true)].flatMap(entity => entity.getComponents(ItemContainer));
}

/** The character the containers on `root` belong to, once one of them has an owner (a player's are assigned after spawning). */
export function ownerOfContainersIn(root: Entity): Entity | null {
  return containersIn(root).find(container => container.ownerCharacter != null)?.ownerCharacter ?? null;
}

/** Replicated arrays cannot hold null, so an empty slot travels as a default-constructed stack. */
const EMPTY_SLOT = new ItemStack();

function toSlot(stack: ItemStack): Slot {
  return stack.defId === '' ? null : stack;
}

/**
 * A row of item slots. Only the entity's owner mutates it — put containers on
 * server-owned entities (loot, a player's container entity, an NPC) so the
 * server is that owner. Every machine reads the replicated slots and receives
 * per-slot change notifications.
 *
 * Listeners must not mutate a container that is mid-operation; such writes are
 * refused. Queue them for later instead.
 */
@component({
  description:
    'Server-authoritative slots of item stacks (backpack, loadout, loot, chest). Mutate on the owner only; every machine reads the replicated slots.',
})
export class ItemContainer extends Component {
  @editor({
    description: 'Lets the owner find this container among its others, e.g. "loadout", "backpack" or "loot".',
  })
  @property()
  public role: string = '';

  @editor({
    description: 'Only items with one of these tags, or a child tag, are accepted. Empty accepts everything.',
  })
  @property()
  public acceptTags: readonly string[] = [];

  @editor({description: 'Items with one of these tags, or a child tag, are refused, even when acceptTags accepts them.'})
  @property()
  public rejectTags: readonly string[] = [];

  @editor({description: 'Number of slots created when the owner starts.'})
  @property({minValue: 0})
  public initialSlotCount: number = 0;

  @editor({
    description:
      'Items placed into the first slots when the owner starts, as "id" or "id*count" (e.g. "ammo_9mm*60"). Entries that do not fit are skipped.',
  })
  @property()
  public initialItems: readonly string[] = [];

  @editor({
    description:
      'When enabled, the owner is this entity\'s character: this entity or its nearest ancestor with GAS (an NPC holding its own containers, on its root or an ItemSystem child). Player containers set the owner from code instead.',
  })
  @property()
  public ownedByCharacter: boolean = false;

  @editor({
    description:
      'Who may take from or put into this container from another entity. Owner: only its owning character (backpack). Proximity: anyone within accessRange (chest, loot). Trade: only through trade requests (shop).',
  })
  @property()
  public accessMode: ContainerAccessMode = ContainerAccessMode.Owner;

  @editor({
    description:
      'Whether items here take effect on the owning character. None: storage only. Selected: only the selected slot (a hotbar). All: every slot (armour).',
  })
  @property()
  public equipMode: ContainerEquipMode = ContainerEquipMode.None;

  @editor({
    description:
      'For items arriving without a chosen slot (a pickup): the owner\'s containers are tried from the highest priority down. 0 never receives them.',
  })
  @property({minValue: 0})
  public autoPlacePriority: number = 1;

  @editor({description: 'Meters from this entity within which Proximity access is allowed.'})
  @property({minValue: 0})
  public accessRange: number = 3;

  @editor({
    description:
      'Remove this entity once the last item is taken out (ground loot): destroyed if code spawned it, disabled if it was placed in the scene. Leave off for chests.',
  })
  @property()
  public removeWhenEmpty: boolean = false;

  /** The character these slots belong to; null for loot. Written by the owner, indexed by `containerRegistry`. */
  @editor({show: false})
  @property()
  public ownerCharacter: Maybe<Entity> = null;

  /** Source of truth; only the server writes it. Empty slots travel as `EMPTY_SLOT`. */
  @editor({show: false})
  @property()
  private networkedSlots: readonly ItemStack[] = [];

  /** Overridable for tests; production uses the shared registry. */
  public registry: ItemRegistry = itemRegistry;

  /**
   * Server only: set by whatever spawned this entity at runtime (`drop`, `DropOnDeath`). Script may destroy only
   * spawned entities, so an emptied `removeWhenEmpty` container placed in the scene is disabled instead.
   */
  public spawnedAtRuntime: boolean = false;

  /** Decoded `networkedSlots` on this machine. Kept separately because it is the "before" side of the next diff. */
  private localSlots: Slot[] = [];
  private registeredOwner: Entity | null = null;
  private readonly listeners = new Set<SlotListener>();
  private mutating = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    this.syncKnownSlots();
    if (this.entity.isOwned()) {
      if (this.ownedByCharacter && this.ownerCharacter == null) {
        this.ownerCharacter = characterOf(this.entity) ?? this.entity;
      }
      this.seedInitialContents();
    }
    this.syncRegistration();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    if (this.registeredOwner != null) {
      containerRegistry.unregister(this, this.registeredOwner);
      this.registeredOwner = null;
    }
    this.listeners.clear();
  }

  @subscribePropertyChange('networkedSlots')
  private onSlotsReplicated(): void {
    this.syncKnownSlots();
  }

  @subscribePropertyChange('ownerCharacter')
  private onOwnerReplicated(): void {
    this.syncRegistration();
  }

  get slotCount(): number {
    return this.localSlots.length;
  }

  getSlot(index: number): Slot {
    return this.localSlots[index] ?? null;
  }

  slots(): readonly Slot[] {
    return this.localSlots;
  }

  findUid(uid: string): number {
    return this.localSlots.findIndex(slot => slot?.uid === uid);
  }

  count(match: (stack: ItemStack) => boolean): number {
    return SlotOps.countMatching(this.localSlots, match);
  }

  countWithTag(tag: string): number {
    return this.count(stack => this.registry.get(stack.defId)?.hasTag(tag) === true);
  }

  accepts(stack: ItemStack, _slotIndex: number): boolean {
    if (this.acceptTags.length === 0 && this.rejectTags.length === 0) {
      return true;
    }
    const definition = this.registry.get(stack.defId);
    if (definition == null) {
      return this.acceptTags.length === 0;
    }
    return (
      (this.acceptTags.length === 0 || this.acceptTags.some(tag => definition.hasTag(tag))) &&
      !this.rejectTags.some(tag => definition.hasTag(tag))
    );
  }

  /** Called on every machine with the slots that changed, after the whole operation committed. */
  addSlotListener(listener: SlotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Owner only. Shrinking drops whatever sits past the new end; move it first. */
  setSlotCount(count: number): boolean {
    return ItemContainer.mutate([this], ([draft]) => {
      const target = Math.max(0, Math.floor(count));
      draft.slots.length = target;
      draft.slots.fill(null, this.localSlots.length);
      return true;
    }) ?? false;
  }

  /** Owner only. Puts a whole stack into an empty slot (`-1` = first that accepts it). */
  addStack(stack: ItemStack, slotIndex: number = -1): boolean {
    return ItemContainer.mutate([this], ([draft], deps) => SlotOps.placeStack(draft, stack, slotIndex, deps)) ?? false;
  }

  /** Owner only. Merges into existing stacks, then opens slots. Returns how many were added. */
  addItems(defId: string, count: number): number {
    return ItemContainer.mutate([this], ([draft], deps) => SlotOps.addItems(draft, defId, count, deps)) ?? 0;
  }

  /** Owner only. Takes up to `count` matching items, last slot first. Returns how many were taken. */
  removeItems(match: (stack: ItemStack) => boolean, count: number): number {
    return ItemContainer.mutate([this], ([draft]) => SlotOps.removeItems(draft, match, count)) ?? 0;
  }

  /** Owner only. Like `removeItems` for any item carrying `tag` or a child of it. */
  removeItemsWithTag(tag: string, count: number): number {
    return this.removeItems(stack => this.registry.get(stack.defId)?.hasTag(tag) === true, count);
  }

  /** Owner only. Empties one slot and returns what was in it. */
  /** Owner only. Rewrites per-instance stats of the stack with `uid`; false when it is not here. */
  updateStats(uid: string, edit: (stats: ItemStatsBuilder) => void): boolean {
    return ItemContainer.mutate([this], ([draft]) => {
      const index = draft.slots.findIndex(slot => slot?.uid === uid);
      const stack = index === -1 ? null : draft.slots[index];
      if (stack == null) {
        return false;
      }
      draft.slots[index] = withStats(stack, edit);
      return true;
    }) ?? false;
  }

  /** Owner of both only. See `SlotOps.transfer`. Returns how many moved. */
  static transfer(move: SlotMove<ItemContainer>): number {
    return (
      ItemContainer.mutate([move.from, move.to], ([source, target], deps) =>
        SlotOps.transfer({...move, from: source, to: target}, deps),
      ) ?? 0
    );
  }

  /** Owner of both only. Moves as much of one slot as fits anywhere in `to`. */
  static transferToAny(from: ItemContainer, fromIndex: number, to: ItemContainer): number {
    return (
      ItemContainer.mutate([from, to], ([source, target], deps) =>
        SlotOps.transferToAny(source, fromIndex, target, deps),
      ) ?? 0
    );
  }

  /** Owner of both only. Exchanges two slots when each occupant is accepted at its new place. */
  static swap(a: ItemContainer, aIndex: number, b: ItemContainer, bIndex: number): boolean {
    return ItemContainer.mutate([a, b], ([first, second]) => SlotOps.swap(first, aIndex, second, bIndex)) ?? false;
  }

  /**
   * Runs `op` on working copies of the distinct containers in `containers`
   * (passing the same container twice yields the same draft twice), then commits
   * every changed slot and notifies. Returns null when any container refuses.
   */
  private static mutate<T>(
    containers: readonly ItemContainer[],
    op: (drafts: SlotDraft[], deps: SlotOpsDeps) => T,
  ): T | null {
    const distinct = [...new Set(containers)];
    if (distinct.some(container => !container.canMutateNow())) {
      return null;
    }
    const drafts = new Map<ItemContainer, SlotDraft>();
    for (const container of distinct) {
      drafts.set(container, {
        slots: [...container.localSlots],
        accepts: (stack, index) => container.accepts(stack, index),
      });
    }
    const result = op(
      containers.map(container => drafts.get(container)!),
      {registry: distinct[0].registry, mintUid: newItemUid},
    );

    const pending: Array<[ItemContainer, SlotChange[]]> = [];
    for (const container of distinct) {
      const changes = container.commit(drafts.get(container)!.slots);
      if (changes.length > 0) {
        pending.push([container, changes]);
      }
    }
    for (const container of distinct) {
      container.mutating = true;
    }
    try {
      for (const [container, changes] of pending) {
        container.notify(changes);
      }
    } finally {
      for (const container of distinct) {
        container.mutating = false;
      }
    }
    return result;
  }

  private canMutateNow(): boolean {
    if (!this.entity.valid || !this.entity.isOwned()) {
      console.warn(`[ItemContainer] '${String(this.entity.name)}' can only be changed by its owner.`);
      return false;
    }
    if (this.entity.networked && !NetworkingService.get().isServerContext()) {
      console.warn(
        `[ItemContainer] '${String(this.entity.name)}' is networked but owned by a client; only the server may change it. Put containers on server-owned entities.`,
      );
      return false;
    }
    if (this.mutating) {
      console.warn(`[ItemContainer] '${String(this.entity.name)}' refused a nested change from a slot listener.`);
      return false;
    }
    return true;
  }

  private commit(next: readonly Slot[]): SlotChange[] {
    const changes = diffSlots(this.localSlots, next);
    if (changes.length > 0 || next.length !== this.localSlots.length) {
      this.localSlots = [...next];
      this.networkedSlots = next.map(slot => slot ?? EMPTY_SLOT);
    }
    return changes;
  }

  private syncKnownSlots(): void {
    const next = this.networkedSlots.map(toSlot);
    const changes = diffSlots(this.localSlots, next);
    this.localSlots = next;
    if (changes.length > 0) {
      this.notify(changes);
    }
  }

  private syncRegistration(): void {
    const owner = this.ownerCharacter ?? null;
    if (owner === this.registeredOwner) {
      return;
    }
    if (this.registeredOwner != null) {
      containerRegistry.unregister(this, this.registeredOwner);
    }
    this.registeredOwner = owner;
    if (owner != null) {
      containerRegistry.register(this, owner);
    }
  }

  private seedInitialContents(): void {
    if (this.localSlots.length > 0 || this.initialSlotCount <= 0) {
      return;
    }
    this.setSlotCount(this.initialSlotCount);
    this.initialItems.forEach((entry, index) => {
      const {defId, count} = parseInitialItem(entry);
      const stack = this.registry.createStack(defId, count);
      if (stack == null || !this.addStack(stack, index)) {
        console.warn(`[ItemContainer] '${String(this.entity.name)}' could not place initial item '${entry}' in slot ${index}.`);
      }
    });
  }

  private notify(changes: readonly SlotChange[]): void {
    for (const listener of [...this.listeners]) {
      listener(this, changes);
    }
  }
}

/** `"id"` is one item; `"id*count"` is a stack. A malformed count falls back to 1. */
export function parseInitialItem(entry: string): {defId: string; count: number} {
  const separator = entry.lastIndexOf('*');
  if (separator === -1) {
    return {defId: entry.trim(), count: 1};
  }
  const count = Number(entry.slice(separator + 1));
  return {defId: entry.slice(0, separator).trim(), count: Number.isInteger(count) && count >= 1 ? count : 1};
}

/** Slots whose stack identity, count or stats differ. An extra slot counts only if it holds an item, so a pure length change reports nothing. */
export function diffSlots(before: readonly Slot[], after: readonly Slot[]): SlotChange[] {
  const changes: SlotChange[] = [];
  const length = Math.max(before.length, after.length);
  for (let i = 0; i < length; i++) {
    const a = before[i] ?? null;
    const b = after[i] ?? null;
    if (!sameSlot(a, b)) {
      changes.push({index: i, before: a, after: b});
    }
  }
  return changes;
}

function sameSlot(a: Slot, b: Slot): boolean {
  if (a === b) {
    return true;
  }
  return a != null && b != null && a.uid === b.uid && a.count === b.count && canStackTogether(a, b);
}
