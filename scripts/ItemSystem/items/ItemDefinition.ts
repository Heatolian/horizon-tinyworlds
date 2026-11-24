/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {ItemStack, ItemStatsBuilder, newItemUid} from './ItemStack';

/** Bounds for a per-instance stat that clients may spend and refill through server requests. */
export interface StatLimit {
  readonly max: number;
  /** Items carrying this tag (or a child tag) refill the stat one-for-one. Omit when it cannot be refilled. */
  readonly refillTag?: string;
}

/**
 * A read-only capability declared on an item definition. Behaviour lives in
 * the system that reads the fragment, and the fragment class lives in that
 * system's module: Items never imports equipment, weapons or usable.
 */
export abstract class ItemFragment {
  /** Seeds per-instance stats when a brand-new stack is created. Not called when a stack is split. Server only. */
  onInstanceCreated?(stats: ItemStatsBuilder): void;

  /**
   * Runs once when the owning definition is accepted by a registry. Definitions
   * register on every machine, so this is where a fragment registers anything
   * every machine must know, such as a damage effect a remote hit names by id.
   */
  onDefinitionRegistered?(): void;

  /**
   * Declares `key` as a stat that may be spent while the item is in use and
   * refilled from other items. The server refuses stat requests for any key no
   * fragment declares, so clients cannot write arbitrary stats.
   */
  statLimit?(key: string): StatLimit | null;

  /** Configuration problems; empty when valid. */
  validate(): string[] {
    return [];
  }
}

export type FragmentClass<T extends ItemFragment> = abstract new (...args: never[]) => T;

export interface ItemDefinitionInit {
  id: string;
  displayName: string;
  /** Dot-separated categories such as `ammo.9mm`; `hasTag('ammo')` matches it. */
  tags?: readonly string[];
  fragments?: readonly ItemFragment[];
}

/** Shared, read-only recipe for an item. Per-instance state lives on `ItemStack`. */
export class ItemDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly tags: readonly string[];
  readonly fragments: readonly ItemFragment[];

  constructor(init: ItemDefinitionInit) {
    this.id = init.id;
    this.displayName = init.displayName;
    this.tags = init.tags ?? [];
    this.fragments = init.fragments ?? [];
  }

  find<T extends ItemFragment>(fragmentClass: FragmentClass<T>): T | null {
    for (const fragment of this.fragments) {
      if (fragment instanceof fragmentClass) {
        return fragment;
      }
    }
    return null;
  }

  hasTag(tag: string): boolean {
    return this.tags.some(own => own === tag || own.startsWith(`${tag}.`));
  }
}

/** Maximum stack size. Items without this fragment stack to 1. Lives here because the registry clamps by it. */
export class Stackable extends ItemFragment {
  constructor(readonly max: number) {
    super();
  }

  override validate(): string[] {
    return Number.isInteger(this.max) && this.max >= 1
      ? []
      : [`max must be an integer >= 1, got ${String(this.max)}`];
  }

  static maxOf(definition: ItemDefinition): number {
    return definition.find(Stackable)?.max ?? 1;
  }
}

/** Problems that keep a definition out of the registry; empty when valid. */
export function validateItemDefinition(definition: ItemDefinition): string[] {
  const errors: string[] = [];
  if (definition.id === '') {
    errors.push('id must not be empty');
  }
  const seen = new Set<unknown>();
  for (const fragment of definition.fragments) {
    const fragmentClass = fragment.constructor;
    if (seen.has(fragmentClass)) {
      errors.push(`duplicate fragment ${fragmentClass.name}`);
    }
    seen.add(fragmentClass);
    for (const error of fragment.validate()) {
      errors.push(`${fragmentClass.name}: ${error}`);
    }
  }
  return errors;
}

/**
 * Item definitions by id. Server and clients import the same definitions, so a
 * replicated `ItemStack` only carries `defId`.
 */
export class ItemRegistry {
  private readonly definitions = new Map<string, ItemDefinition>();

  /** Registers a valid definition; returns the errors that rejected it otherwise. */
  register(definition: ItemDefinition): string[] {
    const errors = validateItemDefinition(definition);
    if (this.definitions.has(definition.id)) {
      errors.push(`id '${definition.id}' is already registered`);
    }
    if (errors.length === 0) {
      this.definitions.set(definition.id, definition);
      for (const fragment of definition.fragments) {
        fragment.onDefinitionRegistered?.();
      }
    }
    return errors;
  }

  get(defId: string): ItemDefinition | null {
    return this.definitions.get(defId) ?? null;
  }

  ids(): string[] {
    return [...this.definitions.keys()];
  }

  /**
   * A brand-new stack with fragment-seeded stats, count clamped to [1, max stack].
   * Null for an unknown definition or a non-positive count.
   */
  createStack(defId: string, count: number, uid: string = newItemUid()): ItemStack | null {
    const definition = this.get(defId);
    if (definition == null || !(count >= 1)) {
      return null;
    }
    const stats = new ItemStatsBuilder();
    for (const fragment of definition.fragments) {
      fragment.onInstanceCreated?.(stats);
    }
    const clamped = Math.min(Math.floor(count), Stackable.maxOf(definition));
    return new ItemStack(uid, defId, clamped, stats.build());
  }
}

export const itemRegistry = new ItemRegistry();

/** Registers into the shared registry at module load; an invalid definition is logged and skipped. */
export function defineItem(definition: ItemDefinition): ItemDefinition {
  const errors = itemRegistry.register(definition);
  if (errors.length > 0) {
    console.error(`[ItemRegistry] '${definition.id}' rejected: ${errors.join('; ')}`);
  }
  return definition;
}
