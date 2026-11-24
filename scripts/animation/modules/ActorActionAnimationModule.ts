/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v9

import type {Entity} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {
  AnimationAction,
  AnimationTag,
  type AnimationContext,
  type AnimationFrame,
  type AnimationModule,
} from './AnimationModule';
import {OneShotWatchdog, UNRESOLVED_CLIP_CAUSE} from './OneShotWatchdog';

/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class ActorActionTuning {
  static readonly MELEE_DURATION_SEC = 'attack.durationSec';
  static readonly MELEE_COOLDOWN_SEC = 'attack.cooldownSec';
  static readonly RANGED_DURATION_SEC = 'ranged.durationSec';
  static readonly RANGED_COOLDOWN_SEC = 'ranged.cooldownSec';
  static readonly RANGED_MAX_STATE_SEC = 'ranged.maxStateSec';
}
/* eslint-enable @typescript-eslint/naming-convention */

interface ActionConfig {
  readonly action: string;
  readonly layerName: string;
  readonly restState: string;
  readonly stateName: string;
  readonly triggerKey: string;
  readonly interruptKey?: string;
  readonly durationVariable: string;
  readonly cooldownVariable: string;
  readonly durationTuningKey: string;
  readonly cooldownTuningKey: string;
  /**
   * Set when the state plays its clip at natural length, ignoring `durationVariable`; the
   * watchdog then bounds the state by this tuned ceiling instead of the tuned duration.
   */
  readonly maxStateTuningKey?: string;
}

const ACTIONS: readonly ActionConfig[] = [
  {
    action: AnimationAction.MELEE,
    layerName: 'Attack_Layer',
    restState: 'Empty State',
    stateName: 'Attack',
    triggerKey: 'AttackTrigger',
    interruptKey: 'AttackInterruptTrigger',
    durationVariable: 'attackDuration',
    cooldownVariable: 'AttackCooldown',
    durationTuningKey: ActorActionTuning.MELEE_DURATION_SEC,
    cooldownTuningKey: ActorActionTuning.MELEE_COOLDOWN_SEC,
  },
  {
    action: AnimationAction.RANGED,
    layerName: 'Ranged_Layer',
    restState: 'Empty State',
    stateName: 'AttackRanged',
    triggerKey: 'RangedTrigger',
    interruptKey: 'RangedInterruptTrigger',
    durationVariable: 'AttackRangedDuration',
    cooldownVariable: 'AttackRangedCooldown',
    durationTuningKey: ActorActionTuning.RANGED_DURATION_SEC,
    cooldownTuningKey: ActorActionTuning.RANGED_COOLDOWN_SEC,
    maxStateTuningKey: ActorActionTuning.RANGED_MAX_STATE_SEC,
  },
];

/** Equipped items, by `animKey`, whose fire ability plays an actor action rather than an equipment layer: bare hands punch, a caster or a grenadier throws. */
export const ITEM_FIRE_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['fists', AnimationAction.MELEE],
  ['fireball', AnimationAction.RANGED],
  ['grenade', AnimationAction.RANGED],
  ['molotov', AnimationAction.RANGED],
]);

const MASK_FADE_TIME_SEC = 0.15;
const INTERRUPT_TRANSITION_TIME_SEC = 0.08;
const DEFAULT_MAX_STATE_SEC = 2.0;
// Both action graphs leave their state only when the cooldown variable exceeds this.
const EXIT_COOLDOWN_THRESHOLD_SEC = 0.1;

/** Compatibility module for actor melee and projectile gestures. */
export class ActorActionAnimationModule implements AnimationModule {
  readonly actions: readonly string[] = ACTIONS.map((config) => config.action);
  readonly netKeys: readonly string[] = ACTIONS.flatMap((config) =>
    config.interruptKey ? [config.triggerKey, config.interruptKey] : [config.triggerKey],
  );

  private context!: AnimationContext;
  private unsubscribeFire: (() => void) | null = null;
  private readonly mounted: boolean[] = new Array<boolean>(ACTIONS.length).fill(false);
  private readonly tuning: Map<string, number> = new Map<string, number>();
  private readonly watchdogs: readonly OneShotWatchdog[] = ACTIONS.map(
    (config) =>
      new OneShotWatchdog('ActorActionAnimationModule', config.layerName, config.restState),
  );

