/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  component,
  editor,
  property,
  subscribePropertyChange,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';
import {EngageCombatBehavior} from '../CompositeBehaviors/EngageCombatBehavior';
import {ActorMovementControllerTypeId} from 'meta/worlds';
import {movesTheBody} from '../../Controllers/Definitions/IActorMovementOccupant';
import {ActorAnimatedAttackComponent} from '../../Controllers/Implementations/ActorAnimatedAttackComponent';


/**
 * Configures an actor to engage the closest tagged target: close to attack
 * range, then attack through whichever attack controller the actor has. It
 * decides who, when and from how far; the controller decides how the attack is
 * delivered, so the same starter drives melee, thrown, spell and gun attacks.
 *
 * All distance properties use **surface-to-surface** semantics — the framework
 * reads both actors' collider radii automatically. Set `maxAttackDistance` to
 * the attack's reach (0.3 = sword, 1.0 = spear, 8 = fireball, 10–15 = gun) and
 * the composite derives all internal follow/attack/hysteresis values.
 *
 * Target resolution is handled by the Actor Tagging System. Ensure
 * ActorSdkTagPlayerService is active to auto-tag players, or use
 * ActorSdkTagComponent to tag custom targets.
 *
 * By default arbitrates at `StarterPriority.Combat`. Formerly `StarterMeleeCombatComponent`,
 * and before that `ActorCombatStarterComponent`: same asset id and property
 * names, minus `combatBasePriority` and `attackFrequency`. Attack cadence is the
 * fire cooldown of the weapon in hand (`fireRate` on BaseActor's `fists` item).
 * `startBehavior` returns nothing: `EngageCombatBehavior` never finishes.
 */
