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
import {FleeTaggedEntityBehavior} from '../CompositeBehaviors/Tagging/FleeTaggedEntityBehavior';

/**
 * Makes an actor keep its distance from the closest living entity carrying a
 * tag (by default the nearest player), without straying far from where it
 * spawned. By default arbitrates at `StarterPriority.Social`.
 *
 * `startBehavior` returns nothing: `FleeTaggedEntityBehavior` never finishes.
 */
@component({
  description: 'Keeps its distance from the closest entity carrying a matching tag, by default the nearest player, without straying beyond the home radius from where it spawned. At default priorities, combat and tasks on the same actor take priority.',
})
export class StarterKeepAwayComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Comma-separated tags to avoid (e.g. "player", "predator"). The target must carry a matching ActorSdkTagComponent tag (players are auto-tagged "player"). Read when the behavior starts; edits apply on restart. Empty means "player".'})
  avoidTags: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 1, maxValue: 20})
  @editor({label: 'Keep distance', description: 'Distance in meters the actor tries to keep from what it avoids. Tunable live.'})
  keepDistance: number = 8.0;

  @property({minValue: 0.5, maxValue: 10})
  @editor({label: 'Flee speed', description: 'Speed in meters per second while moving away. Tunable live.'})
  fleeSpeed: number = 5.0;

  @property({minValue: 2, maxValue: 50})
  @editor({label: 'Home radius', description: 'Farthest the actor goes from where it spawned, in meters, so it does not flee out of the level. Tunable live.'})
  homeRadius: number = 15.0;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 25;

  protected override locomotionStarterName(): string {
    return 'StarterKeepAwayComponent';
  }

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterKeepAwayComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const tags = this.avoidTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    const keepAway = new FleeTaggedEntityBehavior();
    keepAway.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Social);
    keepAway.targetTags = tags.length > 0 ? tags : ['player'];
    keepAway.fleeDistance = this.keepDistance;
    keepAway.fleeSpeed = this.fleeSpeed;
    keepAway.leashRadius = this.homeRadius;
    this.registerBehavior(actorLogic, keepAway);
  }

  private applyLiveSettings(keepAway: FleeTaggedEntityBehavior): void {
    keepAway.applySettings(this.keepDistance, this.fleeSpeed, this.homeRadius);
  }

  @subscribePropertyChange('keepDistance')
  private onKeepDistanceChanged(): void {
    this.pushToRunning<FleeTaggedEntityBehavior>(keepAway => this.applyLiveSettings(keepAway));
  }

  @subscribePropertyChange('fleeSpeed')
  private onFleeSpeedChanged(): void {
    this.pushToRunning<FleeTaggedEntityBehavior>(keepAway => this.applyLiveSettings(keepAway));
  }

  @subscribePropertyChange('homeRadius')
  private onHomeRadiusChanged(): void {
    this.pushToRunning<FleeTaggedEntityBehavior>(keepAway => this.applyLiveSettings(keepAway));
  }
}
