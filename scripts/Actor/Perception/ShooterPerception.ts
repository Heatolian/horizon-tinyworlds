/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  ActorTaggingBlackboard,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {isDead, TargetTaggedEntityBehavior} from '../Behaviors/BaseBehaviors/Tagging/TargetTaggedEntityBehavior';
import type {TargetInfo} from '../Behaviors/BaseBehaviors/TargetingBehavior';
import {horizontalDistance, type RandomSource} from '../Utilities/ShooterComputations';
import {PhysicsSightQuery, type SightQuery} from './SightQuery';
import {VisionSense} from './VisionSense';
import {PerceptionMemory} from './PerceptionMemory';
import {HearingSense, type Heard, type ListenArgs} from './HearingSense';

// Heard knowledge never outranks a sighting recorded in the same frame.
const HEARD_STRENGTH = 0.5;
// Seconds a rival found hidden is skipped, so the probe moves on to the next
// one in view before trying it again.
const HIDDEN_RIVAL_SECONDS = 1;
// Seconds a rival probe may stay unanswered before it is abandoned (a late
// answer is ignored) and the next one cast.
const RIVAL_PROBE_TIMEOUT_SECONDS = 1;
// How far (m) the shooter or a probed rival may move across the ground while
// the probe's ray is out before its answer no longer describes where they
// stand.
const RIVAL_PROBE_MOVE_TOLERANCE = 0.25;

/**
 * Shooter sensing: acquisition, sight and memory, behind one polled surface.
 *
 * Four parts: `StickyTargeting` picks the target, `VisionSense` tests
 * whether it is seen, `HearingSense` hears gunfire and explosions it cannot
 * see, and `PerceptionMemory` integrates every sense into lasting knowledge.
 * Damage and hearing write memory as stimuli, never sight. What anyone does
 * about what is known stays in the behavior.
 *
 * Polled: the behavior forwards its knobs (which stay live-tunable through
 * the starter) and calls `update` every frame, then reads the surface below.
 * `keepHunting`/`onForget` are the two seams back into decision state: while
 * the behavior keeps hunting a lost target its memory pins instead of
 * expiring, and forgetting one also drops decision state (cornering, cover)
 * that belonged to it.
 */
export class ShooterPerception {
  // ── Knobs (forwarded by the behavior every frame) ────────────────────

  /** Tags to hunt; the closest living tagged entity is the target. */
  targetTags: string[] = ['player'];
  /** Farthest the shooter can see (m). 0 = unlimited. */
  sightRange: number = 30;
  /**
   * Horizontal field of view (deg) the target must be inside to be seen.
   * 120 reads as human peripheral vision. 0 or >= 360 disables the check, so a
   * turret-style bot still notices in every direction.
   */
  fieldOfViewDeg: number = 120;
  /**
   * Seconds the target must stay visible before the first shot. Legacy fixed
   * delay, used only while both `reactionTimeMin` and `reactionTimeMax` are
   * unset.
   */
  reactionTime: number = 0.4;
  /**
   * Bounds (s) of the per-acquisition attention delay: each new target rolls
   * its own delay in [min, max], so one bot reacts in 100 ms and the next in
   * 500 ms. Crossed bounds are ordered at roll time; both unset falls back to
   * `reactionTime`.
   */
  reactionTimeMin: number = 0.1;
  reactionTimeMax: number = 0.5;
  /** Seconds the shooter keeps hunting after losing sight. */
  memorySeconds: number = 6;
  /**
   * Seconds between line-of-sight queries. What the shooter sees lags the
   * world by up to this long; the weapon's own ray decides what a shot hits.
   */
  sightCheckInterval: number = 0.15;
  /** Height (m) above the shooter's root its shots leave from. */
  eyeHeight: number = 1.0;
  /** Height (m) above the target's root the shooter aims at. */
  targetAimHeight: number = 1.0;
  /**
   * Seconds Engage holds after the target drops out of sight before switching
   * to Search, so one blocked ray (another character crossing the line) does
   * not flip the mode. No shots are fired while the target is unseen.
   */
  lostSightGraceSeconds: number = 0.5;
  /** Line-of-sight oracle. Replaced in tests. */
  sightQuery: SightQuery = new PhysicsSightQuery();
  /** Random source for attention rolls. Replaced in tests. */
  random: RandomSource = Math.random;
  /** Off: gunfire and explosions are not heard. */
  hearingEnabled: boolean = true;
  /** Scales every hearing radius. */
  hearingRangeScale: number = 1;

