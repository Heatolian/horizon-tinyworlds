/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v39

import {
  component,
  editor,
  property,
  subscribePropertyChange,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent, StarterPriority} from './BehaviorStarterComponent';
import {ShooterCombatBehavior} from '../CompositeBehaviors/ShooterCombatBehavior';

/** Smallest gap kept between neighbouring range-band edges (m). */
const RANGE_BAND_GAP = 0.5;

/** Smallest gap kept between the retreat and recover thresholds (percent). */
const RECOVER_GAP_PERCENT = 10;

/**
 * Turns an actor holding a gun into a solo-shooter opponent: it spots the
 * player, fights from a preferred range while strafing, ducks behind cover to
 * reload, retreats when badly hurt, and hunts the last known position when it
 * loses sight. See `ShooterCombatBehavior` for the decision order.
 *
 * Unset numbers fall back to the behavior's own defaults (a template instance
 * zero-inits every omitted property). Booleans are named so the zero-init
 * `false` is the usual choice. The labelled properties are live-tunable;
 * `ShooterCombatBehavior` reads them every frame.
 *
 * By default arbitrates at `StarterPriority.Combat`. `startBehavior` returns nothing:
 * `ShooterCombatBehavior` never finishes.
 */
@component({
  description: 'Fights like a shooter-game bot with the gun it holds: spots the player within sight range and line of sight, strafes at a preferred distance while firing, takes cover to reload, retreats when badly hurt, and searches where it last saw its target. Needs a gun in hand (a gun item in its ItemSystem loadout, e.g. rifle plus ammo_556*90); without one it maneuvers but never fires. Targets must carry a matching tag; players are auto-tagged "player". Use instead of Starter Combat Component, not together with it: both drive movement and attacks at the same default priority.',
})
export class StarterShooterCombatComponent extends BehaviorStarterComponent {
  @property()
  // Empty rather than 'player': the editor shows an unset property's default from
  // the initializer text and parses only number and boolean literals.
  @editor({label: 'Target tags', description: 'Comma-separated tags to fight (e.g. "player"). The closest living entity carrying one is the target. Empty means "player". A live edit takes effect at once.'})
  targetTags: string = '';

  @property({minValue: 5, maxValue: 100})
  @editor({label: 'Sight range', description: 'Farthest distance (m) at which the actor can spot its target. The target must also be in line of sight.'})
  sightRange: number = 30;

  @property({minValue: 0, maxValue: 360})
  @editor({label: 'Field of view', description: 'Horizontal view angle (degrees) the target must be inside to be seen. 120 reads as human peripheral vision. 360 disables the check; 0 (or unset) uses the 120 default.'})
  fieldOfViewDeg: number = 120;

  @property({minValue: 1, maxValue: 100})
  @editor({label: 'Max firing distance', description: 'Farthest distance (m) the actor shoots from. Keep it within the weapon range. Capped at the sight range; the fighting distances are capped at this value.'})
  fireRange: number = 25;

  @property({minValue: 1, maxValue: 40})
  @editor({label: 'Closest distance', description: 'Closer than this (m) the actor backs away while fighting.'})
  minRange: number = 6;

  @property({minValue: 2, maxValue: 50})
  @editor({label: 'Preferred distance', description: 'Distance (m) the actor drifts toward while fighting, kept inside the closest and farthest distances.'})
  preferredRange: number = 12;

  @property({minValue: 3, maxValue: 60})
  @editor({label: 'Farthest distance', description: 'Farther than this (m) the actor closes in while fighting.'})
  maxRange: number = 18;

  @property({minValue: 0.5, maxValue: 8})
  @editor({label: 'Move speed', description: 'Speed (m/s) while strafing, taking cover and searching.'})
  moveSpeed: number = 3.5;

  @property({minValue: 0.5, maxValue: 10})
  @editor({label: 'Strafe step', description: 'Sideways distance (m) of each dodge while fighting.'})
  strafeDistance: number = 3;

  @property({minValue: 0, maxValue: 10})
  @editor({label: 'Stuck nudge after', description: 'Seconds of no ground progress after which the actor sidesteps its current waypoint (never the goal) to unstick itself. 0 keeps log-only stall detection.'})
  stuckNudgeSeconds: number = 0;

