/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v4

import {
  Component,
  component,
  ExecuteOn,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  PlayerService,
  subscribe,
  type Entity,
  type EventSubscription,
} from 'meta/worlds';
import {InputActionsManager, type InputActionChangeEvent} from '../Input/InputActionsManager';
import {TouchControlsHud} from '../Input/TouchControlsHud';
import {characterOf, findOnCharacter} from '../ItemSystem/container/CharacterLookup';
import {dropItem, slot} from '../ItemSystem/container/ItemCommands';
import {EquipmentBinder} from '../ItemSystem/equipment/EquipmentBinder';
import {equippedWeaponOf, type ItemWeapon} from '../ItemSystem/features/Weapon';

const ITEM_BUTTONS = ['Use', 'Reload', 'Drop', 'SwitchWeapon', 'Aim'] as const;
type ItemButton = (typeof ITEM_BUTTONS)[number];

export interface HandState {
  /** The weapon in hand (its `magazine` is null for melee), or null. */
  readonly weapon: {readonly magazine: unknown; readonly aimMode?: string} | null;
  /** The hand's slot holds an item. */
  readonly holding: boolean;
  /** Equippable items in the hand container. */
  readonly equippable: number;
  /** The scene's HUD shows weapon buttons (`TouchControlsHud.weaponButtons`). */
  readonly weaponButtons: boolean;
}

/** Which item buttons apply: Use with a weapon, Reload with a magazine, Drop while holding, SwitchWeapon when there is another item to take, Aim with a scoped weapon. */
export function itemButtonStates(state: HandState): Record<ItemButton, boolean> {
  const {weapon, holding, equippable, weaponButtons} = state;
  return {
    Use: weaponButtons && weapon != null,
    Reload: weaponButtons && weapon?.magazine != null,
    Drop: holding,
    SwitchWeapon: weaponButtons && equippable > (holding ? 1 : 0),
    Aim: weaponButtons && weapon?.aimMode === 'scoped',
  };
}

/**
 * All of the local player's item input. `Use` / `Reload` drive the weapon in
 * hand, `Drop` drops what is in hand, `SwitchWeapon` cycles the hand to the next
 * equippable item (the hand is `EquipmentBinder.hand()`), and `Aim` shows for a
 * scoped weapon (`CrosshairTrigger` reads it). Each
 * `TouchControlsHud` button shows only while it does something; Use and Reload
 * take their icons from the weapon's catalog entry.
 *
 * Component Attachment: the player character root or a child of it (e.g. an `ItemSystem` child).
 */
@component({
  description: 'The local player\'s item input (Use, Reload, Drop, SwitchWeapon) and the touch buttons for them.',
})
export class PlayerItemInput extends Component {
  private character: Entity | null = null;
  private binder: EquipmentBinder | null = null;
  private subscriptions: EventSubscription[] = [];
  private manager: InputActionsManager | null = null;
  private localPlayerResolved = false;
  private isLocalPlayer = false;
  private hud: TouchControlsHud | null = null;
  private shownWeapon: ItemWeapon | null = null;
  private readonly shown = new Map<ItemButton, boolean>();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    this.character = characterOf(this.entity) ?? this.entity;
  }

  /** Polls because the scene's InputActionsManager and HUD may start after this character. */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(): void {
    const character = this.character;
    if (character == null || !NetworkingService.get().isPlayerContext() || !this.resolveLocalPlayer(character)) {
      return;
    }
    if (this.binder == null) {
      this.binder = findOnCharacter(character, EquipmentBinder);
    }
    this.wire(character);
    this.syncButtons(character);
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    if (this.character != null) {
      equippedWeaponOf(this.character)?.releaseTrigger();
    }
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.disconnect();
    }
    this.manager = null;
    if (this.hud != null && TouchControlsHud.instance === this.hud) {
      for (const button of ITEM_BUTTONS) {
        this.hud.hideButton(button);
      }
    }
    this.hud = null;
  }

  private resolveLocalPlayer(character: Entity): boolean {
    if (!this.localPlayerResolved) {
      const localPlayer = PlayerService.get()?.getLocalPlayer() ?? null;
      if (localPlayer == null) {
        return false;
      }
      this.localPlayerResolved = true;
      this.isLocalPlayer = localPlayer === character;
    }
    return this.isLocalPlayer;
  }

  private wire(character: Entity): void {
    const manager = InputActionsManager.instance;
    if (manager === this.manager) {
      return;
    }
    if (this.manager != null) {
      equippedWeaponOf(character)?.releaseTrigger();
    }
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.disconnect();
    }
    this.manager = manager;
    if (manager == null) {
      return;
    }
    const onPress = (action: () => void) => (event: InputActionChangeEvent) => {
      if (event.newValue as boolean) {
        action();
      }
    };
    this.subscriptions.push(
      manager.subscribeAction('Use', (event: InputActionChangeEvent) => {
        const weapon = equippedWeaponOf(character);
        if (event.newValue as boolean) {
          weapon?.pullTrigger();
        } else {
          weapon?.releaseTrigger();
        }
      }),
      manager.subscribeAction('Reload', onPress(() => equippedWeaponOf(character)?.reload())),
      manager.subscribeAction('Drop', onPress(() => this.dropHand(character))),
      manager.subscribeAction('SwitchWeapon', onPress(() => this.switchHand())),
    );
  }

  private dropHand(character: Entity): void {
    const hand = this.binder?.hand() ?? null;
    if (hand?.item != null) {
      void dropItem(character, slot(hand.role, hand.index), hand.item.count);
    }
  }

  private switchHand(): void {
    const hand = this.binder?.hand() ?? null;
    if (hand != null) {
      this.binder?.selectNext(hand.role);
    }
  }

  private syncButtons(character: Entity): void {
    const hud = TouchControlsHud.instance;
    if (hud == null) {
      this.hud = null;
      return;
    }
    if (hud !== this.hud) {
      this.hud = hud;
      this.shown.clear();
      this.shownWeapon = null;
    }
    const weapon = equippedWeaponOf(character);
    const hand = this.binder?.hand() ?? null;
    if (weapon !== this.shownWeapon) {
      this.shownWeapon = weapon;
      hud.setButtonIcon('Use', weapon?.config.fireButtonIcon ?? null);
      hud.setButtonIcon('Reload', weapon?.magazine?.config.reloadButtonIcon ?? null);
    }
    const states = itemButtonStates({
      weapon,
      holding: hand?.item != null,
      equippable: hand != null ? (this.binder?.equippableSlots(hand.role).length ?? 0) : 0,
      weaponButtons: hud.weaponButtons,
    });
    for (const button of ITEM_BUTTONS) {
      this.show(hud, button, states[button]);
    }
  }

  private show(hud: TouchControlsHud, button: ItemButton, visible: boolean): void {
    if (this.shown.get(button) === visible) {
      return;
    }
    this.shown.set(button, visible);
    if (visible) {
      hud.showButton(button);
    } else {
      hud.hideButton(button);
    }
  }
}