  /** While true with a last known position, memory pins instead of expiring. */
  keepHunting: () => boolean = () => false;
  /** Runs when a target is forgotten; the behavior drops decision state there. */
  onForget: () => void = () => undefined;

  // ── Read surface ──────────────────────────────────────────────────────

  /** Target being hunted, or null. */
  target: Entity | null = null;
  /** True while the shooter knows of its target (seen or stimmed within `memorySeconds`). */
  get aware(): boolean {
    return this.memory.aware;
  }
  /** True while the latest line-of-sight answer says the target is visible and in sight range. */
  get visible(): boolean {
    return this.vision.visible;
  }
  /** Seconds the target has been continuously visible. */
  get visibleSeconds(): number {
    return this.vision.visibleSeconds;
  }
  /** Seconds since the last stimulus of any kind. */
  get secondsSinceSeen(): number {
    return this.memory.secondsSinceSeen;
  }
  /** Seconds since the target was actually visible; a stimulus does not reset it. */
  get secondsSinceVisible(): number {
    return this.vision.secondsSinceVisible;
  }
  /** Where the target was last seen (or stimmed). */
  get lastKnownPosition(): Vec3 | null {
    return this.memory.lastKnownPosition;
  }
  set lastKnownPosition(value: Vec3 | null) {
    this.memory.lastKnownPosition = value;
  }
  /** This target's rolled attention delay (s); re-rolled per sighting. */
  get attentionDelay(): number {
    return this.vision.attentionDelay;
  }

  /** The acquisition's shared target info (smoothed position/velocity). */
  get targetInfo(): TargetInfo {
    return this.sticky.targetInfo;
  }

  /** True once `initialize` has run. */
  get initialized(): boolean {
    return this.behaviorManager != null;
  }

  private behaviorManager: ActorBehaviorManager | null = null;
  private readonly sticky = new StickyTargeting();
  private readonly vision = new VisionSense();
  private readonly memory = new PerceptionMemory();
  /** The hearing sense; its noise source is replaced in tests. */
  readonly hearing: HearingSense = new HearingSense();
  // A heard instigator that is not yet the target: recorded once it is,
  // because a target change wipes memory first.
  private pendingHeard: Heard | null = null;
  // The target the probe state below belongs to: the current target while it
  // is held by preference (a heard instigator, a hit's attacker, a rival).
  private heldTarget: Entity | null = null;
  // Seconds the held target has been out of view since the hold began.
  private heldUnseenSeconds = 0;
  // Rivals in view that a probe found hidden, each skipped until its own time
  // on `rivalClock` (seconds held) passes.
  private readonly hiddenRivals = new Map<Entity, number>();
  // Refilled per probe: the rivals to skip, the held target among them.
  private readonly rivalSkip = new Set<Entity>();
  private rivalClock = 0;
  private rivalTimer = 0;
  private rivalPending = false;
  private rivalPendingSeconds = 0;
  // Bumped whenever a pending rival probe's answer no longer applies.
  private rivalToken = 0;
  // A rival a probe saw, preferred but not yet the target: recorded once it
  // is, so the shooter knows it before the held shooter's next round.
  private pendingRival: Entity | null = null;
  // Reused by the hearing poll, which runs every frame: a fresh args object
  // and closure per poll would allocate into the 72 Hz loop.
  private readonly rootOf = (entity: Entity): Entity | null => this.sticky.taggedRootOf(entity);
  private listenArgs: ListenArgs | null = null;

  initialize(behaviorManager: ActorBehaviorManager, self: Entity): void {
    this.behaviorManager = behaviorManager;

    const sticky = this.sticky;
    sticky.keepCurrent = () => this.aware;
    sticky.currentInView = () => this.visible;
    // Unlimited: sight range and line of sight gate perception, not acquisition,
    // so a target behind a wall can still be searched for and found.
    sticky.maxRange = 0;
    sticky.initialize(behaviorManager);

    this.vision.initialize(self);
    // Stable for life: the closures below read the facade fields live, so a
    // behavior that replaces them (or the tests) needs no re-wiring.
    this.memory.keepHunting = () => this.keepHunting();
    this.memory.onForget = () => this.onForget();
  }

