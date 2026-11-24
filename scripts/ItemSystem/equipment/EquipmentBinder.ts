/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v2

import {
  AnimatorComponent,
  Component,
  component,
  editor,
  ExecuteOn,
  OnAnimationEvent,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  property,
  subscribe,
  subscribePropertyChange,
  type Entity,
  type EventSubscription,
  type OnAnimationEventPayload,
} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {characterOf} from '../container/CharacterLookup';
import {ContainerEquipMode, containerRegistry, type ItemContainer} from '../container/ItemContainer';
import {SlotRef} from '../container/ItemRequest';
import {itemRegistry} from '../items/ItemDefinition';
import {relayCharacterAnimationEvent} from './CharacterAnimationEvents';
import {EquipmentController, type EquipContainerState} from './EquipmentController';
import {EquipmentLedger, INVALID_EQUIPMENT_HANDLE} from './EquipmentLedger';
import {EquipmentVisuals} from './EquipmentVisuals';

/**
 * A character's equipment, kept in step with its containers: every container
 * whose `equipMode` is `Selected` (its selected slot) or `All` (every slot)
 * takes effect. Runs everywhere: the owner (player client, or server for an
 * NPC) grants abilities and tags through its `EquipmentLedger` and runs each
 * equipped item's per-frame update; every machine shows the local models.
 * Nothing else equips -- to change what is in effect, change a container or a
 * selection. It also relays the character's animation events to what it has
 * equipped (`CharacterAnimationEvents`).
 *
 * Component Attachment: the character root or a child of it (e.g. an
 * `ItemSystem` child); the character is the nearest ancestor with a
 * `GASComponent`.
 */
@component({
  description:
    'Equips the items in this character\'s containers whose equipMode is Selected or All, and shows their models on every machine.',
})
export class EquipmentBinder extends Component {
  @editor({
    description: 'When an equippable item arrives in a Selected container whose selected slot is empty, select it.',
  })
  @property()
  public autoSelectWhenEmptyHanded: boolean = true;

  /** One entry per `Selected` container, written by the owner and replicated so every machine shows the same models. */
  @editor({show: false})
  @property()
  public selectedSlots: readonly SlotRef[] = [];