  @property({minValue: 0.1, maxValue: 5})
  @editor({label: 'Stuck nudge distance', description: 'Sideways distance (m) of each stuck-recovery sidestep.'})
  stuckNudgeDistance: number = 1.0;

  @property({minValue: 0.05, maxValue: 2})
  @editor({label: 'Reaction time', description: 'Fixed delay (s) before the first shot. Used while Use legacy Reaction time is on, when both attention bounds below are 0 and Reaction time is positive, or when the bounds sit at their defaults with a non-default Reaction time here.'})
  reactionTime: number = 0.4;

  @property({minValue: 0, maxValue: 2})
  @editor({label: 'Attention delay min', description: 'Fastest first-notice delay (s). Each new target rolls its own delay between min and max. 0 uses the default — except untouched bounds keep the fixed Reaction time instead of rolling: both bounds at 0 with a positive Reaction time, or the defaults with a tuned Reaction time.'})
  reactionTimeMin: number = 0.1;

  @property({minValue: 0, maxValue: 2})
  @editor({label: 'Attention delay max', description: 'Slowest first-notice delay (s). Each new target rolls its own delay between min and max.'})
  reactionTimeMax: number = 0.5;

  @property()
  @editor({label: 'Use legacy Reaction time', description: 'Use the fixed Reaction time above instead of rolling a delay between the attention bounds.'})
  useLegacyReactionTime: boolean = false;

  @property({minValue: 1, maxValue: 30})
  @editor({label: 'Memory', description: 'Seconds the actor keeps hunting after losing sight of its target.'})
  memorySeconds: number = 6;

  @property({minValue: 0.1, maxValue: 30})
  @editor({label: 'Aim error on first sight', description: 'Cone half-angle (deg) shots can stray on first sight. Shrinks toward the settled aim error while the target stays in view.'})
  maxAimErrorDeg: number = 8;

  @property({minValue: 0.1, maxValue: 15})
  @editor({label: 'Settled aim error', description: 'Cone half-angle (deg) shots can stray once the actor has tracked a still target. Moving targets and moving shooters stray more.'})
  minAimErrorDeg: number = 1.5;

  @property({minValue: 0.1, maxValue: 10})
  @editor({label: 'Aim settle time', description: 'Seconds for the aim error to settle most of the way from first-sight to settled.'})
  aimSettleSeconds: number = 1.5;

  @property({minValue: 0, maxValue: 5})
  @editor({label: 'Min seconds between shots', description: 'Slowest aimed cadence. 0 fires whenever the weapon is ready; a station sets ~1 so each shot reads as deliberate.'})
  minSecondsBetweenShots: number = 0;

  @property({minValue: 5, maxValue: 90})
  @editor({label: 'Retreat at health %', description: 'Health percentage at or below which the actor retreats toward cover.'})
  retreatHealthPercent: number = 30;

  @property({minValue: 10, maxValue: 100})
  @editor({label: 'Return at health %', description: 'Health percentage at which a retreat ends, kept above the retreat percentage. Needs health regen to be reached.'})
  recoverHealthPercent: number = 70;

  @property({minValue: 1, maxValue: 60})
  @editor({label: 'Longest retreat', description: 'Longest retreat in seconds. After it the actor fights on, without retreating again until it heals.'})
  maxRetreatSeconds: number = 8;

  @property({minValue: 0.5, maxValue: 10})
  @editor({label: 'Retreat speed', description: 'Speed (m/s) while retreating.'})
  retreatSpeed: number = 5;

  @property({minValue: 0, maxValue: 50})
  @editor({label: 'Health regen while unseen', description: 'Health per second regained after two seconds out of the target\'s sight. 0 is no regeneration. Needs an ActorGASHealthComponent on the actor; with a plain CharacterGASComponent it stays off.'})
  regenPerSecond: number = 0;

  @property({minValue: 2, maxValue: 30})
  @editor({label: 'Cover search radius', description: 'Radius (m) searched for cover when reloading or retreating.'})
  coverSearchRadius: number = 10;