  update(dt: number, self: Entity, selfPos: Vec3): void {
    if (!this.behaviorManager) {
      return;
    }
    const sticky = this.sticky;
    // Re-read every frame, so a live edit of the tags takes effect.
    sticky.targetTags = this.targetTags;
    // The pick itself is cone-aware: without this the closest tagged entity
    // wins in any direction, and a nearer target behind the back hides a
    // farther one the bot could see. The held target stays exempt inside
    // resolveTarget, so this only steers the pick among new candidates.
    sticky.viewAngleDeg = this.fieldOfViewDeg;
    sticky.update(dt);
    const info = sticky.targetInfo;
    const target = info.isValid ? info.targetEntity : null;
    if (target !== this.target) {
      this.target = target;
      // What was known about the previous target says nothing about this one.
      // The attention roll moved into vision: the entity rarely changes
      // (sticky targeting holds it), so rolling on change reuses one roll —
      // and ignores live edits — for the whole sighting history.
      this.vision.reset();
      this.memory.forgetMemory();
      this.dropHold();
    }
    const targetPos = target ? info.rawPosition : null;

    this.forwardSenses();
    this.vision.update(dt, self, selfPos, target, targetPos);
    this.memory.observe(dt, this.vision.visible, target, targetPos);
    this.landRival(target, targetPos);
    this.updateHearing(self, selfPos);
    this.probeRivals(dt, self, selfPos);
  }

  /**
   * Hearing the target writes where it was heard; its shots win over fresher
   * ones from others in the same frame. A blast marks where the charge went
   * off, not where its thrower stands, so it only alerts a shooter that knows
   * nothing; it never moves a known target's last position. Hearing another huntable instigator
   * turns to it only while nothing is known of the current target (never
   * during the lost-sight grace, which memory still covers) and no switch is
   * pending or held by preference (a hit's attacker landing this frame, whose
   * switch wiped memory before the hit is recorded), so two unseen shooters
   * cannot flip the target on every shot. The instigator becomes the
   * target next frame, and only then is the event recorded, since a target
   * change wipes memory. That target is then held by preference while unseen,
   * whatever its distance, until a rival in view proves visible
   * (`probeRivals`) or it is forgotten.
   */
  private updateHearing(self: Entity, selfPos: Vec3): void {
    const pending = this.pendingHeard;
    if (pending) {
      if (this.target === pending.instigatorRoot) {
        this.recordHeard(pending);
        this.pendingHeard = null;
      } else if (!this.sticky.isPreferring(pending.instigatorRoot)) {
        this.pendingHeard = null;
      }
    }
    let args = this.listenArgs;
    if (args == null) {
      args = {self, selfPos, rootOf: this.rootOf, prefer: this.target};
      this.listenArgs = args;
    }
    args.self = self;
    args.selfPos = selfPos;
    args.prefer = this.target;
    const heard = this.hearing.poll(args);
    if (!heard) {
      return;
    }
    if (heard.kind === 'explosion' && this.memory.aware) {
      return;
    }
    if (heard.instigatorRoot === this.target) {
      this.recordHeard(heard);
    } else if (!this.memory.aware && !this.sticky.hasPreference()) {
      this.sticky.prefer(heard.instigatorRoot);
      this.pendingHeard = heard;
    }
  }

