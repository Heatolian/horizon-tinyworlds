/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v5

import type {Entity, Maybe} from 'meta/worlds';
import type {GASComponent} from '../../gas/core/GASComponent';
import {GameplayCueContext} from '../../gas/cues/GameplayCueContext';
import {GameplayCuePresentation} from '../../gas/cues/GameplayCuePresentation';
import type {IGameplayCueHandler} from '../../gas/cues/IGameplayCueHandler';
import {LocalModel} from '../container/LocalModel';
import type {EquipmentVisual} from './EquipmentDefinition';

/**
 * The socket entity named `socketName` under `root` (bare name or the
 * `_Socket`-suffixed FBX convention); null when the rig has none. Models attach
 * at the socket origin, never at a socket's `AnchorPoint` child: the player
 * rig's hand `AnchorPoint` is offset and rotated for physical grabs. A per-item offset
 * belongs in the item's own template, as its `AnchorPoint` grip.
 */
export function findSocket(root: Entity, socketName: string): Maybe<Entity> {
  const sockets = root.findChildrenWithName(socketName, true);
  if (sockets.length > 0) {
    return sockets[0];
  }
  return root.findChildrenWithName(`${socketName}_Socket`, true)[0] ?? null;
}

interface VisualSlot {
  visual: EquipmentVisual | null;
  readonly model: LocalModel;
}

/**
 * Local-only models of what a character holds, spawned on every machine from
 * replicated state, so equipping never transfers ownership or replicates a
 * mesh. Keyed so several pieces (weapon, armour) can show at once.
 *
 * The template should be a pure visual: it is spawned with networking off and
 * its scripts run on every machine. An `AnchorPoint` child marks the grip.
 * Cues this character emits are forwarded to a `GameplayCuePresentation` on
 * the visual, located at the entity each cue is bound to, so muzzle flashes and
 * fire and reload sounds play from the model. A visual's `hideOnEvent` /
 * `showOnEvent` hide and show its model on the character's animation events.
 * Owned by `EquipmentBinder`.
 */
export class EquipmentVisuals {
  private readonly slots = new Map<string, VisualSlot>();
  private readonly cueRelay: IGameplayCueHandler = {
    tagPrefix: 'cue',
    handleCue: (tag: string, ctx: GameplayCueContext): void => {
      if (ctx.sourceObject !== this.character) {
        return;
      }
      for (const slot of this.slots.values()) {
        const presentation = slot.model.current?.getComponent(GameplayCuePresentation) ?? null;
        // Play where this machine's model has the cue bound (the muzzle), not where the owner aimed from.
        presentation?.handleCue(tag, new GameplayCueContext({...ctx, location: presentation.worldPositionFor(tag) ?? ctx.location}));
      }
    },
  };

  /** Sockets are looked up under `character`; cues come from its `gas`. */
  constructor(
    private readonly character: Entity,
    private readonly gas: GASComponent,
  ) {
    gas.cueManager.registerHandler(this.cueRelay);
  }

  dispose(): void {
    this.gas.cueManager.unregisterHandler(this.cueRelay);
    for (const slot of this.slots.values()) {
      slot.model.dispose();
    }
    this.slots.clear();
  }

  /** Shows `visual` under `key`, replacing what was there; null hides it. Same visual again is a no-op. */
  show(key: string, visual: EquipmentVisual | null): void {
    let slot = this.slots.get(key);
    if (slot == null) {
      slot = {visual: null, model: new LocalModel()};
      this.slots.set(key, slot);
    }
    if (slot.visual === visual) {
      return;
    }
    slot.visual = visual;
    if (visual == null) {
      slot.model.dispose();
      return;
    }
    const socket = findSocket(this.character, visual.socket);
    if (socket == null) {
      console.warn(`[EquipmentVisuals] socket '${visual.socket}' not found on '${String(this.character.name)}'.`);
    }
    slot.model.show(visual.template, socket ?? this.character);
  }

  /**
   * The character's animation event: hides or shows the models whose visual
   * names it. A model hidden on its `hideOnEvent` stays hidden until its
   * `showOnEvent`, or until it is replaced or removed.
   */
  handleAnimationEvent(name: string): void {
    for (const slot of this.slots.values()) {
      const model = slot.model.current;
      if (model == null) {
        continue;
      }
      if (slot.visual?.hideOnEvent === name) {
        model.enabledSelf = false;
      } else if (slot.visual?.showOnEvent === name) {
        model.enabledSelf = true;
      }
    }
  }
}
