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
import {AttentionBehavior, AttentionTargetMode} from '../BaseBehaviors/AttentionBehavior';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';

/**
 * Makes an actor turn its whole body to face the closest living entity carrying
 * a tag (by default the nearest player) while it is within range.
 *
 * By default arbitrates at `StarterPriority.Attention`: paired with Wander or Patrol the
 * actor stops and turns to face a player who comes near, while Follow, KeepAway,
 * tasks and combat still win. It claims body direction and movement only while
 * it holds a target, so the ambient starter walks again once the target leaves.
 *
 * Head aim is not used: nothing in this package registers an
 * `ActorLookController`, so idle gaze is switched off.
 */
@component({
  description: 'Turns to face the closest entity carrying a matching tag, by default the nearest player, while it is within range. Pairs with Wander or Patrol: the actor stops to face a player who comes near, then carries on. At default priorities, Follow, Keep Away, tasks and combat on the same actor take priority.',
})
export class StarterLookAtComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Comma-separated tags to face (e.g. "player", "speaker"). The target must carry a matching ActorSdkTagComponent tag. Empty (the default) or "player" alone faces the nearest living player with no tags needed; in a list with other tags, players count only if an ActorSdkManagerComponent in the scene tags them "player". Tunable live.'})
  lookAtTags: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 1, maxValue: 50})
  @editor({label: 'Look range', description: 'Distance in meters within which the actor notices a target. Tunable live.'})
  lookRange: number = 10.0;

  @property({minValue: 30, maxValue: 720})
  @editor({label: 'Turn speed', description: 'How fast the actor turns, in degrees per second. Tunable live.'})
  turnSpeed: number = 180.0;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 15;

  // Returns nothing: AttentionBehavior never finishes, so a handle would only
  // invite a caller to wait for a completion that never arrives.
  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StarterLookAtComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const lookAt = new AttentionBehavior();
    lookAt.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Attention);
    lookAt.turnBodyToTarget = true;
    lookAt.holdPositionWhileFacing = true;
    lookAt.idleGazeEnabled = false;
    this.applySettings(lookAt);
    this.registerBehavior(actorLogic, lookAt);
  }

  private applySettings(lookAt: AttentionBehavior): void {
    const tags = this.lookAtTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    const resolvedTags = tags.length > 0 ? tags : ['player'];
    // Player-only keeps the PlayerService path, which needs no tag producer.
    const playersOnly = resolvedTags.length === 1 && resolvedTags[0] === 'player';
    lookAt.targetMode = playersOnly ? AttentionTargetMode.NearestPlayer : AttentionTargetMode.Tagged;
    lookAt.targetTags = resolvedTags;
    lookAt.attentionRange = this.lookRange;
    lookAt.bodyDirectionAngularSpeed = this.turnSpeed * (Math.PI / 180);
  }

  @subscribePropertyChange('lookAtTags')
  private onLookAtTagsChanged(): void {
    this.pushToRunning<AttentionBehavior>(lookAt => this.applySettings(lookAt));
  }

  @subscribePropertyChange('lookRange')
  private onLookRangeChanged(): void {
    this.pushToRunning<AttentionBehavior>(lookAt => this.applySettings(lookAt));
  }

  @subscribePropertyChange('turnSpeed')
  private onTurnSpeedChanged(): void {
    this.pushToRunning<AttentionBehavior>(lookAt => this.applySettings(lookAt));
  }
}
