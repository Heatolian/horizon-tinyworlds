/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import type {Entity} from 'meta/worlds';
import {equipmentTag} from './EquipmentTags';
import type {GASComponent} from '../../gas/core/GASComponent';
import type {EquipmentDefinition, EquipRevoker, EquipSource} from './EquipmentDefinition';

/** Receipt for one equip. Ids are never reused, so a stale handle cannot unequip a newer item. */
export type EquipmentHandle = number;

export const INVALID_EQUIPMENT_HANDLE: EquipmentHandle = 0;

export interface EquippedEntry {
  readonly handle: EquipmentHandle;
  readonly definition: EquipmentDefinition;
  readonly source: EquipSource | null;
}

interface AppliedEquipment extends EquippedEntry {
  /** The GAS the grant went into; revocation always goes back there, even if the character has since rebound. */
  readonly gas: GASComponent;
  readonly animTag: string | null;
  readonly revoke: EquipRevoker;
  readonly ticks: ReadonlyArray<() => void>;
}

/**
 * The single place equipment is granted and revoked, on the character's owner:
 * what is equipped and exactly what each equip granted (abilities, the
 * `equipment.{animKey}` tag, per-frame updates). Equip and unequip refuse to
 * nest, so a grant callback cannot re-enter and leave a half-applied record.
 * Pure, so it is tested directly; `EquipmentBinder` drives it.
 */
export class EquipmentLedger {
  private readonly applied = new Map<EquipmentHandle, AppliedEquipment>();
  private nextHandle: EquipmentHandle = 1;
  private busy = false;

  constructor(private readonly character: Entity) {}

  equip(definition: EquipmentDefinition, source: EquipSource | null, gas: GASComponent): EquipmentHandle {
    if (this.busy) {
      console.warn(`[EquipmentLedger] refused nested equip of '${definition.id}'.`);
      return INVALID_EQUIPMENT_HANDLE;
    }
    this.busy = true;
    try {
      const handle = this.nextHandle++;
      const ticks: Array<() => void> = [];
      const revoke = definition.onEquip({
        character: this.character,
        gas,
        source,
        idPrefix: `equip.${handle}.`,
        everyFrame: tick => ticks.push(tick),
      });
      if (revoke == null) {
        return INVALID_EQUIPMENT_HANDLE;
      }
      const animKey = definition.animKeyFor(source);
      const animTag = animKey !== '' ? equipmentTag(animKey) : null;
      if (animTag != null) {
        gas.addLooseTag(animTag);
      }
      this.applied.set(handle, {handle, definition, source, gas, animTag, revoke, ticks});
      return handle;
    } finally {
      this.busy = false;
    }
  }

  /** False for an unknown or stale handle, or when called from inside another equip/unequip. */
  unequip(handle: EquipmentHandle): boolean {
    const entry = this.applied.get(handle);
    if (entry == null) {
      return false;
    }
    if (this.busy) {
      console.warn(`[EquipmentLedger] refused nested unequip of '${entry.definition.id}'.`);
      return false;
    }
    this.busy = true;
    try {
      this.applied.delete(handle);
      this.release(entry);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Runs every `everyFrame` callback of what is equipped. */
  tick(): void {
    for (const entry of [...this.applied.values()]) {
      for (const tick of entry.ticks) {
        tick();
      }
    }
  }

  /** Revokes everything without per-item bookkeeping; for teardown. */
  clear(): void {
    const entries = [...this.applied.values()];
    this.applied.clear();
    for (const entry of entries) {
      this.release(entry);
    }
  }

  get(handle: EquipmentHandle): EquippedEntry | null {
    const entry = this.applied.get(handle);
    return entry != null ? {handle, definition: entry.definition, source: entry.source} : null;
  }

  isEquipped(handle: EquipmentHandle): boolean {
    return this.applied.has(handle);
  }

  get count(): number {
    return this.applied.size;
  }

  private release(entry: AppliedEquipment): void {
    if (entry.animTag != null) {
      entry.gas.removeLooseTag(entry.animTag);
    }
    entry.revoke();
  }
}
