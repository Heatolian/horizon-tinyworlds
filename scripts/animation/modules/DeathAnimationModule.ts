/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v8

import type {Entity} from 'meta/worlds';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';
import {GASComponent} from '../../gas/core/GASComponent';
import {DEAD_TAG} from '../../Character/gas/CharacterTags';
import {
  AnimationAction,
  AnimationTag,
  type AnimationContext,
  type AnimationModule,
} from './AnimationModule';

const LAYER_NAME = 'Death_Layer';
const REST_STATE = 'empty_state';
const DEATH_STATE = 'death_state';
const NET_KEY = 'IsDead';

/** Owns the persistent, late-join-safe death pose. */
export class DeathAnimationModule implements AnimationModule {
  readonly actions: readonly string[] = [AnimationAction.DEATH];
  readonly netKeys: readonly string[] = [NET_KEY];

  private context!: AnimationContext;
  private dead: boolean = false;
  private unsubscribeDeathTag: (() => void) | null = null;
  private unsubscribeRespawnTag: (() => void) | null = null;

  attach(context: AnimationContext): void {
    this.context = context;
    context.mountLayer(LAYER_NAME);
  }

  onCharacterReady(characterRootEntity: Entity, _simulated: Entity): void {
    this.unsubscribeDeathTag?.();
    this.unsubscribeRespawnTag?.();
    const gas = characterRootEntity.getComponent(GASComponent);
    this.unsubscribeDeathTag =
      gas?.onTagAdded((tag: string): void => {
        if (tag === DEAD_TAG) {
          this.setActive(AnimationAction.DEATH, true);
        }
      }) ?? null;
    // Respawn clears the tag, and the pose with it.
    this.unsubscribeRespawnTag =
      gas?.onTagRemoved((tag: string): void => {
        if (tag === DEAD_TAG) {
          this.setActive(AnimationAction.DEATH, false);
        }
      }) ?? null;
    if (gas?.hasTag(DEAD_TAG) === true) {
      this.setActive(AnimationAction.DEATH, true);
    }
  }

  setActive(action: string, active: boolean): void {
    if (action === AnimationAction.DEATH) {
      this.context.setNet(NET_KEY, active);
    }
  }

  isActive(action: string): boolean {
    return action === AnimationAction.DEATH && this.dead;
  }

  onNetValue(key: string, value: ReplicatedValue, replayed: boolean): void {
    if (key !== NET_KEY) {
      return;
    }
    const isDead = Boolean(value);
    if (this.dead === isDead) {
      return;
    }
    this.dead = isDead;
    this.context.setTag(AnimationTag.DEAD, isDead);
    if (isDead) {
      this.context.playState(
        LAYER_NAME,
        DEATH_STATE,
        replayed ? {startPhase: 1.0, transitionTimeSec: 0} : undefined,
      );
    } else {
      this.context.playState(LAYER_NAME, REST_STATE);
    }
  }
}