  @property()
  @editor({label: 'Never retreat', description: 'Fight to the death instead of retreating when hurt.'})
  disableRetreat: boolean = false;

  @property()
  @editor({label: 'Reload in the open', description: 'Keep fighting position while reloading instead of moving to cover.'})
  disableCoverWhileReloading: boolean = false;

  @property()
  @editor({label: 'Hold fire while retreating', description: 'Only run while retreating, instead of shooting back.'})
  holdFireWhileRetreating: boolean = false;

  @property()
  @editor({label: 'Never dodge when hit', description: 'Keep strafing on the reposition timer when shot, instead of sidestepping and hopping at once.'})
  disableDodgeOnDamage: boolean = false;

  @property()
  @editor({label: 'Ignore gunfire and blasts', description: 'Off (default): the actor hears shots and explosions from its targets even when it cannot see them, turns toward the sound and goes looking; it still fires only once it sees the target. On: it reacts to sight and hits only.'})
  disableHearing: boolean = false;

  @property({minValue: 0.25, maxValue: 3})
  @editor({label: 'Hearing range', description: 'At range scale and delivery loudness 1: gunshots within 30 m, explosions within 60 m, or shots within 3 m of the first 100 m of the reported ray. The scale changes distances/radius, not the ray reach.'})
  hearingRangeScale: number = 1.0;

  @property()
  @editor({description: 'Log each tactical mode change ([ShooterCombat] lines) for tuning and debugging. Off keeps the log quiet.'})
  logModeChanges: boolean = false;

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

