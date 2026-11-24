/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {ContainerEquipMode} from '../container/ItemContainer';
import type {Slot} from '../container/SlotOps';
import {ItemFragment, type ItemRegistry} from '../items/ItemDefinition';
import type {ItemStack} from '../items/ItemStack';
import type {EquipmentDefinition, EquipmentVisual, EquipSource} from './EquipmentDefinition';
import {INVALID_EQUIPMENT_HANDLE, type EquipmentHandle} from './EquipmentLedger';

/**
 * What an item does when it sits in a slot that takes effect (see
 * `ContainerEquipMode`). The only fragment the equipment layer reads; the
 * rest of `equipment/` never sees items.
 */
export class Equippable extends ItemFragment {
  constructor(readonly equipment: EquipmentDefinition) {
    super();
  }
}

/** What the controller drives: the owner's `EquipmentLedger`, plus whether this machine may equip. */
export interface Equipper {
  readonly ready: boolean;
  equip(definition: EquipmentDefinition, source: EquipSource | null): EquipmentHandle;
  unequip(handle: EquipmentHandle): boolean;
  isEquipped(handle: EquipmentHandle): boolean;
}

/** What the controller needs to know about one of the character's containers. */
export interface EquipContainerState {
  readonly role: string;
  readonly mode: ContainerEquipMode;
  readonly slots: readonly Slot[];
}

export interface Selection {
  readonly role: string;
  readonly index: number;
}

export interface EquipmentControllerDeps {
  registry: ItemRegistry;
  equipper: Equipper;
  /** True on the machine that owns the character; only it equips or selects. */
  isOwner: () => boolean;
  /** Shows or hides the model for one equipped slot, keyed per slot. */
  showVisual: (key: string, visual: EquipmentVisual | null) => void;
  /** Owner only: persist a selection. The controller hears back through `setSelections`. */
  requestSelect: (role: string, index: number) => void;
  /** When a new equippable item arrives in a `Selected` container whose selected slot is empty, select it. */
  autoSelectWhenEmptyHanded: boolean;
}

interface Wanted {
  readonly item: ItemStack;
  readonly definition: EquipmentDefinition | null;
}

interface Applied {
  readonly uid: string;
  readonly definition: EquipmentDefinition;
  readonly handle: EquipmentHandle;
}

function slotKey(role: string, index: number): string {
  return `${role}#${index}`;
}

/**
 * Makes what is equipped a function of state: every container whose
 * `equipMode` is not `None`, the selected slot of each `Selected` one, and
 * whether the equipper is ready. Starting kit, pickups, container moves and
 * late joins all just change that state; `refresh` converges whichever input
 * arrives first. Idempotent per slot: the same item stays equipped through
 * stat changes.
 */
export class EquipmentController {
  private readonly containers = new Map<string, EquipContainerState>();
  private readonly selections = new Map<string, number>();
  private readonly applied = new Map<string, Applied>();
  private readonly shown = new Set<string>();

  constructor(private readonly deps: EquipmentControllerDeps) {}

  setContainer(state: EquipContainerState): void {
    const previous = this.containers.get(state.role);
    this.containers.set(state.role, state);
    this.autoSelect(state, previous);
    this.refresh();
  }

  removeContainer(role: string): void {
    if (this.containers.delete(role)) {
      this.refresh();
    }
  }

  /** Replaces all selections, e.g. from the replicated property. */
  setSelections(selections: readonly Selection[]): void {
    this.selections.clear();
    for (const {role, index} of selections) {
      this.selections.set(role, index);
    }
    this.refresh();
  }

  selectedIndex(role: string): number {
    return this.selections.get(role) ?? -1;
  }

  private selectedItem(role: string): ItemStack | null {
    return this.containers.get(role)?.slots[this.selectedIndex(role)] ?? null;
  }

  /** Selected containers in insertion order, with what their selected slot holds. */
  selectedSlots(): Array<Selection & {item: ItemStack | null}> {
    return [...this.containers.values()]
      .filter(state => state.mode === ContainerEquipMode.Selected)
      .map(state => ({role: state.role, index: this.selectedIndex(state.role), item: this.selectedItem(state.role)}));
  }