  /**
   * A target held by preference (a heard instigator, a hit's attacker, a
   * rival it turned to) is kept whatever its distance while it is known, and
   * every round heard from it keeps it known, so out of view it would keep
   * every other candidate out for as long as it keeps firing. So once it has
   * been out of view for the lost-sight grace (time for sight to find a
   * target just turned to), the closest other candidate in view (in range and
   * in the cone) is probed at the sight-check cadence with the same
   * clear-shot ray as sight; one the shooter can see takes over. A rival
   * found hidden (a nearer enemy behind a wall, the case the preference
   * exists for) is skipped for a while, so the probe moves on to the next one.
   */
  private probeRivals(dt: number, self: Entity, selfPos: Vec3): void {
    const target = this.target;
    const held = target != null && this.sticky.isPreferring(target) ? target : null;
    if (held !== this.heldTarget) {
      this.dropHold();
      this.heldTarget = held;
    }
    if (held == null) {
      return;
    }
    this.heldUnseenSeconds = this.vision.visible ? 0 : this.heldUnseenSeconds + dt;
    this.rivalClock += dt;
    this.rivalTimer -= dt;
    if (this.rivalPending) {
      this.rivalPendingSeconds += dt;
      if (this.rivalPendingSeconds < RIVAL_PROBE_TIMEOUT_SECONDS) {
        return;
      }
      // A query that never settles must not stop the probing for good.
      this.rivalPending = false;
      this.rivalToken++;
    }
    if (this.heldUnseenSeconds < this.lostSightGraceSeconds || this.rivalTimer > 0) {
      return;
    }
    this.rivalTimer = this.sightCheckInterval;
    const skip = this.rivalSkip;
    skip.clear();
    for (const [hidden, until] of this.hiddenRivals) {
      if (until <= this.rivalClock) {
        this.hiddenRivals.delete(hidden);
      } else {
        skip.add(hidden);
      }
    }
    skip.add(held);
    const rival = this.sticky.noticedExcept(skip);
    skip.clear();
    const rivalPos = rival?.getComponent(TransformComponent)?.worldPosition ?? null;
    if (!rival || !rivalPos || (this.sightRange > 0 && horizontalDistance(selfPos, rivalPos) > this.sightRange)) {
      return;
    }
    this.rivalPending = true;
    this.rivalPendingSeconds = 0;
    const probe: RivalProbe = {
      token: this.rivalToken,
      self,
      selfWas: new Vec3(selfPos.x, selfPos.y, selfPos.z),
      rival,
      rivalWas: new Vec3(rivalPos.x, rivalPos.y, rivalPos.z),
    };
    const from = selfPos.add(new Vec3(0, this.eyeHeight, 0));
    const to = rivalPos.add(new Vec3(0, this.targetAimHeight, 0));
    this.sightQuery.hasClearShot(from, to, self, rival).then(
      clear => this.onRivalProbed(probe, clear),
      () => this.onRivalProbed(probe, false),
    );
  }

  private onRivalProbed(probe: RivalProbe, clear: boolean): void {
    const {token, self, selfWas, rival, rivalWas} = probe;
    if (token !== this.rivalToken) {
      return;
    }
    this.rivalPending = false;
    // Only while the hold still stands and its target is unseen: a held
    // target that came into view is fought, and a preference that moved on
    // (a hit turning the shooter to its attacker) is not overridden.
    const held = this.heldTarget;
    if (held == null || held !== this.target || !this.sticky.isPreferring(held) || this.vision.visible) {
      return;
    }
    // Dead, destroyed or untagged while the ray was out: nothing to turn to,
    // and the hold stays.
    if (!this.sticky.isStillTargetable(rival)) {
      return;
    }
    // The ray describes where both stood when it went out. If either has
    // moved since (the rival stepping behind cover), the answer is stale
    // either way: drop it and let the next probe ask again.
    if (movedSince(self, selfWas) || movedSince(rival, rivalWas)) {
      return;
    }
    if (!clear) {
      this.hiddenRivals.set(rival, this.rivalClock + HIDDEN_RIVAL_SECONDS);
      return;
    }
    this.sticky.prefer(rival);
    this.pendingRival = rival;
    this.dropHold();
  }

  /** Records a probed rival as seen once it is the target (a target change wipes memory first). */
  private landRival(target: Entity | null, targetPos: Vec3 | null): void {
    const rival = this.pendingRival;
    if (rival == null) {
      return;
    }
    if (target === rival && targetPos) {
      this.memory.remember({kind: 'visual', source: rival, position: targetPos, strength: 1});
      this.pendingRival = null;
    } else if (!this.sticky.isPreferring(rival) || !this.sticky.isStillTargetable(rival)) {
      this.pendingRival = null;
    }
  }

