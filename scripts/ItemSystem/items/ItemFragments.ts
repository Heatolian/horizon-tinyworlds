/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import type {TemplateAsset} from 'meta/worlds';
import {ItemFragment} from './ItemDefinition';
import type {ItemStatsBuilder} from './ItemStack';

/** Adds fixed starting stats to every newly created stack, e.g. `{'item.durability': 100}`. */
export class InitialStats extends ItemFragment {
  constructor(readonly stats: Readonly<Record<string, number>>) {
    super();
  }

  override onInstanceCreated(stats: ItemStatsBuilder): void {
    for (const [key, value] of Object.entries(this.stats)) {
      stats.add(key, value);
    }
  }

  override validate(): string[] {
    const errors: string[] = [];
    for (const [key, value] of Object.entries(this.stats)) {
      if (key === '') {
        errors.push('stat key must not be empty');
      }
      if (!Number.isFinite(value)) {
        errors.push(`stat '${key}' must be finite, got ${String(value)}`);
      }
    }
    return errors;
  }
}

/** How the item looks lying in the world. A pure visual template; loot shows it locally on every machine. */
export class WorldModel extends ItemFragment {
  constructor(readonly template: TemplateAsset) {
    super();
  }
}
