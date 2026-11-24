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
import {PatrolBehavior} from '../BaseBehaviors/PatrolBehavior';

/**
 * Makes an actor walk a route of tagged waypoints, `<routeTag>_0`,
 * `<routeTag>_1`, ... in order, looping by default. Its default priority is
 * `StarterPriority.Ambient`, so combat, tasks and social starters interrupt it.
 *
 * The route is resolved from the Actor Tagging System when the behavior
 * starts; waypoints carry `ActorSdkTagComponent` tags. Speed, the pause at each
 * stop and looping are read per waypoint, so they are tunable live; the route
 * tag is not. A one-shot route that has finished is no longer running, so
 * clearing `stopAtEnd` then starts a fresh looping patrol.
 */
@component({
  description: 'Walks a route of waypoints in order and loops. Waypoints are entities tagged <routeTag>_0, <routeTag>_1, ... with an ActorSdkTagComponent; routeTag must be set, and the actor does nothing without it. Behaviors with a higher priority take over, and patrolling resumes when they finish.',
})
export class StarterPatrolComponent extends BehaviorStarterComponent {
  @property()
  @editor({label: 'Route tag', description: 'Tag prefix of the waypoints: the route is <routeTag>_0, <routeTag>_1, ... Required; empty means no patrol. Read when the behavior starts; edits apply on restart.'})
  routeTag: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.5, maxValue: 6})
  @editor({label: 'Patrol speed', description: 'Walking speed in meters per second. Tunable live.'})
  patrolSpeed: number = 3.0;

  @property({minValue: 0, maxValue: 30})
  @editor({label: 'Pause at stops', description: 'Seconds to pause at each waypoint. Tunable live. 0 means no pause.'})
  pauseAtStops: number = 0;

  @property()
  @editor({label: 'Stop at end', description: 'Walk the route once and stop at the last waypoint instead of looping. Tunable live: clearing it after the route has finished starts the patrol again.'})
  stopAtEnd: boolean = false;

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
    return 'StarterPatrolComponent';
  }

  override startBehavior(): PatrolBehavior | void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterPatrolComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const routeTag = this.routeTag.trim();
    if (routeTag.length === 0) {
      console.warn(
        `[StarterPatrolComponent] routeTag is empty on '${this.entity.name}', so there is no ` +
          'route to patrol. Set it to the waypoints\' tag prefix (waypoints tagged <routeTag>_0, ' +
          '<routeTag>_1, ...).',
      );
      return;
    }
    const patrol = new PatrolBehavior();
    patrol.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Ambient);
    patrol.patrolTagPrefix = routeTag;
    this.applySettings(patrol);
    this.registerBehavior(actorLogic, patrol);
    return patrol;
  }

  private applySettings(patrol: PatrolBehavior): void {
    patrol.patrolSpeed = this.patrolSpeed;
    patrol.waitTimeAtWaypoint = Math.max(0, this.pauseAtStops);
    patrol.loop = !this.stopAtEnd;
  }

  @subscribePropertyChange('patrolSpeed')
  private onPatrolSpeedChanged(): void {
    this.pushToRunning<PatrolBehavior>(patrol => this.applySettings(patrol));
  }

  @subscribePropertyChange('pauseAtStops')
  private onPauseAtStopsChanged(): void {
    this.pushToRunning<PatrolBehavior>(patrol => this.applySettings(patrol));
  }

  @subscribePropertyChange('stopAtEnd')
  private onStopAtEndChanged(): void {
    if (!this.stopAtEnd && this.autoStart && this.runningBehavior<PatrolBehavior>() === null) {
      this.startBehavior();
      return;
    }
    this.pushToRunning<PatrolBehavior>(patrol => this.applySettings(patrol));
  }
}