  protected override locomotionStarterName(): string {
    return 'StarterShooterCombatComponent';
  }

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error(
        '[StarterShooterCombatComponent] No ActorSdkLogicComponent on ' +
          `'${this.controlledActor?.name ?? this.entity.name}', so no combat behavior was started.`,
      );
      return;
    }
    const shooter = new ShooterCombatBehavior();
    shooter.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, StarterPriority.Combat);
    this.applySettings(shooter);
    this.registerBehavior(actorLogic, shooter);
  }

  /**
   * Copies every tunable onto `shooter`, with unset (0) numbers falling back to
   * the behavior's defaults and the range band and health thresholds put back
   * in order.
   */
  private applySettings(shooter: ShooterCombatBehavior): void {
    const d = behaviorDefaults();
    const tags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    shooter.targetTags = tags.length > 0 ? tags : ['player'];
    // Local since D124183996 removed BehaviorStarterComponent.positiveOr: a
    // template instance zero-inits every omitted property, so unset numbers
    // still fall back to the behavior's own defaults here.
    const or = (value: number, fallback: number): number => (value > 0 ? value : fallback);
    // Epsilon for default-matching: a default that crossed a float32
    // boundary is no longer exactly 0.1.
    const closeTo = (value: number, dflt: number): boolean => Math.abs(value - dflt) < 1e-6;
    const sightRange = or(this.sightRange, d.sightRange);
    shooter.sightRange = sightRange;
    shooter.fieldOfViewDeg = this.fieldOfViewDeg > 0 ? this.fieldOfViewDeg : d.fieldOfViewDeg;
    shooter.moveSpeed = or(this.moveSpeed, d.moveSpeed);
    shooter.strafeDistance = or(this.strafeDistance, d.strafeDistance);
    // No `or()` fallback: 0 is a real value here (pace off), and the
    // behavior default is 0 too.
    shooter.minSecondsBetweenShots = Math.max(0, this.minSecondsBetweenShots);
    // No `or()` fallback: 0 is a real value here (nudge off), and the
    // behavior default is 0 too.
    shooter.stuckNudgeSeconds = Math.max(0, this.stuckNudgeSeconds);
    // Untouched reads as the default sidestep: unlike seconds, 0 is not a
    // usable distance here, and the behavior clamps explicit sub-min writes.
    shooter.stuckNudgeDistance = or(this.stuckNudgeDistance, d.stuckNudgeDistance);
    shooter.reactionTime = or(this.reactionTime, d.reactionTime);
    // Legacy reads, all three: the toggle, both bounds 0 with any positive
    // Reaction time (template path, default value included), or default
    // bounds with a tuned Reaction time (scene path). Anything else rolls.
    if (this.useLegacyReactionTime) {
      // Explicit opt-in: a bare (0, 0) pair still reads as unset (see `or`
      // above), so the toggle — or the migration below — is the only way here.
      shooter.reactionTimeMin = 0;
      shooter.reactionTimeMax = 0;
    } else if (
      this.reactionTimeMin === 0 &&
      this.reactionTimeMax === 0 &&
      this.reactionTime > 0
    ) {
      // Migrated tuning: an instance saved before the attention bounds existed
      // carries a Reaction time with untouched (zero) bounds. Rolling the
      // defaults would silently drop that tuning, so it reads as legacy —
      // including a value that happens to equal the default.
      shooter.reactionTimeMin = 0;
      shooter.reactionTimeMax = 0;
    } else if (
      this.reactionTime > 0 &&
      closeTo(this.reactionTimeMin, d.reactionTimeMin) &&
      closeTo(this.reactionTimeMax, d.reactionTimeMax) &&
      !closeTo(this.reactionTime, d.reactionTime)
    ) {
      // Same migrated tuning on the scene path: an instance saved before the
      // bounds existed reads the initializer defaults here (only template
      // instances zero-init), so defaults plus a tuned Reaction time keeps
      // the fixed delay. Defaults with the default Reaction time is a new
      // untouched instance, which rolls below. The positive Reaction time
      // guard matters: a template that sets only the default bounds leaves
      // Reaction time zero-initialized, and zero is unset — not tuned.
      shooter.reactionTimeMin = 0;
      shooter.reactionTimeMax = 0;
    } else {
      shooter.reactionTimeMin = this.reactionTimeMin > 0 ? this.reactionTimeMin : d.reactionTimeMin;
      shooter.reactionTimeMax = this.reactionTimeMax > 0 ? this.reactionTimeMax : d.reactionTimeMax;
      if (shooter.reactionTimeMin > shooter.reactionTimeMax) {
        const tmp = shooter.reactionTimeMin;
        shooter.reactionTimeMin = shooter.reactionTimeMax;
        shooter.reactionTimeMax = tmp;
      }
    }
    shooter.memorySeconds = or(this.memorySeconds, d.memorySeconds);
    shooter.aimSettleSeconds = or(this.aimSettleSeconds, d.aimSettleSeconds);
    shooter.maxRetreatSeconds = or(this.maxRetreatSeconds, d.maxRetreatSeconds);
    shooter.retreatSpeed = or(this.retreatSpeed, d.retreatSpeed);
    shooter.coverSearchRadius = or(this.coverSearchRadius, d.coverSearchRadius);
    shooter.regenPerSecond = Math.max(0, this.regenPerSecond);

    const maxAim = or(this.maxAimErrorDeg, d.maxAimErrorDeg);
    shooter.maxAimErrorDeg = maxAim;
    shooter.minAimErrorDeg = Math.min(or(this.minAimErrorDeg, d.minAimErrorDeg), maxAim);

    // The actor cannot shoot what it cannot see, and the band must sit inside
    // fireRange, or the actor holds a distance it never shoots from (or sees
    // from). sightRange and the weapon's reach win; the band yields.
    const authoredFire = or(this.fireRange, d.fireRange);
    if (authoredFire > sightRange) {
      console.warn(
        `[StarterShooterCombatComponent] '${this.entity.name}': max firing distance ${authoredFire} m is past ` +
          `the sight range ${sightRange} m; capping it at ${sightRange} m.`,
      );
    }
    const fireRange = Math.max(Math.min(authoredFire, sightRange), 2 * RANGE_BAND_GAP);
    const authoredMax = or(this.maxRange, d.maxRange);
    if (authoredMax > fireRange) {
      console.warn(
        `[StarterShooterCombatComponent] '${this.entity.name}': farthest distance ${authoredMax} m is past ` +
          `the max firing distance ${fireRange} m; capping the fighting distances at ${fireRange} m.`,
      );
    }
    const maxRange = Math.min(fireRange, Math.max(authoredMax, 2 * RANGE_BAND_GAP));
    const minRange = Math.max(0, Math.min(or(this.minRange, d.minRange), maxRange - 2 * RANGE_BAND_GAP));
    shooter.fireRange = fireRange;
    shooter.minRange = minRange;
    shooter.maxRange = maxRange;
    shooter.preferredRange = Math.min(
      maxRange - RANGE_BAND_GAP,
      Math.max(minRange + RANGE_BAND_GAP, or(this.preferredRange, d.preferredRange)),
    );

    // Capped so the recover threshold can stay a full gap above it.
    const retreatPercent = this.disableRetreat
      ? 0
      : Math.min(or(this.retreatHealthPercent, d.retreatHealthFraction * 100), 100 - RECOVER_GAP_PERCENT);
    const recoverPercent = Math.min(
      100,
      Math.max(or(this.recoverHealthPercent, d.recoverHealthFraction * 100), retreatPercent + RECOVER_GAP_PERCENT),
    );
    shooter.retreatHealthFraction = retreatPercent / 100;
    shooter.recoverHealthFraction = recoverPercent / 100;

    shooter.logModeChanges = this.logModeChanges;
    shooter.seekCoverWhileReloading = !this.disableCoverWhileReloading;
    shooter.fireWhileRetreating = !this.holdFireWhileRetreating;
    shooter.dodgeOnDamage = !this.disableDodgeOnDamage;
    shooter.hearingEnabled = !this.disableHearing;
    shooter.hearingRangeScale = or(this.hearingRangeScale, d.hearingRangeScale);
  }

  private pushSettings(): void {
    this.pushToRunning<ShooterCombatBehavior>(shooter => this.applySettings(shooter));
  }

  @subscribePropertyChange('targetTags')
  private onTargetTagsChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('sightRange')
  private onSightRangeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('fireRange')
  private onFireRangeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('minRange')
  private onMinRangeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('preferredRange')
  private onPreferredRangeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('maxRange')
  private onMaxRangeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('moveSpeed')
  private onMoveSpeedChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('strafeDistance')
  private onStrafeDistanceChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('stuckNudgeSeconds')
  private onStuckNudgeSecondsChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('stuckNudgeDistance')
  private onStuckNudgeDistanceChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('reactionTime')
  private onReactionTimeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('reactionTimeMin')
  private onReactionTimeMinChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('reactionTimeMax')
  private onReactionTimeMaxChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('useLegacyReactionTime')
  private onUseLegacyReactionTimeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('fieldOfViewDeg')
  private onFieldOfViewChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('memorySeconds')
  private onMemorySecondsChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('maxAimErrorDeg')
  private onMaxAimErrorChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('minAimErrorDeg')
  private onMinAimErrorChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('minSecondsBetweenShots')
  private onMinSecondsBetweenShotsChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('aimSettleSeconds')
  private onAimSettleChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('retreatHealthPercent')
  private onRetreatHealthChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('recoverHealthPercent')
  private onRecoverHealthChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('maxRetreatSeconds')
  private onMaxRetreatChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('retreatSpeed')
  private onRetreatSpeedChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('regenPerSecond')
  private onRegenChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('coverSearchRadius')
  private onCoverSearchRadiusChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('disableRetreat')
  private onDisableRetreatChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('disableCoverWhileReloading')
  private onDisableCoverChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('holdFireWhileRetreating')
  private onHoldFireChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('disableDodgeOnDamage')
  private onDisableDodgeChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('logModeChanges')
  private onLogModeChangesChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('disableHearing')
  private onDisableHearingChanged(): void { this.pushSettings(); }

  @subscribePropertyChange('hearingRangeScale')
  private onHearingRangeScaleChanged(): void { this.pushSettings(); }
}

let defaults: ShooterCombatBehavior | null = null;

/** The behavior's own defaults, used for numbers a template instance left unset. Built on first use. */
function behaviorDefaults(): ShooterCombatBehavior {
  defaults ??= new ShooterCombatBehavior();
  return defaults;
}
