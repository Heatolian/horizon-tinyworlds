/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {property, serializable} from 'meta/worlds';

/** One per-instance number on a stack, e.g. `weapon.magazine`. Keys are namespaced by the owning module. */
@serializable()
export class ItemStat {
  @property()
  readonly key: string = '';

  @property()
  readonly value: number = 0;

  constructor(key?: string, value?: number) {
    if (key !== undefined) {
      this.key = key;
    }
    if (value !== undefined) {
      this.value = value;
    }
  }
}

/**
 * One stack of one item definition. Immutable: containers replace a stack
 * rather than edit it, so a replicated slot array never aliases live state.
 * An empty slot is `null`, never a stack with count 0.
 */
@serializable()
export class ItemStack {
  /** Identity that survives moves between containers; splitting a stack mints a new one. */
  @property()
  readonly uid: string = '';

  @property()
  readonly defId: string = '';

  @property()
  readonly count: number = 0;

  /** Sorted by key, so two stacks with equal stats compare equal element-wise. */
  @property()
  readonly stats: readonly ItemStat[] = [];

  constructor(uid?: string, defId?: string, count?: number, stats?: readonly ItemStat[]) {
    if (uid !== undefined) {
      this.uid = uid;
    }
    if (defId !== undefined) {
      this.defId = defId;
    }
    if (count !== undefined) {
      this.count = count;
    }
    if (stats !== undefined) {
      this.stats = stats;
    }
  }
}

let uidCounter = 0;

/** Unique within one server session; not a persistent id. */
export function newItemUid(): string {
  uidCounter++;
  return `${Date.now().toString(36)}.${uidCounter.toString(36)}`;
}

export function getStat(stack: ItemStack, key: string): number | undefined {
  return stack.stats.find(stat => stat.key === key)?.value;
}

export function withCount(stack: ItemStack, count: number): ItemStack {
  return new ItemStack(stack.uid, stack.defId, count, stack.stats);
}

export function withUid(stack: ItemStack, uid: string): ItemStack {
  return new ItemStack(uid, stack.defId, stack.count, stack.stats);
}

export function withStats(stack: ItemStack, edit: (stats: ItemStatsBuilder) => void): ItemStack {
  const builder = ItemStatsBuilder.from(stack.stats);
  edit(builder);
  return new ItemStack(stack.uid, stack.defId, stack.count, builder.build());
}

/** True when the two stacks may merge without losing per-instance state. */
export function canStackTogether(a: ItemStack, b: ItemStack): boolean {
  if (a.defId !== b.defId || a.stats.length !== b.stats.length) {
    return false;
  }
  return a.stats.every((stat, i) => stat.key === b.stats[i].key && stat.value === b.stats[i].value);
}

/** Mutable view used while computing a stack's stats; `build()` freezes it into sorted `ItemStat`s. */
export class ItemStatsBuilder {
  private readonly values = new Map<string, number>();

  static from(stats: readonly ItemStat[]): ItemStatsBuilder {
    const builder = new ItemStatsBuilder();
    for (const stat of stats) {
      builder.values.set(stat.key, stat.value);
    }
    return builder;
  }

  get(key: string): number | undefined {
    return this.values.get(key);
  }

  set(key: string, value: number): void {
    this.values.set(key, value);
  }

  add(key: string, delta: number): void {
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  build(): readonly ItemStat[] {
    return [...this.values.keys()]
      .sort()
      .map(key => new ItemStat(key, this.values.get(key)));
  }
}
