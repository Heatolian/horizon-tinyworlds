/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v9

import type {Entity, RemapPageAsset} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {
  equipmentRemapperFor,
  equipmentRemapperIndex,
  equipmentRemapperKeyAt,
} from '../../ItemSystem/equipment/EquipmentRemappers';
import {equipmentTag, equipKeyOf} from '../../ItemSystem/equipment/EquipmentTags';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';
import {CharacterItemRemappers} from '../CharacterItemRemappers';
import {
  AnimationTag,
  type AnimationContext,
  type AnimationModule,
} from './AnimationModule';

const LAYER_NAME = 'InteractionItem_Layer';
const REST_STATE = 'empty state';
const IDLE_STATE = 'idleItem';
const USE_STATE = 'useItem';
const RELOAD_STATE = 'reloadItem';

const HELD_KEY = 'equipment.held';
const USE_KEY = 'equipment.use';
const RELOAD_KEY = 'equipment.reload';
const NOTHING_HELD = -1;
const TRANSITION_TIME_SEC = 0.15;
/** Above the character's own remap pages, so the held item's clips win. */
const REMAPPER_PRIORITY = 200;

/**
 * Plays what the character holds on one shared layer, `InteractionItem_Layer`.
 * The held item's remap page points the layer's generic `idleItem` / `useItem`
 * / `reloadItem` states at its own clips, so a new weapon is a remap page, not
 * a new layer.
 *
 * The owner reads the `equipment.{animKey}` tag and replicates the key as its
 * `EquipmentRemappers` index; every machine then pushes the page onto its own
 * Animator, which is not networked. A character's `CharacterItemRemappers`
 * entry for the key replaces the item's page. A key with no page plays nothing
 * here (bare hands play an actor action instead).
 *
 * The page stays on the Animator after a drop, under a layer faded to rest, and
 * is swapped only when another item takes the hand.
 *
 * The Animator registers only the clips that are already loaded when a page is
 * added, and nothing loads a page's clips ahead of it, so every clip a page
 * names must also be in the character Animator's `animations` list, which loads
 * with the character (`test_weapon_prefabs_guardrail` checks this).
 */
export class EquipmentAnimationModule implements AnimationModule {
  readonly netKeys: readonly string[] = [HELD_KEY, USE_KEY, RELOAD_KEY];

  private context!: AnimationContext;
  private mounted: boolean = false;
  private warnedUnmounted: boolean = false;
  /** Every machine: the replicated key in hand, null when nothing with a page is held. */
  private heldKey: string | null = null;
  /** Every machine: the page on this Animator. */
  private pushed: RemapPageAsset | null = null;
  /** Every machine: the replicated index, kept until the catalog has registered its key. */
  private heldIndex: number = NOTHING_HELD;
  /** Owner only: the key whose tag is raised. */
  private ownerKey: string = '';
  private clearPending: boolean = false;
  private unsubscribe: Array<() => void> = [];
  private characterRemappers: CharacterItemRemappers | null = null;

  attach(context: AnimationContext): void {
    this.context = context;
    this.mounted = context.mountLayer(LAYER_NAME, {
      optional: true,
      initialWeight: 0,
    });
  }

  onCharacterStart(characterRootEntity: Entity): void {
    this.characterRemappers = characterRootEntity.getComponent(CharacterItemRemappers);
  }

  onCharacterReady(characterRootEntity: Entity, _simulated: Entity): void {
    for (const off of this.unsubscribe) {
      off();
    }
    this.unsubscribe = [];

    const gas = characterRootEntity.getComponent(GASComponent);
    if (!gas) {
      return;
    }
    this.unsubscribe.push(
      gas.onTagAdded((tag: string): void => {
        const key = equipKeyOf(tag);
        if (key !== null) {
          this.hold(key);
        }
      }),
      gas.onTagRemoved((tag: string): void => {
        // Deferred to onUpdate: a swap removes the old tag then adds the new one in
        // one call, and an immediate clear would fade the layer out under the new item.
        if (equipKeyOf(tag) === this.ownerKey && this.ownerKey !== '') {
          this.clearPending = true;
        }
      }),
      gas.onAbilityActivated((abilityId: string): void => {
        // Weapon ability ids start with their animKey (`weaponKeyOf`).
        if (this.ownerKey === '' || !abilityId.startsWith(`${this.ownerKey}.`)) {
          return;
        }
        if (abilityId.endsWith('.reload')) {
          this.context.fireNet(RELOAD_KEY);
        } else if (abilityId.endsWith('.fire')) {
          this.context.fireNet(USE_KEY);
        }
      }),
    );

    for (let index = 0; ; index++) {
      const key = equipmentRemapperKeyAt(index);
      if (key === null) {
        break;
      }
      if (gas.hasTag(equipmentTag(key))) {
        this.hold(key);
        break;
      }
    }
  }

