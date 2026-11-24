/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {component, editor, property, subscribePropertyChange, TransformComponent, Vec3} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';
import {LeashBehavior} from '../BaseBehaviors/LeashBehavior';

/**
 * Keeps an actor near a base: once it is more than `leashRadius` from the base
 * it walks back, without attacking, until it is within `arriveRadius`.
 * By default arbitrates at `StarterPriority.Leash`, above combat, so a guard is built
 * from this, `StarterCombatComponent` and `StarterPatrolComponent` with no
 * other wiring. `startBehavior` returns nothing: the leash never finishes.
 */
@component({
  description: 'Walks the actor back to its base when it gets farther than leashRadius from it, without attacking on the way, until it is within arriveRadius again. Unlike the leash radius of Wander and Keep Away, which only limits their own walks, this pulls the actor back from any behavior, including combat. The base is baseEntity, or the spawn point when unset. Add it with a combat starter to keep a guard near its post; give that combat starter a positive engagementRange no larger than leashRadius minus arriveRadius, or the actor loops between chasing and returning.',
})
export class StarterLeashComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Entity marking the base to return to. Empty means the actor\'s spawn point.'})
  baseEntity: Entity | null = null;

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 5, maxValue: 50})
  @editor({label: 'Leash radius', description: 'Distance (meters) from the base at which the actor turns back. Kept at least 1 m beyond the arrive radius. Tunable live.'})
  leashRadius: number = 15.0;

  @property({minValue: 0.5, maxValue: 5})
  @editor({label: 'Arrive radius', description: 'Distance (meters) from the base that counts as back home and ends the return. Tunable live.'})
  arriveRadius: number = 1.5;

  @property({minValue: 0.5, maxValue: 8})
  @editor({label: 'Return speed', description: 'Walking speed in meters per second while returning. Tunable live.'})
  returnSpeed: number = 3.0;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 80;

  protected override locomotionStarterName(): string {
    return 'StarterLeashComponent';
  }

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterLeashComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const leash = new LeashBehavior();
    leash.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Leash);
    leash.basePosition = this.resolveBasePosition();
    leash.leashRadius = this.leashRadius;
    leash.arriveRadius = this.arriveRadius;
    leash.returnSpeed = this.returnSpeed;
    this.registerBehavior(actorLogic, leash);
  }

  private applyLiveSettings(leash: LeashBehavior): void {
    leash.applySettings(this.leashRadius, this.arriveRadius, this.returnSpeed);
  }

  @subscribePropertyChange('leashRadius')
  private onLeashRadiusChanged(): void {
    this.pushToRunning<LeashBehavior>(leash => this.applyLiveSettings(leash));
  }

  @subscribePropertyChange('arriveRadius')
  private onArriveRadiusChanged(): void {
    this.pushToRunning<LeashBehavior>(leash => this.applyLiveSettings(leash));
  }

  @subscribePropertyChange('returnSpeed')
  private onReturnSpeedChanged(): void {
    this.pushToRunning<LeashBehavior>(leash => this.applyLiveSettings(leash));
  }

  private resolveBasePosition(): Vec3 | null {
    const p = this.baseEntity?.getComponent(TransformComponent)?.worldPosition;
    return p ? new Vec3(p.x, p.y, p.z) : null;
  }
}
