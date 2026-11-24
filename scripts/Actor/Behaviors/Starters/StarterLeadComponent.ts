/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {
  component,
  editor,
  property,
  subscribePropertyChange,
  TransformComponent,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {LeadBehavior} from '../BaseBehaviors/LeadBehavior';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';

/**
 * Makes an actor walk to a destination, pausing for the player to catch up
 * when they fall behind. By default arbitrates at `StarterPriority.Task`, so combat
 * interrupts it and ambient and social starters yield to it. Finishes on
 * arrival.
 *
 * Most labelled properties are tunable live from the Behaviors tab;
 * `LeadBehavior` reads them every frame. `destinationTag` and
 * `arrivalThreshold` are read when the behavior starts.
 */
@component({
  description: 'Walks to a destination and pauses for the player, or a chosen entity, to catch up if they fall behind. Set destination or destinationTag; the actor does nothing without one. At default priorities, only combat on the same actor takes priority.',
})
export class StarterLeadComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Destination entity. Ignored when destinationTag is set.'})
  destination: Entity | null = null;

  @property()
  @editor({label: 'Destination tag', description: 'Tag naming the destination. Takes precedence over destination. Read when the behavior starts; edits apply on restart.'})
  destinationTag: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.5, maxValue: 6})
  @editor({label: 'Lead speed', description: 'Walk speed (m/s) toward the destination.'})
  leadSpeed: number = 2.0;

  @property({minValue: 0.1, maxValue: 5})
  @editor({label: 'Arrival distance', description: 'Distance (m) at which the destination counts as reached. Read when the behavior starts; edits apply on restart.'})
  arrivalThreshold: number = 1.0;

  @property({minValue: 2, maxValue: 20})
  @editor({
    label: 'Wait when the player is farther than',
    description: 'Player distance (m) at which the actor stops to wait.',
  })
  maxPlayerDistance: number = 8.0;

  @property({minValue: 1, maxValue: 15})
  @editor({
    label: 'Resume when the player is within',
    description: 'Player distance (m) at which the actor resumes, kept at least 1 m inside the wait distance.',
  })
  resumePlayerDistance: number = 4.0;

  /**
   * `false` leads `targetPlayer` instead. While it is unset `LeadBehavior` keeps
   * leading the closest player and warns once, rather than waiting forever.
   */
  @property()
  @editor({
    label: 'Lead the closest player',
    description:
      'Lead whichever player is closest. Turn off to lead the entity chosen in ' +
      '"Lead this entity", or the closest player while none is chosen. Tunable live.',
  })
  followClosestPlayer: boolean = true;

  // Named for its original use; any entity with a transform can be led.
  @property()
  @editor({
    label: 'Lead this entity',
    description:
      'Entity to lead, such as a companion NPC, while "Lead the closest player" is off. ' +
      'Players cannot be chosen here, and choosing this actor or one of its parts is ignored. If the ' +
      'entity is removed from the world, the actor stops and waits for it. Tunable live.',
  })
  targetPlayer: Entity | null = null;

  // Named so that the zero-inited false is the usual flat-ground measurement;
  // counting height stalls a lead on ramps and stairs.
  @property()
  @editor({description: 'Count height difference when measuring player distance. Off measures on the ground plane.'})
  measureHeight: boolean = false;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 45;

  protected override locomotionStarterName(): string {
    return 'StarterLeadComponent';
  }

  override startBehavior(): LeadBehavior | void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterLeadComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }

    const lead = new LeadBehavior();
    lead.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Task);
    lead.arrivalThreshold = this.arrivalThreshold;
    lead.targetPlayer = this.resolvedTargetPlayer();
    lead.use2DDistance = !this.measureHeight;
    this.applyLiveSettings(lead);

    const destinationTag = this.destinationTag.trim();
    if (destinationTag.length > 0) {
      lead.destinationTag = destinationTag;
    } else if (this.destination) {
      const destTransform = this.destination.getComponent(TransformComponent);
      if (!destTransform) {
        console.warn('[StarterLeadComponent] The destination entity has no TransformComponent.');
        return;
      }
      lead.destination = destTransform.worldPosition;
    } else {
      console.warn(
        `[StarterLeadComponent] Neither destination nor destinationTag is set on '${this.entity.name}', ` +
          'so there is nowhere to lead.',
      );
      return;
    }

    this.registerBehavior(actorLogic, lead);
    return lead;
  }

  private applyLiveSettings(lead: LeadBehavior): void {
    lead.leadSpeed = this.leadSpeed;
    lead.maxPlayerDistance = this.maxPlayerDistance;
    lead.resumePlayerDistance = this.resumePlayerDistance;
    lead.followClosestPlayer = this.followClosestPlayer;
  }

  // Leading the actor or a part of it would read a player distance of about 0,
  // so it would never wait for anyone.
  private resolvedTargetPlayer(): Entity | null {
    if (this.targetPlayer != null && this.isOwnActorEntity(this.targetPlayer)) {
      console.warn(
        `[StarterLeadComponent] targetPlayer on '${this.entity.name}' is the actor or part of it; ` +
          'leading the closest player instead.',
      );
      return null;
    }
    return this.targetPlayer;
  }

  @subscribePropertyChange('leadSpeed')
  private onLeadSpeedChanged(): void {
    this.pushToRunning<LeadBehavior>(lead => this.applyLiveSettings(lead));
  }

  @subscribePropertyChange('maxPlayerDistance')
  private onMaxPlayerDistanceChanged(): void {
    this.pushToRunning<LeadBehavior>(lead => this.applyLiveSettings(lead));
  }

  @subscribePropertyChange('resumePlayerDistance')
  private onResumePlayerDistanceChanged(): void {
    this.pushToRunning<LeadBehavior>(lead => this.applyLiveSettings(lead));
  }

  @subscribePropertyChange('followClosestPlayer')
  private onFollowClosestPlayerChanged(): void {
    this.pushToRunning<LeadBehavior>(lead => this.applyLiveSettings(lead));
  }

  @subscribePropertyChange('targetPlayer')
  private onTargetPlayerChanged(): void {
    this.pushToRunning<LeadBehavior>(lead => {
      lead.targetPlayer = this.resolvedTargetPlayer();
    });
  }
}
