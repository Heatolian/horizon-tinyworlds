/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v2

import type {Entity, TemplateAsset} from 'meta/worlds';
import {GASAbilityData} from '../../gas/abilities/GASAbilityData';
import type {AbilityConstructor} from '../../gas/abilities/GASAbility';
import type {GASComponent} from '../../gas/core/GASComponent';

/**
 * What caused this equip, usually an item stack. Equipment never interprets
 * it; definitions that need per-item data (a gun's stats) resolve it themselves.
 */
export interface EquipSource {
  readonly uid: string;
  readonly defId: string;
}

export interface EquipContext {
  readonly character: Entity;
  readonly gas: GASComponent;
  readonly source: EquipSource | null;
  /** Unique per equip. Prefix every granted ability and attribute id with it so two equipped items never collide. */
  readonly idPrefix: string;
  /** Runs `tick` every frame on the owner while this stays equipped (a gun's auto fire and auto reload). */
  everyFrame(tick: () => void): void;
}

/** Undoes exactly what one `onEquip` granted, against the GAS it was granted to. */
export type EquipRevoker = () => void;

export interface EquipmentVisual {
  readonly template: TemplateAsset;
  /** Socket entity name on the character rig, e.g. `RightHand`. */
  readonly socket: string;
  /** Animation event the model hides on, e.g. a grenade leaving the hand on `release`. */
  readonly hideOnEvent?: string;
  /** Animation event it shows again on, e.g. the next grenade in hand on `ready`. */
  readonly showOnEvent?: string;
}

/**
 * Read-only recipe for what "this is equipped" means: abilities granted on the
 * owner, the animation key raised as `equipment.{animKey}`, and an optional
 * local visual. Shared across every item that uses it; per-item differences
 * come from `source`.
 */
export abstract class EquipmentDefinition {
  constructor(readonly id: string) {}

  /** Owner only. Grants onto `ctx.gas`; null refuses the equip and must leave nothing granted. */
  abstract onEquip(ctx: EquipContext): EquipRevoker | null;

  /** Animation profile raised as a GAS tag; empty raises none. */
  animKeyFor(_source: EquipSource | null): string {
    return '';
  }

  visualFor(_source: EquipSource | null): EquipmentVisual | null {
    return null;
  }
}

export interface GrantedAbility {
  readonly data: GASAbilityData;
  readonly abilityClass?: AbilityConstructor;
}

export interface AbilitySetEquipmentInit {
  id: string;
  animKey?: string;
  visual?: EquipmentVisual | null;
  abilities: readonly GrantedAbility[];
}

/** Grants a fixed list of abilities. Ability ids are prefixed per equip. */
export class AbilitySetEquipment extends EquipmentDefinition {
  private readonly animKey: string;
  private readonly visual: EquipmentVisual | null;
  readonly abilities: readonly GrantedAbility[];

  constructor(init: AbilitySetEquipmentInit) {
    super(init.id);
    this.animKey = init.animKey ?? '';
    this.visual = init.visual ?? null;
    this.abilities = init.abilities;
  }

  override onEquip(ctx: EquipContext): EquipRevoker {
    const gas = ctx.gas;
    const ids = this.abilities.map(({data, abilityClass}) => {
      const abilityId = `${ctx.idPrefix}${data.abilityId}`;
      gas.grantAbility(new GASAbilityData({...data, abilityId}), abilityClass);
      return abilityId;
    });
    return () => {
      for (const id of ids) {
        gas.removeAbility(id);
      }
    };
  }

  override animKeyFor(): string {
    return this.animKey;
  }

  override visualFor(): EquipmentVisual | null {
    return this.visual;
  }
}