  /** Owner only. Selects a slot of a `Selected` container; -1 selects nothing. */
  select(role: string, index: number): boolean {
    const state = this.containers.get(role);
    if (
      !this.deps.isOwner() ||
      state == null ||
      state.mode !== ContainerEquipMode.Selected ||
      index < -1 ||
      index >= state.slots.length
    ) {
      return false;
    }
    if (index !== this.selectedIndex(role)) {
      this.deps.requestSelect(role, index);
    }
    return true;
  }

  /** Indexes of the slots in `role` holding something equippable, in slot order. */
  equippableSlots(role: string): number[] {
    const slots = this.containers.get(role)?.slots ?? [];
    return slots.flatMap((item, index) => (item != null && this.equipmentFor(item) != null ? [index] : []));
  }

  /** Owner only. Selects the next slot after the selected one holding something equippable, wrapping; false when there is none other. */
  selectNext(role: string): boolean {
    const candidates = this.equippableSlots(role);
    const current = this.selectedIndex(role);
    const next = candidates.find(index => index > current) ?? candidates[0];
    return next != null && next !== current && this.select(role, next);
  }

  /** Owner only, when this machine has just become the owner: auto-select into empty hands, then equip. */
  adoptOwnership(): void {
    for (const state of this.containers.values()) {
      this.autoSelect(state, /* previous: every item counts as arrived */ undefined);
    }
    this.refresh();
  }

  refresh(): void {
    const wanted = this.wantedSlots();
    this.updateVisuals(wanted);
    if (this.deps.isOwner()) {
      this.reconcile(wanted);
    }
  }

  private wantedSlots(): Map<string, Wanted> {
    const wanted = new Map<string, Wanted>();
    for (const state of this.containers.values()) {
      const indexes =
        state.mode === ContainerEquipMode.All
          ? state.slots.map((_, index) => index)
          : state.mode === ContainerEquipMode.Selected
            ? [this.selectedIndex(state.role)]
            : [];
      for (const index of indexes) {
        const item = state.slots[index] ?? null;
        if (item != null) {
          wanted.set(slotKey(state.role, index), {item, definition: this.equipmentFor(item)});
        }
      }
    }
    return wanted;
  }

  private updateVisuals(wanted: Map<string, Wanted>): void {
    const next = new Set<string>();
    for (const [key, {item, definition}] of wanted) {
      // The stack itself is the source, so definitions that know about items can read its stats.
      const visual = definition?.visualFor(item) ?? null;
      if (visual != null) {
        next.add(key);
      }
      this.deps.showVisual(key, visual);
    }
    for (const key of this.shown) {
      if (!wanted.has(key)) {
        this.deps.showVisual(key, null);
      }
    }
    this.shown.clear();
    for (const key of next) {
      this.shown.add(key);
    }
  }

  private reconcile(wanted: Map<string, Wanted>): void {
    const {equipper} = this.deps;
    const blocked = new Set<string>();
    for (const [key, current] of [...this.applied]) {
      const target = wanted.get(key);
      if (
        target != null &&
        target.item.uid === current.uid &&
        target.definition === current.definition &&
        equipper.isEquipped(current.handle)
      ) {
        continue;
      }
      if (equipper.isEquipped(current.handle) && !equipper.unequip(current.handle)) {
        blocked.add(key);
        continue;
      }
      this.applied.delete(key);
    }
    if (!equipper.ready) {
      return;
    }
    for (const [key, {item, definition}] of wanted) {
      if (definition == null || this.applied.has(key) || blocked.has(key)) {
        continue;
      }
      const handle = equipper.equip(definition, item);
      if (handle !== INVALID_EQUIPMENT_HANDLE) {
        this.applied.set(key, {uid: item.uid, definition, handle});
      }
    }
  }

  private autoSelect(state: EquipContainerState, previous: EquipContainerState | undefined): void {
    if (
      !this.deps.isOwner() ||
      !this.deps.autoSelectWhenEmptyHanded ||
      state.mode !== ContainerEquipMode.Selected ||
      this.selectedItem(state.role) != null
    ) {
      return;
    }
    const previousUids = new Set((previous?.slots ?? []).map(slot => slot?.uid));
    const arrived = state.slots.findIndex(
      slot => slot != null && !previousUids.has(slot.uid) && this.equipmentFor(slot) != null,
    );
    if (arrived !== -1) {
      this.deps.requestSelect(state.role, arrived);
    }
  }

  private equipmentFor(item: ItemStack): EquipmentDefinition | null {
    return this.deps.registry.get(item.defId)?.find(Equippable)?.equipment ?? null;
  }
}