  private character: Entity | null = null;
  private ledger: EquipmentLedger | null = null;
  private visuals: EquipmentVisuals | null = null;
  private controller: EquipmentController | null = null;
  private readonly bound = new Map<ItemContainer, BoundContainer>();
  private unsubscribeRegistry: (() => void) | null = null;
  private wasOwned = false;
  private bindPending = false;
  private animationEvents: EventSubscription | null = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    const character = characterOf(this.entity);
    const gas = character?.getComponent(GASComponent) ?? null;
    if (character == null || gas == null) {
      console.error(`[EquipmentBinder] '${String(this.entity.name)}' is not on a character with a GASComponent; nothing can be equipped.`);
      return;
    }
    this.character = character;
    const isOwned = (): boolean => this.entity.isOwned();
    const ledger = new EquipmentLedger(character);
    const visuals = new EquipmentVisuals(character, gas);
    this.ledger = ledger;
    this.visuals = visuals;
    const controller = new EquipmentController({
      registry: itemRegistry,
      equipper: {
        get ready(): boolean {
          return isOwned();
        },
        equip: (definition, source) => (isOwned() ? ledger.equip(definition, source, gas) : INVALID_EQUIPMENT_HANDLE),
        unequip: handle => ledger.unequip(handle),
        isEquipped: handle => ledger.isEquipped(handle),
      },
      isOwner: () => isOwned(),
      showVisual: (key, visual) => visuals.show(key, visual),
      requestSelect: (role, index) => {
        if (isOwned()) {
          this.selectedSlots = [...this.selectedSlots.filter(s => s.role !== role), new SlotRef(role, index)];
          controller.setSelections(this.selectedSlots);
        }
      },
      autoSelectWhenEmptyHanded: this.autoSelectWhenEmptyHanded,
    });
    this.controller = controller;
    const animated = character.getComponent(AnimatorComponent) != null ? character : (character.getChildrenWithComponent(AnimatorComponent, true)[0] ?? null);
    if (animated != null) {
      this.animationEvents = this.subscribe(
        OnAnimationEvent,
        (payload: OnAnimationEventPayload): void => {
          relayCharacterAnimationEvent(character, payload.name);
          visuals.handleAnimationEvent(payload.name);
        },
        animated,
      );
    }
    this.wasOwned = isOwned();
    controller.setSelections(this.selectedSlots);
    // Containers bind on the first update: the character's GAS rebuilds its abilities and tags in its own
    // OnEntityStart, which may run after this one, and would wipe anything equipped now.
    this.bindPending = true;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(): void {
    const {character} = this;
    if (this.ledger == null || character == null) {
      return;
    }
    if (this.bindPending) {
      this.bindPending = false;
      this.unsubscribeRegistry = containerRegistry.subscribe(owner => {
        if (owner === character) {
          this.bindContainers(character);
        }
      });
      this.bindContainers(character);
    }
    const owned = this.entity.isOwned();
    if (owned !== this.wasOwned) {
      this.wasOwned = owned;
      // Ownership can arrive after start; select and equip what the containers already hold.
      if (owned) {
        this.controller?.adoptOwnership();
      }
    }
    if (owned) {
      this.ledger.tick();
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    this.animationEvents?.disconnect();
    this.animationEvents = null;
    for (const {unsubscribe} of this.bound.values()) {
      unsubscribe();
    }
    this.bound.clear();
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    this.controller = null;
    try {
      this.ledger?.clear();
    } finally {
      this.ledger = null;
      this.visuals?.dispose();
      this.visuals = null;
    }
  }

  @subscribePropertyChange('selectedSlots')
  private onSelectionsReplicated(): void {
    this.controller?.setSelections(this.selectedSlots);
  }

  /** Owner only. Selects a slot of a `Selected` container; -1 selects nothing. */
  select(role: string, index: number): boolean {
    return this.controller?.select(role, index) ?? false;
  }

  /** Owner only. Cycles `role` to its next slot holding something equippable. */
  selectNext(role: string): boolean {
    return this.controller?.selectNext(role) ?? false;
  }

  /** Indexes of the slots in `role` holding something equippable. */
  equippableSlots(role: string): number[] {
    return this.controller?.equippableSlots(role) ?? [];
  }

  /** Every `Selected` container with its selected index and item. */
  selections(): ReturnType<EquipmentController['selectedSlots']> {
    return this.controller?.selectedSlots() ?? [];
  }

  /** The hand: the first `Selected` container, its selected index and what that slot holds; null without one. */
  hand(): ReturnType<EquipmentController['selectedSlots']>[number] | null {
    return this.selections()[0] ?? null;
  }

  private bindContainers(character: Entity): void {
    const controller = this.controller;
    if (controller == null) {
      return;
    }
    // Containers destroyed together unregister one at a time, so the registry can
    // still hold a destroyed one here; its properties throw once its entity is gone.
    const wanted = new Set(
      containerRegistry
        .all(character)
        .filter(container => container.entity.valid && container.equipMode !== ContainerEquipMode.None),
    );
    for (const [container, binding] of [...this.bound]) {
      if (!wanted.has(container)) {
        binding.unsubscribe();
        this.bound.delete(container);
        // A replacement with the same role may already have registered; keep its state.
        if (![...wanted].some(other => other.role === binding.role)) {
          controller.removeContainer(binding.role);
        }
      }
    }
    for (const container of wanted) {
      if (this.bound.has(container)) {
        continue;
      }
      const push = (): void => controller.setContainer(stateOf(container));
      this.bound.set(container, {role: container.role, unsubscribe: container.addSlotListener(push)});
      push();
    }
  }
}

/** A container feeding the controller, with the role it was bound under: an unbound container may be destroyed and unreadable. */
interface BoundContainer {
  readonly role: string;
  readonly unsubscribe: () => void;
}

function stateOf(container: ItemContainer): EquipContainerState {
  return {role: container.role, mode: container.equipMode, slots: container.slots()};
}
