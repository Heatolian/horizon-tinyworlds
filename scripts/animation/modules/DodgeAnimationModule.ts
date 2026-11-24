/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v7

import type {Entity} from 'meta/worlds';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';
import {GASComponent} from '../../gas/core/GASComponent';
import {DODGING_TAG} from '../../Character/gas/CharacterTags';
import {DodgeRollAbility} from '../../Character/Abilities/DodgeRollAbility';
import {
  AnimationTag,
  type AnimationContext,
  type AnimationFrame,
  type AnimationModule,
} from './AnimationModule';

const LAYER_NAME = 'Dodge_Roll_Layer';
const ROLL_STATE = 'DodgeRoll';
const REST_STATE = 'empty_state';
/** Graph variable Dodge_Roll_Layer's phaseUpdateGraph reads the roll duration from. */
const DURATION_VARIABLE = 'dodgeDuration';
const DURATION_NET_KEY = 'DodgeDuration';
const ROLL_TRIGGER = 'DodgeRollTrigger';
// Match the empty_state -> DodgeRoll blend authored in Dodge_Roll_Layer.
const ENTER_BLEND_TIME_SEC = 0.1;

/**
 * Plays the dodge-roll one-shot when the owner's GAS raises `state.dodging`.
 *
 * The roll is a trigger rather than a value, so a late joiner does not replay a roll that
 * already finished; the layer's own graph returns it to rest. The duration rides the value
 * channel and is applied before the trigger, because the layer retimes the clip from it.
 * A body whose graph has no Dodge_Roll_Layer (most NPCs) mounts nothing and stays inert.
 */
export class DodgeAnimationModule implements AnimationModule {
  readonly netKeys: readonly string[] = [DURATION_NET_KEY, ROLL_TRIGGER];

  private context!: AnimationContext;
  private mounted: boolean = false;
  private unsubscribeDodgingTag: (() => void) | null = null;
  private characterRoot: Entity | null = null;
  /** Duration to publish ahead of the first roll, on the first tick after mounting. */
  private unpublishedDuration: number | null = null;

  attach(context: AnimationContext): void {
    this.context = context;
    this.mounted = context.mountLayer(LAYER_NAME, {optional: true});
  }

  onCharacterStart(characterRootEntity: Entity): void {
    this.unsubscribeDodgingTag?.();
    this.unsubscribeDodgingTag = null;
    this.unpublishedDuration = null;
    this.characterRoot = characterRootEntity;
    const dodge = characterRootEntity.getComponent(DodgeRollAbility);
    const gas = characterRootEntity.getComponent(GASComponent);
    if (dodge == null || gas == null) {
      return;
    }
    // Published ahead of the first roll as well as with each one: value and trigger ride
    // separate channels, so a proxy could otherwise play its first roll at the graph's default
    // duration.
    this.unpublishedDuration = dodge.rollDodgeDuration;
    this.unsubscribeDodgingTag = gas.onTagAdded((tag: string): void => {
      // Proxies receive the replicated tag too, and an endpoint that subscribed as owner may
      // since have handed ownership on. Only the current owner publishes the roll.
      if (tag === DODGING_TAG && this.mounted && characterRootEntity.isOwned()) {
        this.context.setNet(DURATION_NET_KEY, dodge.rollDodgeDuration);
        this.context.fireNet(ROLL_TRIGGER);
      }
    });
  }

  // Not from `attach`: the host mounts modules before it binds replication, so a publish there
  // would stay local. Proxies take the owner's value through `onNetValue` instead of publishing.
  onUpdate(_frame: AnimationFrame): void {
    if (this.unpublishedDuration == null || !this.mounted) {
      return;
    }
    if (this.characterRoot?.isOwned() === true) {
      this.context.setNet(DURATION_NET_KEY, this.unpublishedDuration);
      this.unpublishedDuration = null;
    }
  }

  onNetValue(key: string, value: ReplicatedValue, _replayed: boolean): void {
    if (key === DURATION_NET_KEY && this.mounted) {
      this.context.setGraphVariable(DURATION_VARIABLE, Number(value));
    }
  }

  // Death outranks the roll, as it does every other one-shot.
  onNetTrigger(key: string): void {
    if (key === ROLL_TRIGGER && this.mounted && !this.context.hasTag(AnimationTag.DEAD)) {
      this.context.playState(LAYER_NAME, ROLL_STATE, {
        startPhase: 0,
        transitionTimeSec: ENTER_BLEND_TIME_SEC,
      });
    }
  }

  onTagsChanged(): void {
    if (this.mounted && this.context.hasTag(AnimationTag.DEAD)) {
      this.context.playState(LAYER_NAME, REST_STATE);
    }
  }
}
