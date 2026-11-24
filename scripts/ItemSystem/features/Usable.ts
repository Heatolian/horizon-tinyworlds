/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import {GASComponent} from '../../gas/core/GASComponent';
import type {GASEffectData} from '../../gas/effects/GASEffectData';
import {ItemResult, registerItemRequestHandler, type ItemRequestContext} from '../container/ItemRequest';
import {ItemFragment, itemRegistry} from '../items/ItemDefinition';

export interface UsableConfig {
  /** Applied to the user. Needs an `effectId`: it is registered on every machine and applied by id. */
  effect: GASEffectData;
  /** Items consumed per use. Default 1; 0 for reusable items. */
  consume?: number;
}

/** Using the item from a container applies an effect to its holder (medkit, bandage, stim). */
export class Usable extends ItemFragment {
  constructor(readonly config: UsableConfig) {
    super();
  }

  get consume(): number {
    return this.config.consume ?? 1;
  }

  override onDefinitionRegistered(): void {
    GASComponent.registerEffect(this.config.effect);
  }

  override validate(): string[] {
    const errors: string[] = [];
    if (this.config.effect.effectId === '') {
      errors.push('effect needs an effectId so a remote holder can resolve it');
    }
    if (!Number.isInteger(this.consume) || this.consume < 0) {
      errors.push(`consume must be an integer >= 0, got ${String(this.consume)}`);
    }
    return errors;
  }
}

/**
 * Server: if the slot really holds a usable item, consume it and apply its
 * effect to the character (GAS routes it by id). `amount` is how many items
 * were consumed.
 */
function use({request, containerFor, character}: ItemRequestContext): ItemResult {
  const from = request.slots[0];
  const container = from != null ? containerFor(from.role) : null;
  const stack = container?.getSlot(from.index) ?? null;
  if (container == null || stack == null) {
    return ItemResult.refused('missing');
  }
  const usable = itemRegistry.get(stack.defId)?.find(Usable);
  const gas = character.getComponent(GASComponent);
  if (usable == null || gas == null) {
    return ItemResult.refused('invalid');
  }
  // Checked before removing anything: a partial removal would destroy items and apply nothing.
  if (stack.count < usable.consume) {
    return ItemResult.refused('missing');
  }
  if (usable.consume > 0) {
    container.removeItems(s => s.uid === stack.uid, usable.consume);
  }
  gas.applyEffectToSelf(usable.config.effect);
  return ItemResult.done(usable.consume);
}

registerItemRequestHandler('use', use);