  attach(context: AnimationContext): void {
    this.context = context;
    ACTIONS.forEach((config, index) => {
      this.mounted[index] = context.mountLayer(config.layerName, {
        optional: true,
        initialMaskWeight: 0,
      });
    });
  }

  /** Item fire abilities are named `{animKey}.item.{defId}...fire` (`weaponKeyOf`). */
  onCharacterReady(characterRootEntity: Entity, _simulated: Entity): void {
    this.unsubscribeFire?.();
    const gas = characterRootEntity.getComponent(GASComponent);
    this.unsubscribeFire =
      gas?.onAbilityActivated((abilityId: string): void => {
        if (!abilityId.endsWith('.fire')) {
          return;
        }
        const action = ITEM_FIRE_ACTIONS.get(abilityId.slice(0, abilityId.indexOf('.')));
        if (action !== undefined) {
          this.request(action);
        }
      }) ?? null;
  }

  request(action: string): void {
    const index = this.actionIndex(action);
    if (index >= 0 && this.mounted[index] && !this.context.hasTag(AnimationTag.DEAD)) {
      this.context.fireNet(ACTIONS[index].triggerKey);
    }
  }

  interrupt(action: string): void {
    const index = this.actionIndex(action);
    if (index < 0 || !this.mounted[index]) {
      return;
    }
    const key = ACTIONS[index].interruptKey;
    if (key !== undefined) {
      this.context.fireNet(key);
    }
  }

  tune(action: string, key: string, value: number): void {
    if (this.actionIndex(action) < 0) {
      return;
    }
    if (!(value > 0) && ACTIONS.some((config) => config.maxStateTuningKey === key)) {
      return;
    }
    this.tuning.set(key, value);
  }

  onNetTrigger(key: string): void {
    const index = ACTIONS.findIndex(
      (config) => config.triggerKey === key || config.interruptKey === key,
    );
    if (index < 0 || !this.mounted[index]) {
      return;
    }
    const config = ACTIONS[index];
    if (key === config.interruptKey) {
      this.watchdogs[index].disarm();
      this.context.playState(config.layerName, config.restState, {
        transitionTimeSec: INTERRUPT_TRANSITION_TIME_SEC,
      });
      return;
    }
    if (this.context.hasTag(AnimationTag.DEAD)) {
      return;
    }
    const durationSec = this.tuning.get(config.durationTuningKey) ?? 1.0;
    const cooldownSec = this.tuning.get(config.cooldownTuningKey) ?? 0.5;
    this.context.setGraphVariable(config.durationVariable, durationSec);
    this.context.setGraphVariable(config.cooldownVariable, cooldownSec);
    this.context.playState(config.layerName, config.stateName);
    const expectedSec =
      config.maxStateTuningKey === undefined
        ? durationSec
        : (this.tuning.get(config.maxStateTuningKey) ?? DEFAULT_MAX_STATE_SEC);
    this.watchdogs[index].arm(
      config.stateName,
      expectedSec,
      cooldownSec > EXIT_COOLDOWN_THRESHOLD_SEC
        ? UNRESOLVED_CLIP_CAUSE
        : `'${config.cooldownVariable}' is ${cooldownSec}, at or below the ${EXIT_COOLDOWN_THRESHOLD_SEC} the exit transition requires`,
    );
  }

  onTagsChanged(): void {
    if (!this.context.hasTag(AnimationTag.DEAD)) {
      return;
    }
    ACTIONS.forEach((config, index) => {
      if (this.mounted[index]) {
        this.watchdogs[index].disarm();
        this.context.playState(config.layerName, config.restState);
      }
    });
  }

  onUpdate(frame: AnimationFrame): void {
    ACTIONS.forEach((config, index) => {
      if (!this.mounted[index]) {
        return;
      }
      this.context.setLayerMaskWeight(config.layerName, frame.maskRamp, MASK_FADE_TIME_SEC);
      this.watchdogs[index].tick(this.context, frame.deltaTime);
    });
  }

  private actionIndex(action: string): number {
    return ACTIONS.findIndex((config) => config.action === action);
  }
}