  private dropHold(): void {
    this.heldTarget = null;
    this.heldUnseenSeconds = 0;
    this.hiddenRivals.clear();
    this.rivalClock = 0;
    this.rivalPending = false;
    this.rivalToken++;
  }

  private recordHeard(heard: Heard): void {
    this.memory.remember({
      kind: 'audio',
      source: heard.instigatorRoot,
      position: heard.position,
      strength: HEARD_STRENGTH,
    });
  }

  /**
   * Damage is knowledge, not vision: records the attacker as a damage
   * stimulus so the shooter goes looking, returning its position. Grants no
   * sight — `visible` still requires the FOV cone and a clear ray, and only
   * sight authorizes shots.
   */
  reveal(target: Entity): Vec3 | null {
    const pos = target.getComponent(TransformComponent)?.worldPosition ?? null;
    if (!pos) {
      return null;
    }
    this.memory.remember({kind: 'damage', source: target, position: pos, strength: 1});
    return pos;
  }

  /** Treats the target as freshly stimmed (a retreat ending behind cover). */
  markSeen(): void {
    this.memory.markSeen();
  }

  /** Makes `entity` the target from the next update. */
  prefer(entity: Entity): void {
    this.sticky.prefer(entity);
  }

  isPreferring(entity: Entity): boolean {
    return this.sticky.isPreferring(entity);
  }

  /** `entity` or its nearest ancestor carrying one of the target tags, or null. */
  taggedRootOf(entity: Entity): Entity | null {
    return this.sticky.taggedRootOf(entity);
  }

  /** Full reset: acquisition, sight and memory. Nothing perceived carries over. */
  reset(): void {
    this.sticky.reset();
    this.vision.reset();
    this.memory.forgetMemory();
    this.hearing.reset();
    this.pendingHeard = null;
    this.pendingRival = null;
    this.dropHold();
  }

  /** Stops listening for noise, for a behavior that is removed; the next update listens again. */
  stopHearing(): void {
    this.hearing.stop();
    this.pendingHeard = null;
    this.dropHold();
  }

  /** Drops what is known, keeping the acquisition's smoothing. */
  forgetMemory(): void {
    this.memory.forgetMemory();
  }

  /** Copies the knobs into the senses every frame; the starter pushes here. */
  private forwardSenses(): void {
    const vision = this.vision;
    vision.sightRange = this.sightRange;
    vision.fieldOfViewDeg = this.fieldOfViewDeg;
    vision.reactionTime = this.reactionTime;
    vision.reactionTimeMin = this.reactionTimeMin;
    vision.reactionTimeMax = this.reactionTimeMax;
    vision.sightCheckInterval = this.sightCheckInterval;
    vision.eyeHeight = this.eyeHeight;
    vision.targetAimHeight = this.targetAimHeight;
    vision.lostSightGraceSeconds = this.lostSightGraceSeconds;
    vision.sightQuery = this.sightQuery;
    vision.random = this.random;
    this.memory.memorySeconds = this.memorySeconds;
    this.hearing.enabled = this.hearingEnabled;
    this.hearing.rangeScale = this.hearingRangeScale;
  }
}

/** A rival probe in flight: who cast it and copies of where both stood when it went out. */
interface RivalProbe {
  readonly token: number;
  readonly self: Entity;
  readonly selfWas: Vec3;
  readonly rival: Entity;
  readonly rivalWas: Vec3;
}

/**
 * Whether `entity` is gone or has moved more than the probe tolerance from
 * `was` across the ground, like the range and view gates; a height change (a
 * crouch, a hop) does not count.
 */
function movedSince(entity: Entity, was: Vec3): boolean {
  const now = entity.getComponent(TransformComponent)?.worldPosition;
  return !now || horizontalDistance(now, was) > RIVAL_PROBE_MOVE_TOLERANCE;
}

// A new target must be this much closer (m) than the one being fought before
// the shooter turns to it.
const TARGET_SWITCH_MARGIN = 3;
const PARENT_WALK_MAX_DEPTH = 32;

/**
 * Closest-tagged-entity targeting that keeps the current target while
 * `keepCurrent()` holds (the shooter knows of it) and it is still a living
 * tagged entity, unless another is clearly closer. Without it, two targets at
 * nearly equal distance alternate frame to frame, and each switch wipes what
 * the shooter knew. A target set with `prefer` is kept whatever its distance.
 */
