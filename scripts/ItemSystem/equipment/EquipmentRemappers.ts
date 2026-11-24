/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v2

import type {RemapPageAsset} from 'meta/worlds';

/**
 * The remap page each animation key plays on the shared held-item layer,
 * registered by item definitions as the catalog loads.
 *
 * A leaf like `EquipmentTags`: the item side registers, the animation module
 * reads, and neither imports the other. The catalog loads in the same order on
 * every machine, so a key's index is the same everywhere; that index is what
 * the animation module replicates.
 *
 * Items sharing an animation key share its page. A variant that should play
 * different clips takes its own key.
 */

const keys: string[] = [];
const pages = new Map<string, RemapPageAsset>();

/** False when `animKey` already plays a different page; the first one stays. */
export function registerEquipmentRemapper(animKey: string, page: RemapPageAsset): boolean {
  const existing = pages.get(animKey);
  if (existing != null) {
    return existing === page;
  }
  keys.push(animKey);
  pages.set(animKey, page);
  return true;
}

/** The page registered for `animKey`, or null for a key that plays none. */
export function equipmentRemapperFor(animKey: string): RemapPageAsset | null {
  return pages.get(animKey) ?? null;
}

/** `animKey`'s registration index, or -1 when it plays no page. */
export function equipmentRemapperIndex(animKey: string): number {
  return keys.indexOf(animKey);
}

/** The key registered at `index`, or null. */
export function equipmentRemapperKeyAt(index: number): string | null {
  return keys[index] ?? null;
}
