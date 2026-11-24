/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {
  component,
  editor,
  property,
  subscribePropertyChange,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';
import {IdleWanderBehavior} from '../BaseBehaviors/IdleWanderBehavior';

/**
 * Makes an actor wander its spawn area: pause, stroll to a random nearby point,
 * pause again. By default arbitrates at `StarterPriority.Ambient`, the lowest starter role,
 * so behaviors with a higher priority take over and wandering resumes when they
 * let go.
 *
 * Creator-level settings map onto `IdleWanderBehavior`'s ranges: each walk is
 * `wanderRadius / 2 .. wanderRadius` long and each pause is
 * `0.6 .. 1.4 × pauseSeconds`, so a crowd of wanderers does not move in step.
 * Walks and the leash are floored at twice the arrival distance; a shorter walk
 * would count as arrived before it started, and the actor would never move.
 *
 * `startBehavior` returns nothing: `IdleWanderBehavior` never finishes.
 */
@component({
  description: 'Wanders around where it starts: pauses, strolls to a random nearby point, and pauses again, staying within the leash radius of its starting point. Behaviors with a higher priority take over, and wandering resumes when they finish.',
})
export class StarterWanderComponent extends BehaviorStarterComponent {
  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 2, maxValue: 30})
  @editor({label: 'Wander radius', description: 'Longest single walk in meters; each walk is between half this and this. Values below 2 m are raised to 2 m. Tunable live.'})
  wanderRadius: number = 7.0;

  @property({minValue: 0.5, maxValue: 30})
  @editor({label: 'Pause seconds', description: 'Average pause between walks in seconds. Tunable live.'})
  pauseSeconds: number = 7.0;

  @property({minValue: 0.5, maxValue: 6})
  @editor({label: 'Wander speed', description: 'Walking speed in meters per second. Tunable live.'})
  wanderSpeed: number = 2.0;

  @property({minValue: 2, maxValue: 60})
  @editor({label: 'Leash radius', description: 'Farthest each walk ends from where wandering started, in meters. Another behavior can carry the actor beyond it; wandering then walks back inside. Values below 2 m are raised to 2 m. Tunable live.'})
  leashRadius: number = 20.0;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 5;

  protected override locomotionStarterName(): string {
    return 'StarterWanderComponent';
  }

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterWanderComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const wander = new IdleWanderBehavior();
    wander.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Ambient);
    this.applySettings(wander);
    this.registerBehavior(actorLogic, wander);
  }

  private applySettings(wander: IdleWanderBehavior): void {
    const radius = this.wanderRadius;
    const pause = this.pauseSeconds;
    const minWalk = wander.arrivalDistance * 2;
    wander.wanderRadiusMin = Math.max(radius * 0.5, minWalk);
    wander.wanderRadiusMax = Math.max(radius, wander.wanderRadiusMin);
    wander.wanderIntervalMin = pause * 0.6;
    wander.wanderIntervalMax = pause * 1.4;
    wander.wanderSpeed = this.wanderSpeed;
    wander.leashRadius = Math.max(this.leashRadius, minWalk);
  }

  // IdleWanderBehavior reads these at each new walk, so an edit takes effect on
  // the next walk rather than mid-stride.
  @subscribePropertyChange('wanderRadius')
  private onWanderRadiusChanged(): void {
    this.pushToRunning<IdleWanderBehavior>(wander => this.applySettings(wander));
  }

  @subscribePropertyChange('pauseSeconds')
  private onPauseSecondsChanged(): void {
    this.pushToRunning<IdleWanderBehavior>(wander => this.applySettings(wander));
  }

  @subscribePropertyChange('wanderSpeed')
  private onWanderSpeedChanged(): void {
    this.pushToRunning<IdleWanderBehavior>(wander => this.applySettings(wander));
  }

  @subscribePropertyChange('leashRadius')
  private onLeashRadiusChanged(): void {
    this.pushToRunning<IdleWanderBehavior>(wander => this.applySettings(wander));
  }
}
