/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {
  component,
  editor,
  property,
  subscribePropertyChange,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';
import {FollowTaggedEntityBehavior} from '../CompositeBehaviors/Tagging/FollowTaggedEntityBehavior';

const GIVE_UP_RANGE_MIN_GAP = 1.0;

/**
 * Makes an actor follow a chosen entity, or else the closest living entity
 * carrying a tag (by default the nearest player), keeping a set distance. By default arbitrates at
 * `StarterPriority.Social`: combat and tasks take over, ambient wandering
 * fills in when no target is in range.
 *
 * With several players present "closest" can change as they move; owner-based
 * following is a separate, later decision.
 *
 * `startBehavior` returns nothing: `FollowTaggedEntityBehavior` never finishes.
 */
@component({
  description: 'Follows a chosen entity, or else the closest entity carrying a matching tag, by default the nearest player, and keeps a set distance from it. Ignores tagged targets beyond the give-up range and stops following one that moves beyond it. At default priorities, combat and tasks on the same actor take priority.',
})
export class StarterFollowComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Comma-separated tags to follow (e.g. "player", "leader"). The target must carry a matching ActorSdkTagComponent tag (players are auto-tagged "player"). Ignored while followEntity is set. Read when the behavior starts; edits apply on restart. Empty means "player".'})
  followTags: string = '';

  @property()
  @editor({label: 'Follow this entity', description: 'Entity to follow, such as a companion NPC, instead of the closest tagged one. Players cannot be chosen here; leave empty to follow followTags (the closest player by default). Choosing this actor or one of its parts is ignored. The give-up range does not apply. A dead entity is not followed until it revives or is cleared; once it is removed from the world, followTags take over. Tunable live.'})
  followEntity: Entity | null = null;

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.5, maxValue: 10})
  @editor({label: 'Follow distance', description: 'Distance in meters the actor keeps from its target. Tunable live.'})
  followDistance: number = 2.0;

  @property({minValue: 0.5, maxValue: 8})
  @editor({label: 'Follow speed', description: 'Speed in meters per second. Tunable live.'})
  followSpeed: number = 4.0;

  @property({minValue: 0, maxValue: 100})
  @editor({label: 'Give-up range', description: 'Straight-line (3D) distance in meters beyond which targets are neither acquired nor kept: the actor ignores a target farther away and stops following one that moves beyond it. Kept at least 1 m beyond the follow distance, which is measured horizontally, so a large height difference can use up that gap. Tunable live. 0 (or negative) means no limit.'})
  giveUpRange: number = 0;

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
    return 'StarterFollowComponent';
  }

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterFollowComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const tags = this.followTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    const follow = new FollowTaggedEntityBehavior();
    follow.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Social);
    follow.targetTags = tags.length > 0 ? tags : ['player'];
    follow.followRange = this.followDistance;
    follow.followSpeed = this.resolvedSpeed();
    follow.maxRange = this.resolvedGiveUpRange();
    follow.setForcedTarget(this.resolvedFollowEntity());
    this.registerBehavior(actorLogic, follow);
  }

  private resolvedFollowEntity(): Entity | null {
    if (this.followEntity != null && this.isOwnActorEntity(this.followEntity)) {
      console.warn(
        `[StarterFollowComponent] followEntity on '${this.entity.name}' is the actor or part of it; ` +
          'following followTags instead.',
      );
      return null;
    }
    return this.followEntity;
  }

  private resolvedSpeed(): number {
    return this.followSpeed;
  }

  // maxRange gates acquiring and keeping a target, so a positive range sits 1 m
  // past the follow distance; <= 0 must stay 0 (no limit), not hit that floor.
  private resolvedGiveUpRange(): number {
    if (this.giveUpRange <= 0) {
      return 0;
    }
    return Math.max(this.giveUpRange, this.followDistance + GIVE_UP_RANGE_MIN_GAP);
  }

  @subscribePropertyChange('followSpeed')
  private onFollowSpeedChanged(): void {
    this.pushToRunning<FollowTaggedEntityBehavior>(follow => follow.setFollowSpeed(this.resolvedSpeed()));
  }

  @subscribePropertyChange('followEntity')
  private onFollowEntityChanged(): void {
    this.pushToRunning<FollowTaggedEntityBehavior>(follow => follow.setForcedTarget(this.resolvedFollowEntity()));
  }

  @subscribePropertyChange('followDistance')
  private onFollowDistanceChanged(): void {
    this.pushToRunning<FollowTaggedEntityBehavior>(follow => this.pushRanges(follow));
  }

  @subscribePropertyChange('giveUpRange')
  private onGiveUpRangeChanged(): void {
    this.pushToRunning<FollowTaggedEntityBehavior>(follow => this.pushRanges(follow));
  }

  // The inner FollowBehavior and TargetTaggedEntityBehavior copy their ranges
  // at initialize(); applyRuntimeRanges is the path that reaches them. Omitting
  // stuckSettleMaxDistance keeps that gate as configured.
  private pushRanges(follow: FollowTaggedEntityBehavior): void {
    follow.applyRuntimeRanges({
      followRange: this.followDistance,
      maxRange: this.resolvedGiveUpRange(),
      hysteresisRadius: follow.hysteresisRadius,
      distanceToStop: follow.distanceToStop,
    });
  }
}