  onNetValue(key: string, value: ReplicatedValue, _replayed: boolean): void {
    if (key === HELD_KEY && typeof value === 'number') {
      this.heldIndex = Number.isInteger(value) ? value : NOTHING_HELD;
      this.resolveHeld();
    }
  }

  onNetTrigger(key: string): void {
    if (!this.isShowing() || this.context.hasTag(AnimationTag.DEAD)) {
      return;
    }
    if (key === USE_KEY) {
      this.context.playState(LAYER_NAME, USE_STATE);
    } else if (key === RELOAD_KEY) {
      this.context.playState(LAYER_NAME, RELOAD_STATE);
    }
  }

  onUpdate(): void {
    if (this.clearPending) {
      this.clearPending = false;
      this.ownerKey = '';
      this.context.setNet(HELD_KEY, NOTHING_HELD);
    }
    // An index replayed before the catalog registered its key resolves once it has.
    if (this.heldIndex !== NOTHING_HELD && this.heldKey === null) {
      this.resolveHeld();
    }
  }

  onTagsChanged(): void {
    if (!this.isShowing()) {
      return;
    }
    this.context.playState(
      LAYER_NAME,
      this.context.hasTag(AnimationTag.DEAD) ? REST_STATE : IDLE_STATE,
    );
  }

  /** Owner: `key` is in hand. A key with no page is not replicated. */
  private hold(key: string): void {
    const index = equipmentRemapperIndex(key);
    if (index < 0) {
      return;
    }
    this.clearPending = false;
    this.ownerKey = key;
    this.context.setNet(HELD_KEY, index);
  }

  private resolveHeld(): void {
    const next = this.heldIndex !== NOTHING_HELD ? equipmentRemapperKeyAt(this.heldIndex) : null;
    if (next === this.heldKey) {
      return;
    }
    this.heldKey = next;
    this.apply();
  }

  private pageFor(key: string): RemapPageAsset | null {
    return this.characterRemappers?.remapperFor(key) ?? equipmentRemapperFor(key);
  }

  private isShowing(): boolean {
    return this.mounted && this.heldKey !== null && this.pushed !== null;
  }

  private apply(): void {
    const page = this.heldKey !== null ? this.pageFor(this.heldKey) : null;
    if (page === null) {
      if (this.mounted) {
        this.context.setLayerWeight(LAYER_NAME, 0, TRANSITION_TIME_SEC);
        this.context.playState(LAYER_NAME, REST_STATE);
      }
      return;
    }
    if (!this.mounted) {
      if (!this.warnedUnmounted) {
        this.warnedUnmounted = true;
        console.warn(
          `[EquipmentAnimationModule] '${LAYER_NAME}' is not mounted; held items do not animate.`,
        );
      }
      return;
    }
    if (page !== this.pushed) {
      // Pages are keyed by name, so the outgoing one must leave before the next is added.
      if (this.pushed !== null) {
        this.context.removeRemapper(this.pushed);
      }
      // Before the state request, so idle already samples the item's clips.
      this.context.addRemapper(page, REMAPPER_PRIORITY);
      this.pushed = page;
    }
    this.context.playState(
      LAYER_NAME,
      this.context.hasTag(AnimationTag.DEAD) ? REST_STATE : IDLE_STATE,
      {transitionTimeSec: 0},
    );
    this.context.setLayerWeight(LAYER_NAME, 1, TRANSITION_TIME_SEC);
  }
}
