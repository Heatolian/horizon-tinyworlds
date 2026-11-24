/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v6

import type {Entity} from 'meta/worlds';
import {CharacterGASComponent} from '../../Character/gas/CharacterGASComponent';
import {
  AnimationAction,
  AnimationTag,
  type AnimationContext,
  type AnimationFrame,
  type AnimationModule,
} from './AnimationModule';
import {OneShotWatchdog} from './OneShotWatchdog';

const LAYER_NAME = 'Take_Damage_Layer';
const REST_STATE = 'empty_state';
const REACTION_STATE = 'TakeDamage';
const TRIGGER_KEY = 'TakeDamageTrigger';
const MASK_FADE_TIME_SEC = 0.15;
// The reaction plays its clip at natural length; this is a ceiling, not the clip length.
const DEFAULT_MAX_REACTION_SEC = 2.0;

/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class DamageAnimationTuning {
  static readonly MAX_REACTION_SEC = 'flinch.maxReactionSec';
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Plays replicated non-lethal hit reactions. */
export class DamageAnimationModule implements AnimationModule {
  readonly actions: readonly string[] = [AnimationAction.FLINCH];
  readonly netKeys: readonly string[] = [TRIGGER_KEY];

  private context!: AnimationContext;
  private unsubscribeDamaged: (() => void) | null = null;
  private maxReactionSec: number = DEFAULT_MAX_REACTION_SEC;
  private readonly watchdog: OneShotWatchdog = new OneShotWatchdog(
    'DamageAnimationModule',
    LAYER_NAME,
    REST_STATE,
  );

  attach(context: AnimationContext): void {
    this.context = context;
    context.mountLayer(LAYER_NAME, {initialMaskWeight: 0});
  }

  onCharacterReady(characterRootEntity: Entity, _simulated: Entity): void {
    this.unsubscribeDamaged?.();
    this.unsubscribeDamaged =
      characterRootEntity
        .getComponent(CharacterGASComponent)
        ?.onDamaged((_amount: number, remainingHealth: number): void => {
          if (remainingHealth > 0) {
            this.request(AnimationAction.FLINCH);
          }
        }) ?? null;
  }

  request(action: string): void {
    if (action === AnimationAction.FLINCH && !this.context.hasTag(AnimationTag.DEAD)) {
      this.context.fireNet(TRIGGER_KEY);
    }
  }

  tune(action: string, key: string, value: number): void {
    if (
      action === AnimationAction.FLINCH &&
      key === DamageAnimationTuning.MAX_REACTION_SEC &&
      value > 0
    ) {
      this.maxReactionSec = value;
    }
  }

  onNetTrigger(key: string): void {
    if (key === TRIGGER_KEY && !this.context.hasTag(AnimationTag.DEAD)) {
      this.context.playState(LAYER_NAME, REACTION_STATE);
      this.watchdog.arm(REACTION_STATE, this.maxReactionSec);
    }
  }

  onTagsChanged(): void {
    if (this.context.hasTag(AnimationTag.DEAD)) {
      this.watchdog.disarm();
      this.context.playState(LAYER_NAME, REST_STATE);
    }
  }

  onUpdate(frame: AnimationFrame): void {
    this.context.setLayerMaskWeight(LAYER_NAME, frame.maskRamp, MASK_FADE_TIME_SEC);
    this.watchdog.tick(this.context, frame.deltaTime);
  }
}