@component({
  description: 'Engages the closest entity carrying a matching tag: closes to attack range, then attacks with whatever attack the actor has, whether melee, ranged, a spell or a held gun. Set maxAttackDistance to that attack\'s reach. Without an attack component the actor only closes in. Acquires at any distance by default; set engagementRange for a dormant, wake-on-approach enemy. The target must carry a matching tag: players are auto-tagged while ActorSdkTagPlayerService is active, anything else needs an ActorSdkTagComponent. All distances are surface-to-surface.',
})
export class StarterCombatComponent extends BehaviorStarterComponent {
  @property()
  @editor({ description: 'Comma-separated tags to target (e.g. "player", "player,enemy"). The actor engages the closest living entity matching any listed tag. Consumer half only — the target entity must ALSO carry a matching ActorSdkTagComponent tag (players auto-tagged "player"), or nothing is acquired. Empty means "player".' })
  targetTags: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.05, maxValue: 30})
  @editor({ label: 'Attack reach', description: 'Maximum surface-to-surface distance (meters) at which the actor can attack: the attack\'s reach. Collider radii are added automatically. Examples: 0.05 = bite, 0.3 = sword, 1.0 = spear, 8 = fireball, 10–15 = gun. Tunable live.' })
  maxAttackDistance: number = 1.5;

  @property({minValue: 0, maxValue: 30})
  @editor({ label: 'Closest attack distance', description: 'Minimum surface-to-surface distance (meters) for attacks. Creates a dead zone when the target is too close. Default 0 (no dead zone). Kept within the attack reach. Tunable live.' })
  minAttackDistance: number = 0;

  @property({minValue: 0, maxValue: 30})
  @editor({ label: 'Preferred attack distance', description: 'Preferred surface-to-surface distance (meters) the actor closes to before it settles, clamped inside the attack band. EngageCombatBehavior.getPreferredStandDistance is the exact contract. Default 0 presses to the INNER band edge, so a melee actor drives up to the target surface. Set a positive value only for an actor that should hold range inside the band. Tunable live.' })
  preferredAttackDistance: number = 0;

  @property({minValue: 0, maxValue: 50})
  @editor({ label: 'Engagement range', description: 'Surface-to-surface distance (meters) for target acquisition and retention. 0 = UNLIMITED: the actor hunts the nearest tagged target from spawn. Set a positive value for a dormant enemy that wakes when a target comes within range. Raised to the attack reach when smaller. Tunable live.' })
  engagementRange: number = 0;

  @property({minValue: 0, maxValue: 8})
  @editor({ label: 'Chase speed', description: 'Movement speed in meters per second when chasing a target. Tunable live. 0 holds position: the actor attacks only what comes within reach.' })
  followSpeed: number = 3.0;

  @property()
  @editor({ label: 'Attack damage', description: 'Damage per attack, for an attack controller that reads the attack payload\'s damage: it flows to EngageCombatBehavior.attackDamage → the payload. ActorAnimatedAttackComponent, the attack controller this package ships, does not read it; tune that actor\'s damage with the `damage` of the GAS weapon it attacks through (e.g. BaseActor\'s fists). With another controller, 0 is a deliberately harmless actor and logs a warning; a template instance stores an unset value as 0, so set it explicitly (e.g. `1` for chip damage, `10` for a fast kill). Read when the behavior starts; edits apply on restart.' })
  attackDamage: number = 1;

  @property()
  @editor({ description: 'Set for a defender that must hold position (turret / wall wizard) built with no ActorTransformMoveComponent — see the "Stationary attacker" section of the making-actors-engage-in-combat skill. Suppresses the missing-movement-controller warning, which would otherwise fire every spawn for that supported setup.' })
  expectStationary: boolean = false;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 70;

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error(
        '[StarterCombatComponent] No ActorSdkLogicComponent on ' +
          `'${this.controlledActor?.name ?? this.entity.name}', so no combat ` +
          'behavior was started.',
      );
      return;
    }

    // A combat actor with no registered ActorMovementController acquires its
    // target and never closes — the only downstream symptom is EngageCombat's
    // pursuit-stall warning, which misattributes to navmesh/collider radii.
    // warn, not error: error severity reaches APP ERROR / hzw_hsr_errors and
    // fails smoketest, and a mover-less actor is a supported configuration.
    // Occupancy is not capability: `ActorJumpController` shares this bucket but
    // cannot move the body, and opts out as an `IActorMovementOccupant`.
    const movers = actorLogic.getControllers(ActorMovementControllerTypeId).filter(movesTheBody);
    if (!this.expectStationary && movers.length === 0) {
      console.warn(
        '[StarterCombatComponent] No ActorMovementController is registered ' +
        "on this actor — it will acquire a target but never move toward it. Add " +
        "ActorTransformMoveComponent to the actor's root entity " +
        '(CharacterAnimationController only drives animation). If the actor ' +
        'is meant to hold position, set expectStationary.',
      );
    }

    const tags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);

    const combat = new EngageCombatBehavior();
    combat.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Combat);
    combat.targetTags = tags.length > 0 ? tags : ['player'];
    this.applyRanges(combat);
    combat.followSpeed = this.getBaseFollowSpeed();
    // A controller that reads `payload.damage` deals exactly this, so 0 means no
    // damage. Warn rather than clamp: 0 stays authorable for a harmless actor.
    combat.attackDamage = this.attackDamage;
    // ActorAnimatedAttackComponent never reads payload damage: it attacks only
    // with the weapon in hand, and warns itself when it can never hold one.
    // Read off the controlled actor, whose attack controller the payload reaches.
    const actor = this.controlledActor;
    if (this.attackDamage === 0 && !actor?.getComponent(ActorAnimatedAttackComponent)) {
      console.warn(
        '[StarterCombatComponent] attackDamage is 0 on ' +
        `'${actor?.name ?? this.entity.name}' — this actor will deal no damage. Set it ` +
        'explicitly on the template instance (a template stores an unset ' +
        'numeric property as 0).',
      );
    }

    this.registerBehavior(actorLogic, combat);
  }

  /**
   * Returns the base follow speed from the template configuration, so callers
   * know the unmodified speed for slow-debuff restoration.
   */
  public getBaseFollowSpeed(): number {
    // 0 is a real setting: stationary attackers author it to hold position.
    return Math.max(0, this.followSpeed);
  }

  private runtimeFollowSpeed: number | null = null;

  /**
   * Overrides the running behavior's follow speed (e.g. a slow debuff). Restore
   * by passing `getBaseFollowSpeed()`. While an override is active, a live
   * `followSpeed` edit waits for that restore instead of cancelling the
   * override. No-op before onStart() or if combat did not start.
   */
  public setRuntimeFollowSpeed(speed: number): void {
    this.runtimeFollowSpeed = speed === this.getBaseFollowSpeed() ? null : speed;
    this.pushToRunning<EngageCombatBehavior>(combat => combat.setFollowSpeed(speed));
  }

  /**
   * Temporarily overrides the combat target to a specific entity. While that
   * entity is dead the actor has no target; it resumes if the entity is revived.
   * Pass null to revert to normal tag-based targeting.
   */
  public setTargetOverride(entity: Entity | null): void {
    this.pushToRunning<EngageCombatBehavior>(combat => combat.setTargetOverride(entity));
  }

  @subscribePropertyChange('followSpeed')
  private onFollowSpeedChanged(): void {
    if (this.runtimeFollowSpeed === null) {
      this.setRuntimeFollowSpeed(this.getBaseFollowSpeed());
    }
  }

  // EngageCombatBehavior re-derives its follow and attack ranges, and its stand
  // distance, from these fields every frame. It raises engagementRange to the reach
  // and keeps the raised value, so every range is re-sent on any live edit; otherwise a lowered reach would leave
  // the range raised. The minimum is kept within the reach and a positive range is
  // raised to it, at start and on every edit, so initialize() never has to correct
  // either with an error.
  private applyRanges(combat: EngageCombatBehavior): void {
    combat.maxAttackDistance = this.maxAttackDistance;
    combat.minAttackDistance = Math.min(this.minAttackDistance, this.maxAttackDistance);
    combat.engagementRange =
      this.engagementRange > 0
        ? Math.max(this.engagementRange, this.maxAttackDistance)
        : this.engagementRange;
    combat.preferredAttackDistance = this.preferredAttackDistance;
  }

  @subscribePropertyChange('maxAttackDistance')
  private onMaxAttackDistanceChanged(): void {
    this.pushToRunning<EngageCombatBehavior>(combat => this.applyRanges(combat));
  }

  @subscribePropertyChange('minAttackDistance')
  private onMinAttackDistanceChanged(): void {
    this.pushToRunning<EngageCombatBehavior>(combat => this.applyRanges(combat));
  }

  @subscribePropertyChange('preferredAttackDistance')
  private onPreferredAttackDistanceChanged(): void {
    this.pushToRunning<EngageCombatBehavior>(combat => this.applyRanges(combat));
  }

  @subscribePropertyChange('engagementRange')
  private onEngagementRangeChanged(): void {
    this.pushToRunning<EngageCombatBehavior>(combat => this.applyRanges(combat));
  }
}