class StickyTargeting extends TargetTaggedEntityBehavior {
  keepCurrent: () => boolean = () => false;
  /** Whether the current target is in view; one in view is kept whatever the distance. */
  currentInView: () => boolean = () => false;
  private current: Entity | null = null;
  private preferred: Entity | null = null;

  /** Makes `entity` the target from the next update, kept while `keepCurrent()` holds. */
  prefer(entity: Entity): void {
    this.preferred = entity;
  }

  isPreferring(entity: Entity): boolean {
    return this.preferred === entity;
  }

  /** Whether any entity is preferred: a switch pending, or a target held by preference. */
  hasPreference(): boolean {
    return this.preferred != null;
  }

  /**
   * The closest tagged entity in view of the cone (and range), skipping every
   * entity in `skip`; for a probe of rivals to the current target. The held
   * target's cone exemption does not apply.
   */
  noticedExcept(skip: Set<Entity>): Entity | null {
    const held = this.targetInfo.targetEntity;
    const excluded = this.excludeEntities;
    this.targetInfo.targetEntity = null;
    this.excludeEntities = skip;
    try {
      return super.resolveTarget();
    } finally {
      this.targetInfo.targetEntity = held;
      this.excludeEntities = excluded;
    }
  }

  /** Drops the current and preferred targets and the smoothing, as if just created. */
  reset(): void {
    this.current = null;
    this.preferred = null;
    this.resetSmoothing();
  }

  /** `entity` or its nearest ancestor carrying one of the target tags, or null. */
  taggedRootOf(entity: Entity): Entity | null {
    let current: Maybe<Entity> = entity;
    for (let depth = 0; current != null && depth < PARENT_WALK_MAX_DEPTH; depth++) {
      if (this.isTagged(current)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  protected override resolveTarget(): Entity | null {
    const previous = this.current;
    const target = this.pick();
    if (target !== previous) {
      // The smoothed position and velocity belong to the previous target; a new
      // one starts from its own position with no made-up crossing velocity.
      this.resetSmoothing();
    }
    return target;
  }

  private pick(): Entity | null {
    if (!this.keepCurrent()) {
      // Forgotten: release the held target so the fresh pick below is fully
      // cone-gated. Without this the held-target exemption in resolveTarget
      // keeps re-picking a behind-the-back target the shooter no longer
      // knows, blinding it to a visible candidate ahead.
      this.targetInfo.targetEntity = null;
    }
    const closest = super.resolveTarget();
    const preferred = this.preferred;
    if (preferred) {
      if (this.isStillTargetable(preferred) && (preferred !== this.current || this.keepCurrent())) {
        this.current = preferred;
        return preferred;
      }
      this.preferred = null;
    }
    const current = this.current;
    if (
      current &&
      closest &&
      closest !== current &&
      this.keepCurrent() &&
      this.isStillTargetable(current) &&
      (this.currentInView() || this.distanceTo(current) - this.distanceTo(closest) <= TARGET_SWITCH_MARGIN)
    ) {
      return current;
    }
    this.current = closest;
    return closest;
  }

  /** Whether `entity` is a living, undestroyed entity carrying a target tag. */
  isStillTargetable(entity: Entity): boolean {
    return !entity.isDestroyed() && !isDead(entity) && this.isTagged(entity);
  }

  private isTagged(entity: Entity): boolean {
    // No actor or group id: resolves to the global tagging blackboard.
    const blackboard = this.behaviorManager?.actorBlackboardManager.getBlackboard(ActorTaggingBlackboard);
    if (!blackboard) {
      return false;
    }
    for (const tag of this.targetTags) {
      for (const entry of blackboard.getTaggedEntities(tag)) {
        if (entry.entity === entity) {
          return true;
        }
      }
    }
    return false;
  }

  private distanceTo(entity: Entity): number {
    const from = this.actorTransform?.worldPosition;
    const to = entity.getComponent(TransformComponent)?.worldPosition;
    return from && to ? to.sub(from).magnitude() : Number.POSITIVE_INFINITY;
  }
}
