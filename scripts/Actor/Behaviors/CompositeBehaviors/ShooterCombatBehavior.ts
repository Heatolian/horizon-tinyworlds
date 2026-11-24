/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v38

import {
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
  type NavMeshComponent,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager, ActorController} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  type ActorMovementController,
  ActorMoveParams,
} from 'meta/worlds';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';
import {GotoBehavior} from '../BaseBehaviors/GotoBehavior';
import {ShooterPerception} from '../../Perception/ShooterPerception';
import {
  IActorAttackControllerTypeId,
  type IActorAttackController,
} from '../../Controllers/Definitions/IActorAttackController';
import type {IActorJump} from '../../Controllers/Definitions/IActorJump';
import {PhysicsSightQuery, type IgnoredRoots, type SightQuery} from '../../Perception/SightQuery';
import {isUnderAny} from '../../../gas_abilities/weapons/targeting/Targeting';
import {NavMeshLookup} from '../../../Navigation/NavMeshLookup';
import {
  computeAimErrorDeg,
  computeFleePoint,
  computeStrafePoint,
  generateCoverCandidates,
  horizontalDistance,
  type RandomSource,
} from '../../Utilities/ShooterComputations';
import {
  findCharacterGAS,
  type CharacterGASComponent,
} from '../../../Character/gas/CharacterGASComponent';
import {
  ActorGASHealthComponent,
  REGEN_PERIOD_SECONDS,
} from '../../Utilities/ActorGASHealthComponent';
import {RELOADING_TAG} from '../../../gas_abilities/weapons/core/WeaponSetup';

/** What the shooter is doing this frame. */
export const ShooterMode = {
  /** No known target: claims nothing, so ambient starters drive. */
  Idle: 'idle',
  /** Target visible: strafes inside the range band and fires. */
  Engage: 'engage',
  /** Reloading: moves behind cover, or backs off when none is found. */
  Cover: 'cover',
  /** Low health: breaks contact toward cover, firing back while it can see. */
  Retreat: 'retreat',
  /** Lost sight: walks to the last known position and looks around. */
  Search: 'search',
} as const;
export type ShooterMode = (typeof ShooterMode)[keyof typeof ShooterMode];

const ARRIVAL_DISTANCE = 0.75;
const RETARGET_MIN_MOVE = 0.3;
const NAVMESH_SNAP_TOLERANCE = 2;
const NAVMESH_WALL_BACKOFF = 0.4;
const MIN_USEFUL_STEP = 1.0;
/** A confirmed route is kept until its target has moved farther than this (m). */
const ROUTE_TARGET_MOVED_DISTANCE = 2.0;
/** A confirmed route is kept past a strafe interval only if the shooter moved at least this far (m) in it. */
const ROUTE_MIN_PROGRESS = 0.5;
const COVER_RETRY_SECONDS = 2.0;
const COVER_RESEARCH_SECONDS = 0.5;
/** Most seconds the stop on entering Idle keeps bidding for Movement before it is granted. */
const STOP_ON_IDLE_SECONDS = 1.0;
// Every candidate (three rings of twelve) is ray-tested, nearest first, so the
// outer rings are searched too. One search runs at a time; a failed one is
// retried after COVER_RETRY_SECONDS, and a dropped point or discarded answer
// is searched again after COVER_RESEARCH_SECONDS.
const COVER_MAX_CANDIDATES = 36;
const COVER_DEDUPE_DISTANCE = 1.0;
// A cover search, cover point or flee point whose threat has since moved this
// far (m) is redone.
const COVER_THREAT_MOVED_DISTANCE = 2.0;
// A cover point from which the shooter can see its target for this long is
// abandoned for a new search. Judged by the shooter's own line of sight (its eye
// height, characters block), not the cover ray: if it can see the target, the
// target can see it.
const COVER_COMPROMISED_SECONDS = 0.5;
// Turns (rad) tried, in order, when the straight flee is walled off.
const FLEE_TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
const SEARCH_SWEEP_PERIOD = 1.2;
const SEARCH_SWEEP_HALF_ANGLE = 1.2;
// A retreating shooter whose target is this close fights instead of turning its back.
const CORNERED_FRACTION_OF_MIN_RANGE = 0.5;
// Least gap between the retreat and recover health fractions.
const RECOVER_MARGIN = 0.1;
const RECOVER_TOLERANCE = 1e-6;

/**
 * Retreat/recover thresholds with the behavior's own invariants: retreat is
 * capped so recovery stays reachable at full health, and recover is kept a
 * margin above retreat (and at most full), so inverted configs cannot start
 * and end a retreat on one tick. Shared with the debug overlay so its edges
 * fire exactly when the retreat path does.
 */
export function resolveRetreatThresholds(
  retreatFraction: number,
  recoverFraction: number,
): {retreatAt: number; recoverAt: number} {
  const retreatAt = Math.min(retreatFraction, 1 - RECOVER_MARGIN);
  const recoverAt = Math.min(1, Math.max(recoverFraction, retreatAt + RECOVER_MARGIN));
  return {retreatAt, recoverAt};
}

/**
 * Solo-shooter opponent: a tactical brain for an actor that fires a held gun
 * through its attack controller.
 *
 * Sensing is delegated to {@link ShooterPerception} (target acquisition,
 * physics line of sight, a reaction delay before the first shot, a memory of
 * the last known position); this behavior owns the five tactical modes — see
 * {@link ShooterMode}. Mode selection, in order: no known
 * target is Idle; low health is Retreat until health recovers or
 * {@link maxRetreatSeconds} runs out (then it fights to the death); reloading
 * is Cover; a visible target is Engage; otherwise Search.
 *
 * Shooting stays the attack controller's and GAS's: the behavior asks for an
 * attack only while it can see the target, has reacted, and faces it, and
 * paces on `canAttack()`. It never keeps an attack clock. It adds one payload
 * field, `aimErrorDeg`, so a held weapon misses like a person does: wide on
 * first sight, settling while the target stays in view (see
 * `computeAimErrorDeg`).
 *
 * Claims Movement, BodyDirection and Attack at {@link basePriority} while it
 * knows of a target, and nothing while Idle. Never finishes.
 */
export class ShooterCombatBehavior extends ActorBehavior {
  override name: string = 'ShooterCombatBehavior';

  /** True once the behavior manager has removed this behavior. */
  isRemoved: boolean = false;

  // ── Targeting and perception ──────────────────────────────────────

  /** Tags to hunt; the closest living tagged entity is the target. Read every frame. */
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
  /**
   * Hears gunfire and explosions from the entities it hunts, even unseen:
   * a heard event is a last known position, so Search walks there facing it.
   * Hearing never grants sight, so it fires only once it sees the target.
   */
  hearingEnabled: boolean = true;
  /** Scales the hearing radii (gunshot 30 m, explosion 60 m, near miss 3 m). */
  hearingRangeScale: number = 1;

  // ── Engagement ────────────────────────────────────────────────────

  /** Farthest (m) the shooter fires from. */
  fireRange: number = 25;
  /** Closer than this (m) it backs off. */
  minRange: number = 6;
  /** Range (m) it drifts toward while fighting. */
  preferredRange: number = 12;
  /** Farther than this (m) it closes in. */
  maxRange: number = 18;
  /** Sideways step (m) per reposition. */
  strafeDistance: number = 3;
  /** Shortest time (s) between repositions. */
  strafeIntervalMin: number = 1.2;
  /** Longest time (s) between repositions. */
  strafeIntervalMax: number = 2.5;
  /** Movement speed (m/s) while fighting, taking cover and searching. */
  moveSpeed: number = 3.5;
  /**
   * Seconds of no XZ progress after which the shared goto nudges itself free
   * by sidestepping its current waypoint (never the goal). Re-copied to the
   * goto every frame, so a live edit takes effect without a restart. 0
   * (default) keeps log-only stall detection, as before.
   */
  stuckNudgeSeconds: number = 0;
  /** Sidestep distance (m) per stuck nudge. */
  stuckNudgeDistance: number = 1.0;
  /**
   * Sidestep and hop the moment a shot lands while engaged, instead of
   * strafing only on the reposition timer. The hop needs a jump controller on
   * the actor and is skipped without one; the sidestep always applies.
   */
  dodgeOnDamage: boolean = true;
  /** Shots are only requested while the target is within this angle (deg) of the shooter's facing. */
  fireConeDeg: number = 25;
  /** Body turn speed (rad/s). */
  turnSpeed: number = 6.28;
  /**
   * Log each mode transition (`[ShooterCombat] <actor> engage -> cover ...`).
   * Off by default so shipped worlds stay quiet; turn on to tune or debug.
   */
  logModeChanges: boolean = false;

  // ── Aim error (see computeAimErrorDeg) ────────────────────────────

  maxAimErrorDeg: number = 8;
  minAimErrorDeg: number = 1.5;
  aimSettleSeconds: number = 1.5;
  aimErrorPerTargetSpeedDeg: number = 1.0;
  // 3.0, deliberately above parity: a hopper's m/s are small but all
  // screen-space, and playtest showed jumpers still trivially hittable at 1.0.
  aimErrorPerVerticalSpeedDeg: number = 3.0;
  movingAimPenaltyDeg: number = 1.5;
  /**
   * Slowest aimed cadence (s) between shots. 0 (default) fires whenever the
   * weapon is ready; a station sets ~1 so each shot reads as a deliberate aim
   * (and its Hit/Miss bubble clears) instead of a mag-dump.
   */
  minSecondsBetweenShots: number = 0;

  // ── Survival ──────────────────────────────────────────────────────

  /** Health fraction at or below which it retreats, at most 0.9. 0 = never retreats. */
  retreatHealthFraction: number = 0.3;
  /** Health fraction at which a retreat ends: at least `retreatHealthFraction` + 0.1, at most 1. */
  recoverHealthFraction: number = 0.7;
  /** Longest retreat (s); after it the shooter fights on until healed. */
  maxRetreatSeconds: number = 8;
  /** Movement speed (m/s) while retreating. */
  retreatSpeed: number = 5;
  /** Shoots back while retreating when it can see the target. */
  fireWhileRetreating: boolean = true;
  /** Moves to cover while its weapon reloads. */
  seekCoverWhileReloading: boolean = true;
  /** Radius (m) searched for cover. */
  coverSearchRadius: number = 10;
  /**
   * Eye height (m) of a standing threat and head height of the shooter at a
   * cover point. Cover rays run between the two, so only obstacles taller than
   * this hide the shooter. Candidates take the shooter's own ground height, so
   * cover assumes level ground within `coverSearchRadius`.
   */
  coverEyeHeight: number = 1.6;
  /**
   * Health regained per second while unseen. 0 = none. Applied as a periodic
   * GAS effect the shooter holds on itself while it wants to recover, so GAS
   * paces the healing and the health rules (ceiling, no healing while dead)
   * apply to it.
   */
  regenPerSecond: number = 0;
  /**
   * Seconds unseen before regeneration starts. Once started, it stops when the
   * target stays in view for a full regeneration tick, or when anything hits
   * the shooter; a shorter glimpse (sight flickering through patchy cover)
   * does not reset it. A hit restarts the same delay for every attacker.
   */
  regenDelaySeconds: number = 2;

  // ── Injection seams ───────────────────────────────────────────────

  /** Line-of-sight oracle. Replaced in tests. */
  sightQuery: SightQuery = new PhysicsSightQuery();
  /** Random source for strafe choices. Replaced in tests. */
  random: RandomSource = Math.random;

  // ── Runtime state (read-only outside) ─────────────────────────────

  /** Current tactical mode. */
  mode: ShooterMode = ShooterMode.Idle;
  // Seconds left on the stop armed on entering Idle: Movement is claimed until
  // it is granted (the stop is sent) or this runs out.
  private stopOnIdleLeft: number = 0;
  /**
   * Sensing half: acquisition, line of sight, attention and memory. Every knob
   * lives on this behavior (live-tunable through the starter) and is forwarded
   * every frame; the surface below is read-only outside.
   */
  readonly perception = new ShooterPerception();
  /**
   * The perception surface, kept on the behavior: these read (and, for the
   * last known position, write) through to it, so sensing moved without
   * moving the API its readers use.
   */
  get target(): Entity | null {
    return this.perception.target;
  }
  get aware(): boolean {
    return this.perception.aware;
  }
  get visible(): boolean {
    return this.perception.visible;
  }
  get visibleSeconds(): number {
    return this.perception.visibleSeconds;
  }
  get secondsSinceSeen(): number {
    return this.perception.secondsSinceSeen;
  }
  get lastKnownPosition(): Vec3 | null {
    return this.perception.lastKnownPosition;
  }
  set lastKnownPosition(value: Vec3 | null) {
    this.perception.lastKnownPosition = value;
  }
  /** Point the shooter is walking to, or null to hold position. */
  destination: Vec3 | null = null;
  /** Hidden position chosen by the last cover search, or null. */
  coverPoint: Vec3 | null = null;
  /** True between the low-health trigger and recovery (or `maxRetreatSeconds`). */
  retreating: boolean = false;
  /** True after a retreat timed out, until health recovers: no further retreats. */
  lastStand: boolean = false;
  /** Aim error (deg) the next shot carries. */
  aimErrorDeg: number = 0;

  protected goto: GotoBehavior | null = null;
  // A tagged attacker the shooter turns to; revealed once it is the target.
  private pendingReveal: Entity | null = null;

  private selfTransform: TransformComponent | null = null;
  private gas: CharacterGASComponent | null = null;
  private unsubscribeDamage: (() => void) | null = null;
  private gasRetryTimer: number = 0;
  private strafeTimer: number = 0;
  private strafeSide: number = 1;
  /** Last dodge arming, on `elapsedSeconds`; dodges rate-limit to one strafe beat. */
  private lastDodgeAt: number = Number.NEGATIVE_INFINITY;
  /**
   * A hop requested by a hit, delivered from `useController` the next time the
   * movement axis is handed over — only the arbitration winner may jump the
   * body. Dropped (not delivered) when the mode is no longer Engage, when no
   * jumpable controller is handed over, or on death.
   */
  private hopPending: boolean = false;
  // Updates survived while a hop waits for delivery; a hop gets exactly one
  // apply pass, then update() drops it instead of firing late.
  private hopFramesPending: number = 0;
  /**
   * A dodge reposition is owed: the next strafe pick keeps the dodge's side
   * instead of re-rolling it. Set by `dodge`, consumed by `runEngage`.
   */
  private dodgeRepositionPending: boolean = false;
  private retreatSeconds: number = 0;
  private cornered: boolean = false;
  private coverPending: boolean = false;
  private coverToken: number = 0;
  /**
   * Route checks are numbered; `routeInFlight` holds the number of the one
   * awaiting its answer (0: none). Only that answer clears it, and a mode
   * change abandons it, so a stale answer can neither commit nor leave a
   * check stuck in flight.
   */
  private routeToken: number = 0;
  private routeInFlight: number = 0;
  /** The destination a path check confirmed, and where its target stood then; kept across re-picks. */
  private routeDestination: Vec3 | null = null;
  private routeTargetAt: Vec3 | null = null;
  /** Where the shooter stood when the route was confirmed or last kept. */
  private routeProgressFrom: Vec3 | null = null;
  /**
   * Set by a failed route check; cleared by the next pick that finds a point
   * or route check that answers, so each run of failures warns once.
   */
  private hasWarnedRouteFailed: boolean = false;
  private coverRetryTimer: number = 0;
  private coverSeenSeconds: number = 0;
  private fleePoint: Vec3 | null = null;
  private fleeRetryTimer: number = 0;
  // Threat distance the current flee point was picked to open. A reached point
  // that already opened this far holds instead of chaining another flee leg,
  // so a retreat opens to maxRange and waits for cover or healing there rather
  // than running off the station one leg at a time.
  private fleeNeed: number = 0;
  // Where the threat was when the cover point was searched for and the flee
  // point computed; either is redone once the threat has moved away from it.
  private coverThreat: Vec3 | null = null;
  private fleeThreat: Vec3 | null = null;
  // A re-search is waiting out COVER_RESEARCH_SECONDS after the threat moved.
  private coverResearchDue: boolean = false;
  private sweepTimer: number = 0;
  private sweepBaseYaw: number | null = null;
  private desiredFacing: Vec3 | null = null;
  private moving: boolean = false;
  private gotoTarget: Vec3 | null = null;
  private wantsToFire: boolean = false;
  private readonly navMeshLookup = new NavMeshLookup({owner: 'ShooterCombat', now: () => this.elapsedSeconds});
  private elapsedSeconds: number = 0;
  // The actor's health component owns the regeneration effect; the behavior
  // only paces it (when to heal) and never touches GAS writes.
  private health: ActorGASHealthComponent | null = null;
  private regenHeld: boolean = false;
  // Unbroken seconds the target has been in view while regeneration is held.
  private regenSeenSeconds: number = 0;
  // A hit, read by the next updateHealth: onDamaged can fire inside
  // GASEffectManager.tick, where removing an effect shifts its loop.
  private regenInterrupted: boolean = false;
  // Seconds since anything hit the shooter; a hit restarts the regen delay
  // for every attacker, not just the current target.
  private secondsSinceHit: number = Number.POSITIVE_INFINITY;
  private hasWarnedUnarmed: boolean = false;
  private hasWarnedNoHealth: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    const entity = this.getEntity();
    this.selfTransform = entity.getComponent(TransformComponent);
    const start = this.selfTransform?.worldPosition ?? new Vec3(0, 0, 0);

    this.perception.keepHunting = () => this.retreating;
    this.perception.onForget = () => {
      this.cornered = false;
      this.resetCover();
    };
    this.perception.initialize(behaviorManager, entity);

    this.goto = new GotoBehavior();
    this.goto.basePriority = this.basePriority;
    this.goto.targetPosition = start;
    this.goto.desiredSpeed = this.moveSpeed;
    this.goto.distanceToStop = 0.3;
    this.goto.repathInterval = 1.0;
    this.goto.shouldFaceDirection = false;
    this.goto.initialize(behaviorManager);

    this.connectGas(entity);
  }

  /**
   * Finds the actor's CharacterGASComponent and listens for its hits. It may
   * not have started when the behavior initializes, so `update` retries a miss
   * every GAS_RETRY_SECONDS.
   */
  private connectGas(entity: Entity): void {
    this.gas = findCharacterGAS(entity);
    // The adapter IS the GAS component (it extends CharacterGASComponent), so
    // it is derived from the found instance: a second root-only lookup would
    // miss rigs that nest GAS below the root. The root lookup stays first as
    // the seam for injected test doubles.
    this.health =
      entity.getComponent(ActorGASHealthComponent) ??
      (this.gas instanceof ActorGASHealthComponent ? this.gas : null);
    this.unsubscribeDamage = this.gas?.onDamaged(() => this.onDamaged()) ?? null;
    this.gasRetryTimer = GAS_RETRY_SECONDS;
  }

  override onRemove(): void {
    this.isRemoved = true;
    this.unsubscribeDamage?.();
    this.unsubscribeDamage = null;
    this.perception.stopHearing();
    this.stopRegen();
    super.onRemove();
  }

  override update(deltaTime: number): void {
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    this.elapsedSeconds += dt;
    // A dodge hop gets exactly one apply pass: armed between updates, it
    // survives this update and delivers in the controller phase; if
    // arbitration (or stagger) denies that pass, the next update drops it
    // instead of firing long after the hit.
    if (this.hopPending && ++this.hopFramesPending > 1) {
      this.hopPending = false;
      this.hopFramesPending = 0;
    }
    // A stop on entering Idle that arbitration keeps giving to another
    // behavior waits for it, so a shooter that forgot mid-walk never walks on
    // once that behavior lets go; it stops bidding after
    // STOP_ON_IDLE_SECONDS, by when that behavior has long driven the body.
    if (this.stopOnIdleLeft > 0) {
      this.stopOnIdleLeft = Math.max(0, this.stopOnIdleLeft - dt);
    }
    const entity = this.behaviorManager ? this.getEntity() : null;
    if (!this.perception.initialized || !this.selfTransform || !entity || entity.isDestroyed()) {
      this.stopRegen();
      return;
    }
    if (!this.gas) {
      this.gasRetryTimer -= dt;
      if (this.gasRetryTimer <= 0) {
        this.connectGas(entity);
      }
    }

    if (this.gas?.isDead) {
      // A revive starts with no retreat or last stand.
      this.resetRetreat();
      // Nor does a target, its smoothing, or an attacker it was turning to.
      this.pendingReveal = null;
      this.setMode(ShooterMode.Idle);
      this.clearIntent();
      // Death owns the body; nothing to stop.
      this.stopOnIdleLeft = 0;
      // A killing hit arms the dodge while still engaged: without this the
      // request survives death and hops on the first frame after revive.
      this.hopPending = false;
      this.hopFramesPending = 0;
      this.dodgeRepositionPending = false;
      // Nothing perceived before death carries over a revive.
      this.perception.reset();
      this.stopRegen();
      return;
    }

    const selfPos = this.selfTransform.worldPosition;
    this.forwardPerception();
    this.perception.update(dt, entity, selfPos);
    const target = this.perception.target;
    const info = this.perception.targetInfo;
    if (this.pendingReveal) {
      // Kept until the attacker becomes the target, or its preference lapses.
      if (target === this.pendingReveal) {
        this.revealTarget(target);
        this.pendingReveal = null;
      } else if (!this.perception.isPreferring(this.pendingReveal)) {
        this.pendingReveal = null;
      }
    }

    const targetPos = target ? info.rawPosition : null;

    this.updateHealth(dt);

    this.setMode(this.chooseMode(selfPos, targetPos));
    this.runMode(dt, selfPos, targetPos);

    this.wantsToFire = this.computeWantsToFire(selfPos, targetPos);
    if (this.wantsToFire && targetPos) {
      this.aimErrorDeg = computeAimErrorDeg(this, {
        visibleSeconds: this.perception.visibleSeconds,
        shooterToTarget: targetPos.sub(selfPos),
        targetVelocity: info.smoothedVelocity,
        shooterMoving: this.moving,
      });
    }

    this.updateGoto(dt);
    this.secondsSinceLastShot += dt;
  }

  /**
   * Copies the live-tunable knobs into perception. The starter pushes every
   * one of these through `applySettings`, so a live edit takes effect on the
   * next frame without touching the starter.
   */
  private forwardPerception(): void {
    const perception = this.perception;
    perception.targetTags = this.targetTags;
    perception.sightRange = this.sightRange;
    perception.fieldOfViewDeg = this.fieldOfViewDeg;
    perception.reactionTime = this.reactionTime;
    perception.reactionTimeMin = this.reactionTimeMin;
    perception.reactionTimeMax = this.reactionTimeMax;
    perception.memorySeconds = this.memorySeconds;
    perception.sightCheckInterval = this.sightCheckInterval;
    perception.eyeHeight = this.eyeHeight;
    perception.targetAimHeight = this.targetAimHeight;
    perception.lostSightGraceSeconds = this.lostSightGraceSeconds;
    perception.sightQuery = this.sightQuery;
    perception.random = this.random;
    perception.hearingEnabled = this.hearingEnabled;
    perception.hearingRangeScale = this.hearingRangeScale;
  }

  override getControllerUsePriority(controllerType: string): number {
    if (this.mode === ShooterMode.Idle) {
      return controllerType === ActorMovementControllerTypeId && this.stopOnIdleLeft > 0 ? this.basePriority : -1;
    }
    if (controllerType === ActorMovementControllerTypeId) {
      return this.basePriority;
    }
    if (controllerType === ActorBodyDirectionControllerTypeId) {
      return this.desiredFacing ? this.basePriority : -1;
    }
    if (controllerType === IActorAttackControllerTypeId) {
      return this.wantsToFire && this.attackReady() && this.shotPacingElapsed() ? this.basePriority : -1;
    }
    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorMovementControllerTypeId && this.mode === ShooterMode.Idle) {
      (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
      this.stopOnIdleLeft = 0;
      return;
    }
    if (controllerType === ActorMovementControllerTypeId) {
      this.deliverHop(controller);
      if (this.moving && this.goto) {
        this.goto.useController(controllerType, controller);
      } else {
        (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
      }
      return;
    }
    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredFacing) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(this.desiredFacing, this.turnSpeed),
      );
      return;
    }
    if (controllerType === IActorAttackControllerTypeId && this.perception.target) {
      // Called once per attack controller on the actor; only those that fire a
      // weapon reaching the target may attack.
      const attack = controller as IActorAttackController;
      const distance = this.targetDistance();
      if (!firesWeaponAt(attack, distance) || !attack.canAttack(this.perception.target) || !this.shotPacingElapsed()) {
        return;
      }
      attack.attack({
        target: this.perception.target,
        damage: undefined,
        attackRange: Number.isFinite(distance) ? distance : undefined,
        targetVelocity: this.perception.targetInfo.isValid ? this.perception.targetInfo.smoothedVelocity : null,
        aimErrorDeg: this.aimErrorDeg,
      });
      this.secondsSinceLastShot = 0;
    }
  }

  // ── Perception ────────────────────────────────────────────────────

  // ── Perception ────────────────────────────────────────────────────
  // Sensing lives in ShooterPerception (Actor/Perception/): acquisition, line
  // of sight, attention and memory. The knobs above stay on this behavior so
  // the starter keeps pushing them; `forwardPerception` copies them over every
  // frame.

  /**
   * Being shot by the target reveals where it is, even unseen, so the shooter
   * goes looking. Being shot by another tagged entity while the target is out
   * of sight turns the shooter to that attacker, so a nearer hidden target
   * cannot blind it to a farther one shooting at it. A target lost from view
   * only within the Engage grace window is still the one being fought, so a
   * hit then does not pull the shooter off it. Hits from anything untagged (a
   * stray round from another actor) are ignored for reveal, though the flinch
   * and regen interrupt above still fire on any damage.
   */
  private onDamaged(): void {
    // Any damage interrupts a held regeneration episode and restarts its
    // delay: a hit only delayed the next one from starting, so a shooter
    // under fire kept healing through it. Deferred to updateHealth — this can
    // fire inside GASEffectManager.tick, where removing an effect shifts the
    // loop it is iterating. Every attacker counts, not just the current
    // target, so secondsSinceHit (not secondsSinceSeen, which also drives
    // memory) carries the delay.
    this.regenInterrupted = true;
    this.secondsSinceHit = 0;
    this.dodge();
    const attacker = this.gas?.getLastAttacker() ?? null;
    if (!attacker || attacker.isDestroyed()) {
      return;
    }
    const target = this.perception.target;
    // The attacker is the entity owning the shooter's GAS, which may sit below
    // the tagged root.
    if (target && isUnderAny(attacker, [target])) {
      this.revealTarget(target);
      return;
    }
    if (this.perception.visible || this.inLostSightGrace()) {
      return;
    }
    const root = this.perception.taggedRootOf(attacker);
    if (root && root !== this.getEntity()) {
      this.perception.prefer(root);
      this.pendingReveal = root;
    }
  }

  /**
   * Starts the dodge: the strafe side flips and a hop is queued for it. The
   * sidestep itself only materializes in Engage (the only mode that
   * repositions on the strafe timer); in any other mode the hit still flinches
   * — the reveal below turns the hit into a Search. Firing is unchanged: only
   * sight authorizes shots.
   * Runs on the damage event, which can fire inside GASEffectManager.tick, so
   * it only arms state; the jump request itself goes out from `useController`
   * when the movement axis is handed over.
   */
  private dodge(): void {
    if (!this.dodgeOnDamage) {
      return;
    }
    // Rate limit: sustained fire (or periodic damage ticks) must not flip the
    // side on every hit and pogo the shooter. One dodge reaction — sidestep
    // plus hop — per strafe beat at most.
    if (this.elapsedSeconds - this.lastDodgeAt < this.strafeIntervalMin) {
      return;
    }
    this.lastDodgeAt = this.elapsedSeconds;
    this.hopPending = true;
    this.hopFramesPending = 0;
    // Flip the side so the reposition breaks the strafe rhythm instead of
    // re-picking the same point the timer was already walking to. Once per
    // arming: several hits before the next pick flip once, not back.
    if (!this.dodgeRepositionPending) {
      this.strafeSide = -this.strafeSide;
    }
    this.dodgeRepositionPending = true;
    this.strafeTimer = 0;
  }

  /**
   * Delivers a queued dodge hop through the movement controller being handed
   * over — the arbitration winner — and only while engaged. Clears only on a
   * controller that could actually take it, so within one frame a move-only
   * controller handed over first does not swallow the request; across frames
   * update() drops an undelivered one. A request owed past Engage is dropped,
   * never carried: the next hit arms a fresh one. Skipped silently when none
   * can jump.
   */
  private deliverHop(controller: ActorController): void {
    if (!this.hopPending) {
      return;
    }
    if (this.mode !== ShooterMode.Engage) {
      this.hopPending = false;
      this.hopFramesPending = 0;
      return;
    }
    const jumper = controller as Partial<IActorJump>;
    if (typeof jumper.requestJump === 'function') {
      jumper.requestJump();
      this.hopPending = false;
      this.hopFramesPending = 0;
    }
  }

  /**
   * Damage is knowledge, not vision: being shot writes where the attacker is
   * and turns to face it, so the next update leaves Idle for Search and walks
   * the last known position. Nothing here grants sight — `visible` still
   * requires the FOV cone and a clear ray, and only sight authorizes shots.
   */
  private revealTarget(target: Entity): void {
    const pos = this.perception.reveal(target);
    const selfPos = this.selfTransform?.worldPosition;
    if (pos && selfPos) {
      this.desiredFacing = facing(selfPos, pos) ?? this.desiredFacing;
    }
  }

  /**
   * Drops the cover point and any search in flight. A cover point is only
   * hidden from the threat position it was searched against, so each Cover or
   * Retreat episode searches afresh.
   */
  private resetCover(): void {
    this.coverPoint = null;
    this.coverPending = false;
    this.coverToken++;
    this.coverRetryTimer = 0;
    this.coverSeenSeconds = 0;
    this.fleePoint = null;
    this.fleeRetryTimer = 0;
    this.fleeNeed = 0;
    this.coverThreat = null;
    this.fleeThreat = null;
    this.coverResearchDue = false;
  }

  // ── Health ────────────────────────────────────────────────────────

  private resetRetreat(): void {
    this.retreating = false;
    this.lastStand = false;
    this.retreatSeconds = 0;
    this.cornered = false;
  }

  private updateHealth(dt: number): void {
    const gas = this.gas;
    if (!gas) {
      return;
    }
    const fraction = gas.maxHealth > 0 ? gas.health / gas.maxHealth : 1;
    const {retreatAt, recoverAt: recover} = resolveRetreatThresholds(
      this.retreatHealthFraction,
      this.recoverHealthFraction,
    );

    // A small tolerance, so a creator's 0.2 and 0.3 still end a retreat at 30%.
    const recovered = fraction >= recover - RECOVER_TOLERANCE;
    if (this.lastStand && recovered) {
      this.lastStand = false;
    }
    // A retreat needs something to retreat from: unaware, it neither starts nor
    // spends its time budget. (The awareness hold below keeps a retreater
    // aware of its last-known target, so a hidden retreat still spends its
    // budget and always ends by maxRetreatSeconds: "longest retreat" is a
    // wall clock, not a visible-only clock.)
    if (
      this.perception.aware &&
      !this.retreating &&
      !this.lastStand &&
      retreatAt > 0 &&
      fraction <= retreatAt
    ) {
      this.retreating = true;
      this.retreatSeconds = 0;
    }
    if (this.retreating) {
      if (this.perception.aware) {
        this.retreatSeconds += dt;
      }
      if (recovered) {
        this.retreating = false;
        // A retreat ends behind cover with the awareness hold pinning
        // secondsSinceSeen at memorySeconds; without a fresh window the next
        // tick forgets and the healed shooter re-acquires as a new target.
        if (this.perception.aware) {
          this.perception.markSeen();
        }
      } else if (this.retreatSeconds >= this.maxRetreatSeconds) {
        this.retreating = false;
        this.lastStand = true;
        if (this.perception.aware) {
          this.perception.markSeen();
        }
      }
    }

    // The heal lands a period after application, so dropping the effect on a
    // glimpse shorter than that period and re-applying it would discard the
    // progress toward each tick, and flickering sight would never heal.
    this.regenSeenSeconds = this.regenHeld && this.perception.visible ? this.regenSeenSeconds + dt : 0;
    if (this.secondsSinceHit < Number.POSITIVE_INFINITY) {
      this.secondsSinceHit += dt;
    }
    // Deferred from onDamaged, which can fire inside GASEffectManager.tick
    // (removing an effect there shifts the loop it is iterating): a hit sets
    // the flag, and the stop lands here. The flag is consumed even when no
    // episode is held, so a hit between episodes cannot end a later one.
    const interrupted = this.regenInterrupted;
    this.regenInterrupted = false;
    if (interrupted && this.regenHeld) {
      this.stopRegen();
    }
    const unseen = this.regenHeld
      ? this.regenSeenSeconds < REGEN_PERIOD_SECONDS
      : !this.perception.visible &&
        this.perception.secondsSinceSeen >= this.regenDelaySeconds &&
        this.secondsSinceHit >= this.regenDelaySeconds;
    const wantsRegen = this.regenPerSecond > 0 && fraction < 1 && unseen;
    // The health component owns the effect (rate changes rebuild it, a refused
    // application is tried once per rate); the behavior only paces the want.
    if (wantsRegen) {
      if (this.health != null) {
        this.health.setRegenRate(this.regenPerSecond);
      } else {
        this.warnNoHealthOnce();
      }
    } else {
      this.stopRegen();
    }
    this.regenHeld = this.health?.isRegenHeld ?? false;
  }

  private stopRegen(): void {
    this.health?.clearRegen();
    this.regenHeld = false;
    this.regenSeenSeconds = 0;
  }

  private isReloading(): boolean {
    return this.gas?.hasTag(RELOADING_TAG) ?? false;
  }

  // ── Mode selection ────────────────────────────────────────────────

  private chooseMode(selfPos: Vec3, targetPos: Vec3 | null): ShooterMode {
    if (!this.perception.aware || !this.perception.lastKnownPosition) {
      return ShooterMode.Idle;
    }
    // Cornered below half of minRange, and still cornered until the target is
    // half as far again or out of sight past the grace window, so a pursuer at
    // the edge, or one blocked sight ray, does not flip the mode (and restart
    // the cover search) every tick. Only a retreat corners the shooter, but a
    // retreat that ends (recovered, or timed out into a last stand) leaves it
    // cornered until the pursuer backs off.
    if (this.retreating || this.cornered) {
      const limit = this.minRange * CORNERED_FRACTION_OF_MIN_RANGE * (this.cornered ? 1.5 : 1);
      const seen = this.perception.visible || (this.cornered && this.perception.secondsSinceVisible <= this.lostSightGraceSeconds);
      this.cornered = seen && targetPos != null && horizontalDistance(selfPos, targetPos) < limit;
    }
    // Cornered, it fights, even while reloading: it does not turn its back to
    // look for cover.
    if (this.cornered) {
      return ShooterMode.Engage;
    }
    if (this.retreating) {
      return ShooterMode.Retreat;
    }
    if (this.seekCoverWhileReloading && this.isReloading()) {
      return ShooterMode.Cover;
    }
    if (targetPos == null) {
      return ShooterMode.Search;
    }
    if (this.perception.visible) {
      return ShooterMode.Engage;
    }
    return this.inLostSightGrace() ? ShooterMode.Engage : ShooterMode.Search;
  }

  /** Engaged, and out of view for no longer than `lostSightGraceSeconds`. */
  private inLostSightGrace(): boolean {
    return this.mode === ShooterMode.Engage && this.perception.secondsSinceVisible <= this.lostSightGraceSeconds;
  }

  private setMode(next: ShooterMode): void {
    if (next === this.mode) {
      return;
    }
    const previous = this.mode;
    this.mode = next;
    this.strafeTimer = 0;
    this.sweepTimer = 0;
    this.sweepBaseYaw = null;
    this.abandonRouteCheck();
    this.routeDestination = null;
    this.routeTargetAt = null;
    this.routeProgressFrom = null;
    if (usesCover(previous) || usesCover(next)) {
      this.resetCover();
    }
    if (next === ShooterMode.Idle) {
      this.clearIntent();
      // Once, so the body stops where it forgot instead of walking on to the
      // last destination with nobody driving it.
      this.stopOnIdleLeft = STOP_ON_IDLE_SECONDS;
    }
    if (!this.logModeChanges) {
      return;
    }
    const entity = this.behaviorManager ? this.getEntity() : null;
    const health = this.gas ? `${this.gas.health.toFixed(0)}/${this.gas.maxHealth.toFixed(0)}` : 'n/a';
    console.log(
      `[ShooterCombat] ${entity?.valid ? entity.name : '<actor>'} ${previous} -> ${next} ` +
        `target=${this.perception.target?.valid ? this.perception.target.name : 'none'} hp=${health}`,
    );
  }

  private clearIntent(): void {
    this.destination = null;
    this.desiredFacing = null;
    this.moving = false;
    this.wantsToFire = false;
  }

  // ── Mode execution ────────────────────────────────────────────────

  private runMode(dt: number, selfPos: Vec3, targetPos: Vec3 | null): void {
    this.coverRetryTimer = Math.max(0, this.coverRetryTimer - dt);
    this.fleeRetryTimer = Math.max(0, this.fleeRetryTimer - dt);
    const threat = this.perception.visible && targetPos ? targetPos : this.perception.lastKnownPosition;
    // chooseMode only leaves Idle with a known position, and only picks Engage
    // with a live target; these guards keep a broken invariant from throwing in
    // the update loop.
    if (this.mode === ShooterMode.Idle || !threat) {
      this.clearIntent();
      return;
    }
    switch (this.mode) {
      case ShooterMode.Engage:
        // Inside the lost-sight grace window, threat is the last seen position:
        // the shooter does not track a target it cannot see.
        if (targetPos) {
          this.runEngage(dt, selfPos, threat);
        } else {
          this.clearIntent();
        }
        return;
      case ShooterMode.Cover:
        this.runCover(dt, selfPos, threat, false);
        this.desiredFacing = facing(selfPos, threat);
        return;
      case ShooterMode.Retreat:
        this.runCover(dt, selfPos, threat, true);
        this.desiredFacing =
          this.perception.visible && this.fireWhileRetreating
            ? facing(selfPos, threat)
            : (this.travelFacing(selfPos) ?? facing(selfPos, threat));
        return;
      case ShooterMode.Search:
        this.runSearch(dt, selfPos, threat);
        return;
    }
  }

  private runEngage(dt: number, selfPos: Vec3, targetPos: Vec3): void {
    this.desiredFacing = facing(selfPos, targetPos);
    this.strafeTimer -= dt;
    const arrived = this.destination != null && horizontalDistance(selfPos, this.destination) < ARRIVAL_DISTANCE;
    // A detour around a wall outlasts a strafe interval: re-picking mid-route
    // would find the straight line still blocked and stop the shooter to
    // re-check the path every interval. Keep it until it arrives, the shooter
    // reaches its fighting band, the target moves away from it, or the
    // shooter stops making progress along it (a route the goto can't walk).
    // A hit ends it: the dodge's reposition picks now, on the side the dodge
    // flipped to.
    if (
      !arrived &&
      this.strafeTimer <= 0 &&
      !this.dodgeRepositionPending &&
      this.followingRoute(selfPos, targetPos)
    ) {
      this.strafeTimer = lerp(this.strafeIntervalMin, this.strafeIntervalMax, this.random());
      this.routeProgressFrom = selfPos;
    }
    // A failed pick leaves no destination and waits out the timer, rather than
    // re-running the navmesh queries every frame.
    if (arrived || this.strafeTimer <= 0) {
      // A new pick supersedes the last one, including a route check still in
      // flight: the pick either finds its own point or checks a new route.
      this.abandonRouteCheck();
      this.routeDestination = null;
      this.routeTargetAt = null;
      this.routeProgressFrom = null;
      this.strafeTimer = lerp(this.strafeIntervalMin, this.strafeIntervalMax, this.random());
      if (this.dodgeRepositionPending) {
        // A dodge is owed this pick: keep its side instead of re-rolling it,
        // or the usual alternation flips the dodge straight back.
        this.dodgeRepositionPending = false;
      } else if (this.random() < 0.65) {
        // Usually alternate sides so the strafe reads as dodging, not orbiting.
        this.strafeSide = -this.strafeSide;
      }
      this.destination = this.pickStrafePoint(selfPos, targetPos);
      if (this.destination != null) {
        this.hasWarnedRouteFailed = false;
      }
    }
    this.moving = this.destination != null;
  }

  /** Drops any route check awaiting its answer, so the answer neither commits nor blocks the next check. */
  private abandonRouteCheck(): void {
    this.routeInFlight = 0;
    this.routeToken++;
  }

  /** The shooter is still making its way along a confirmed route that its target has not left. */
  private followingRoute(selfPos: Vec3, targetPos: Vec3): boolean {
    return (
      this.routeDestination != null &&
      this.destination === this.routeDestination &&
      this.routeTargetAt != null &&
      this.routeProgressFrom != null &&
      horizontalDistance(selfPos, targetPos) > this.maxRange &&
      horizontalDistance(targetPos, this.routeTargetAt) <= ROUTE_TARGET_MOVED_DISTANCE &&
      horizontalDistance(selfPos, this.routeProgressFrom) >= ROUTE_MIN_PROGRESS
    );
  }

  private pickStrafePoint(selfPos: Vec3, targetPos: Vec3): Vec3 | null {
    // A range correction is required locomotion; a strafe is optional
    // positioning. When the clamp collapses (a navmesh query failed and bailed
    // to self), in-band picks stay fail-closed — but out of band, holding the
    // stale destination plants the shooter under fire with a goal already
    // arrived, which also blinds the stuck detector. So out of band, a
    // collapse falls back to the raw point: the body walks straight at it, and
    // if geometry blocks, the wedge reads as stuck and the nudge recovers it.
    // Two guards keep the fallback honest. Only a real collapse qualifies: the
    // clamp bails to the FROM reference itself both when the query throws and
    // when the origin is off the navmesh (nothing is known reachable either
    // way), while a wall hit returns a fresh shortened point — so a
    // backed-against-a-ledge shooter is not sent past the edge, but an
    // off-mesh one still walks straight (and may re-enter the mesh). And the
    // fallback waits until both sides have been tried, so a good clamped
    // point on the flipped side always wins over the first side's raw point.
    // Past maxRange a wall hit no longer fails closed outright: the raycast
    // only says the straight line is blocked, by a wall (a doorway beside it)
    // or a ledge alike. The band point is clamped from the target instead, so
    // it lies on navmesh the target stands on, and it becomes the destination
    // only once findPath confirms the shooter can walk there; the goto then
    // routes around the wall. A ledge with no way down finds no path and
    // stays fail-closed.
    const distance = horizontalDistance(selfPos, targetPos);
    const tooFar = distance > this.maxRange;
    const outOfBand = tooFar || distance < this.minRange;
    let fallback: Vec3 | null = null;
    let routeCandidate: Vec3 | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wanted = computeStrafePoint({
        self: selfPos,
        target: targetPos,
        band: this,
        side: this.strafeSide,
        random: this.random,
      });
      const reachable = this.clampToNavMesh(selfPos, wanted);
      if (horizontalDistance(selfPos, reachable) >= MIN_USEFUL_STEP) {
        return reachable;
      }
      if (outOfBand && !fallback && horizontalDistance(selfPos, wanted) >= MIN_USEFUL_STEP) {
        if (reachable === selfPos) {
          fallback = wanted;
        } else if (tooFar && !routeCandidate) {
          const fromTarget = this.clampToNavMesh(targetPos, wanted);
          const inBand =
            fromTarget !== targetPos &&
            horizontalDistance(targetPos, fromTarget) >= this.minRange &&
            horizontalDistance(selfPos, fromTarget) >= MIN_USEFUL_STEP;
          routeCandidate = inBand ? fromTarget : null;
        }
      }
      this.strafeSide = -this.strafeSide;
    }
    if (!fallback && routeCandidate) {
      this.confirmRoute(selfPos, routeCandidate, targetPos);
    }
    return fallback;
  }

  /**
   * Makes `point` the destination once findPath reaches it from `from`, and
   * remembers it as a route toward the target at `targetAt`. The
   * query settles before the next frame. Only the live check's answer counts:
   * a later pick or a mode change abandons it, and a target change drops it,
   * so whatever decided after it wins. A path that ends short of
   * the point (another island, past a ledge) or no path leaves the shooter
   * holding, as before.
   */
  private confirmRoute(from: Vec3, point: Vec3, targetAt: Vec3): void {
    const goto = this.goto;
    // The goto's own navmesh (its crowd agent's, when it has one): the route
    // is checked on the mesh that will walk it.
    const navMesh = goto?.currentNavMesh() ?? null;
    if (!navMesh || !goto || this.routeInFlight !== 0) {
      return;
    }
    const token = ++this.routeToken;
    const target = this.target;
    let query: Promise<Maybe<Vec3[]>>;
    try {
      // The goto's own limits: a route it would truncate or fail to snap reads as no route.
      query = navMesh.findPath(from, point, {
        maxPathSize: goto.navMeshMaxPathSize,
        maxSearchDistance: goto.navMeshSnapDistance,
      });
    } catch (error: unknown) {
      this.warnRouteFailedOnce(error);
      return;
    }
    this.routeInFlight = token;
    query.then(
      (path: Maybe<Vec3[]>) => {
        if (token !== this.routeInFlight) {
          return;
        }
        this.routeInFlight = 0;
        this.hasWarnedRouteFailed = false;
        const end: Vec3 | null = path != null && path.length > 0 ? path[path.length - 1] : null;
        if (
          end != null &&
          horizontalDistance(end, point) < ARRIVAL_DISTANCE &&
          this.mode === ShooterMode.Engage &&
          this.target === target
        ) {
          this.destination = point;
          this.moving = true;
          this.routeDestination = point;
          this.routeTargetAt = targetAt;
          this.routeProgressFrom = from;
        }
      },
      (error: unknown) => {
        // An abandoned check failing says nothing about the live one.
        if (token !== this.routeInFlight) {
          return;
        }
        this.routeInFlight = 0;
        this.warnRouteFailedOnce(error);
      },
    );
  }

  /** A failing route query leaves a walled-off shooter holding; say why, once per run of failures. */
  private warnRouteFailedOnce(error: unknown): void {
    if (this.hasWarnedRouteFailed) {
      return;
    }
    this.hasWarnedRouteFailed = true;
    const name = this.behaviorManager?.actorEntity.name ?? 'unknown actor';
    console.warn(
      `[ShooterCombat] '${name}' could not check a route around the wall to its target ` +
        `(findPath failed: ${String(error)}), so it holds where it is until the next pick.`,
    );
  }

  private runCover(dt: number, selfPos: Vec3, threat: Vec3, awayFromThreat: boolean): void {
    if (this.coverPoint) {
      const atCover = horizontalDistance(selfPos, this.coverPoint) < ARRIVAL_DISTANCE;
      this.coverSeenSeconds = atCover && this.perception.visible ? this.coverSeenSeconds + dt : 0;
      const compromised = this.coverSeenSeconds >= COVER_COMPROMISED_SECONDS;
      if (compromised || movedFrom(threat, this.coverThreat)) {
        this.coverPoint = null;
        this.coverSeenSeconds = 0;
        this.coverRetryTimer = COVER_RESEARCH_SECONDS;
        // Seen at its cover, it backs off now; otherwise it holds course for
        // the re-search.
        this.coverResearchDue = !compromised;
      }
    }
    if (!this.coverPoint) {
      this.requestCoverSearch(selfPos, threat, awayFromThreat);
    }

    let destination: Vec3;
    if (this.coverPoint) {
      // A retry delay set for an earlier, boxed-in spot does not carry over.
      this.fleePoint = null;
      this.fleeRetryTimer = 0;
      destination = this.coverPoint;
    } else if ((this.coverPending || this.coverResearchDue) && this.fleePoint == null && !awayFromThreat) {
      // Hold course until the search answers, rather than set off for a flee
      // point and turn back for the cover point; but stop rather than hold a
      // course that closes on the threat (a Search toward it, say). A retreat
      // sets off at once: its course so far may lead toward the threat.
      const held = this.destination;
      const closestAllowed = Math.min(this.minRange, horizontalDistance(selfPos, threat));
      destination = held && distanceToSegment(threat, selfPos, held) >= closestAllowed ? held : selfPos;
    } else {
      // No cover: open the distance (pickFleePoint), a retreat at least to
      // maxRange. The point is kept until reached or the threat moves; with no
      // room anywhere (boxed in) it is retried only every COVER_RETRY_SECONDS,
      // so neither re-paths the goto nor re-runs the navmesh queries every frame.
      let flee = this.fleePoint;
      const reached = flee != null && horizontalDistance(selfPos, flee) < ARRIVAL_DISTANCE;
      const moved = movedFrom(threat, this.fleeThreat);
      // A reached point that already opened enough ground holds: re-picking on
      // every arrival chains flee legs into a cross-map run. Only a threat that
      // closed back in (or moved) earns a new point.
      const stillClose = horizontalDistance(selfPos, threat) < this.fleeNeed;
      if ((flee == null || moved || (reached && stillClose)) && (this.fleeRetryTimer <= 0 || moved)) {
        this.fleeThreat = threat;
        const opened = horizontalDistance(selfPos, threat) + this.strafeDistance;
        const fleeDistance = awayFromThreat ? Math.max(this.maxRange, opened) : opened;
        flee = this.pickFleePoint(selfPos, threat, fleeDistance);
        this.fleePoint = flee;
        if (horizontalDistance(selfPos, flee) < MIN_USEFUL_STEP) {
          // Boxed in: the pick opened no ground, so it must not hold — an
          // infinite need keeps the retry timer pacing re-picks as before.
          this.fleeNeed = Number.POSITIVE_INFINITY;
          this.fleeRetryTimer = COVER_RETRY_SECONDS;
        } else {
          // Hold what the point actually opened, minus the arrival tolerance:
          // arrival stops up to ARRIVAL_DISTANCE short of the point, so
          // holding the asked distance would re-pick on every arrival and
          // chain legs. Clamped at zero: a point nearer the threat than the
          // tolerance still holds once reached.
          this.fleeNeed = Math.max(0, horizontalDistance(flee, threat) - ARRIVAL_DISTANCE);
        }
      }
      destination = flee ?? selfPos;
    }
    this.destination = destination;
    this.moving = horizontalDistance(selfPos, destination) >= ARRIVAL_DISTANCE;
  }

  private runSearch(dt: number, selfPos: Vec3, goal: Vec3): void {
    const toGoal = horizontalDistance(selfPos, goal);
    if (toGoal >= ARRIVAL_DISTANCE) {
      this.sweepBaseYaw = null;
      this.destination = goal;
      this.moving = true;
      this.desiredFacing = this.travelFacing(selfPos) ?? facing(selfPos, goal);
      return;
    }
    // Arrived and still nothing: sweep the view either side of the arrival heading.
    this.destination = null;
    this.moving = false;
    if (this.sweepBaseYaw === null) {
      const base = this.desiredFacing ?? this.selfTransform?.worldForward ?? new Vec3(0, 0, 1);
      this.sweepBaseYaw = Math.atan2(base.x, base.z);
      this.sweepTimer = 0;
    }
    this.sweepTimer += dt;
    const side = Math.floor(this.sweepTimer / SEARCH_SWEEP_PERIOD) % 2 === 0 ? 1 : -1;
    const yaw = this.sweepBaseYaw + side * SEARCH_SWEEP_HALF_ANGLE;
    this.desiredFacing = new Vec3(Math.sin(yaw), 0, Math.cos(yaw));
  }

  private travelFacing(selfPos: Vec3): Vec3 | null {
    const waypoint = this.moving ? this.goto?.getCurrentWaypoint() ?? this.destination : null;
    return waypoint ? facing(selfPos, waypoint) : null;
  }

  // ── Firing ────────────────────────────────────────────────────────

  private computeWantsToFire(selfPos: Vec3, targetPos: Vec3 | null): boolean {
    if (!targetPos || !this.perception.visible || this.perception.visibleSeconds < this.perception.attentionDelay) {
      return false;
    }
    const fireMode =
      this.mode === ShooterMode.Engage || (this.mode === ShooterMode.Retreat && this.fireWhileRetreating);
    const reach = this.weaponReach();
    if (reach < this.minRange) {
      this.warnUnarmedOnce(reach);
    }
    if (reach < 0) {
      return false;
    }
    if (!fireMode || targetPos.sub(selfPos).magnitude() > Math.min(this.fireRange, reach)) {
      return false;
    }
    const forward = this.selfTransform?.worldForward;
    if (!forward) {
      return false;
    }
    const want = facing(selfPos, targetPos);
    if (!want) {
      // Straight above or below: there is no direction to face it in.
      return false;
    }
    const fx = forward.x;
    const fz = forward.z;
    const flen = Math.sqrt(fx * fx + fz * fz);
    if (flen < 1e-4) {
      return false;
    }
    const cos = (fx * want.x + fz * want.z) / flen;
    return cos >= Math.cos((this.fireConeDeg * Math.PI) / 180);
  }

  /**
   * Longest reach (m) among attack controllers that fire a GAS weapon, or -1
   * when none does. The shooter pulls the trigger only inside it: a mounted
   * directed melee hit (BaseActor's fists) lands on its target at any range,
   * so firing fists from shooting range would land the punch.
   */
  private weaponReach(): number {
    const controllers = this.behaviorManager?.getControllers<IActorAttackController>(IActorAttackControllerTypeId);
    let reach = -1;
    for (const controller of controllers ?? []) {
      // A controller that fires a weapon but names no finite reach is not a
      // weapon the shooter can range: it contributes nothing, so the shooter
      // warns it is unarmed instead of firing at any distance.
      if (controller.attacksThroughWeapon === true && Number.isFinite(controller.attackReach)) {
        reach = Math.max(reach, controller.attackReach as number);
      }
    }
    return reach;
  }

  /** Regen is paced but no health component owns the heal: say so once. */
  private warnNoHealthOnce(): void {
    if (this.hasWarnedNoHealth) {
      return;
    }
    this.hasWarnedNoHealth = true;
    console.warn(
      '[ShooterCombat] regenPerSecond is set but the actor has no ActorGASHealthComponent, so regeneration stays off',
    );
  }

  private warnUnarmedOnce(reach: number): void {    if (this.hasWarnedUnarmed) {
      return;
    }
    this.hasWarnedUnarmed = true;
    const entity = this.behaviorManager ? this.getEntity() : null;
    const name = entity?.valid ? entity.name : '<actor>';
    const problem =
      reach < 0
        ? 'has no weapon its attack controller fires, so it will not shoot'
        : `has only a ${reach} m weapon, shorter than its closest fighting distance, so it rarely shoots`;
    console.warn(
      `[ShooterCombat] '${name}' sees its target but ${problem}. Put a gun item in its ItemSystem loadout ` +
        "(its ItemSystem child's loadout initialItems, e.g. rifle and ammo_556*90).",
    );
  }

  private attackReady(): boolean {
    const controllers = this.behaviorManager?.getControllers<IActorAttackController>(IActorAttackControllerTypeId);
    if (!controllers || !this.perception.target) {
      return false;
    }
    const distance = this.targetDistance();
    for (const controller of controllers) {
      if (firesWeaponAt(controller, distance) && controller.canAttack(this.perception.target)) {
        return true;
      }
    }
    return false;
  }

  /** Seconds since the last fired shot; starts elapsed so the first shot is immediate. */
  private secondsSinceLastShot: number = Number.POSITIVE_INFINITY;

  /** True once `minSecondsBetweenShots` has passed since the last shot. */
  private shotPacingElapsed(): boolean {
    return this.secondsSinceLastShot >= Math.max(0, this.minSecondsBetweenShots);
  }

  /** Root-to-root distance (m) to the target, or Infinity when either is unplaced. */
  private targetDistance(): number {
    const targetPos = this.perception.target?.getComponent(TransformComponent)?.worldPosition;
    const selfPos = this.selfTransform?.worldPosition;
    return targetPos && selfPos ? targetPos.sub(selfPos).magnitude() : Number.POSITIVE_INFINITY;
  }

  // ── Cover search ──────────────────────────────────────────────────

  /**
   * Where to back off to: straight away from the threat to `distance` from it,
   * or, with a wall behind, the first turn of 45° then 90° either side that
   * still gives a useful step. With no room anywhere, the shooter's position.
   */
  private pickFleePoint(selfPos: Vec3, threat: Vec3, distance: number): Vec3 {
    const straight = computeFleePoint(selfPos, threat, distance);
    const stepX = straight.x - selfPos.x;
    const stepZ = straight.z - selfPos.z;
    for (const angle of FLEE_TURNS) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const wanted = new Vec3(selfPos.x + stepX * cos - stepZ * sin, straight.y, selfPos.z + stepX * sin + stepZ * cos);
      const reachable = this.clampToNavMesh(selfPos, wanted);
      if (horizontalDistance(selfPos, reachable) >= MIN_USEFUL_STEP) {
        return reachable;
      }
    }
    return selfPos;
  }

  private requestCoverSearch(selfPos: Vec3, threat: Vec3, awayFromThreat: boolean): void {
    if (this.coverPending || this.coverRetryTimer > 0 || !this.behaviorManager) {
      return;
    }
    const candidates: Vec3[] = [];
    // Already inside minRange: just never get closer than it is now.
    const closestAllowed = Math.min(this.minRange, horizontalDistance(selfPos, threat));
    for (const raw of generateCoverCandidates(selfPos, threat, this.coverSearchRadius, awayFromThreat)) {
      const reachable = this.clampToNavMesh(selfPos, raw);
      if (horizontalDistance(selfPos, reachable) < MIN_USEFUL_STEP) {
        continue;
      }
      // Not toward the threat: a shooter that cannot fire must not close inside
      // its fighting distance, at the cover point or on the way there.
      if (distanceToSegment(threat, selfPos, reachable) < closestAllowed) {
        continue;
      }
      if (candidates.some(c => horizontalDistance(c, reachable) < COVER_DEDUPE_DISTANCE)) {
        continue;
      }
      candidates.push(reachable);
    }
    candidates.sort((a, b) => horizontalDistance(selfPos, a) - horizontalDistance(selfPos, b));
    const tested = candidates.slice(0, COVER_MAX_CANDIDATES);
    this.coverResearchDue = false;
    if (tested.length === 0) {
      this.coverRetryTimer = COVER_RETRY_SECONDS;
      return;
    }

    this.coverPending = true;
    const token = ++this.coverToken;
    const self = this.getEntity();
    const ignore: IgnoredRoots = this.perception.target ? [self, this.perception.target] : [self];
    const searchedFrom = new Vec3(threat.x, threat.y, threat.z);
    const threatEye = threat.add(new Vec3(0, this.coverEyeHeight, 0));
    const lift = new Vec3(0, this.coverEyeHeight, 0);
    // A ray that fails counts as clear (no cover there), so one failure does not
    // discard the rest.
    const rays = tested.map(c => this.sightQuery.isWorldClear(threatEye, c.add(lift), ignore).catch(() => true));
    void Promise.all(rays).then(
      clearFlags => {
        if (token !== this.coverToken) {
          return;
        }
        this.coverPending = false;
        // Hidden from where the threat was, not necessarily from where it is:
        // search again from its new position. Only a move the shooter has seen
        // counts; an unseen target's moves are unknown to it, so cover from its
        // last known position is the best it can do.
        const now = this.perception.lastKnownPosition;
        if (now && movedFrom(now, searchedFrom)) {
          this.coverRetryTimer = COVER_RESEARCH_SECONDS;
          this.coverResearchDue = true;
          return;
        }
        const index = clearFlags.findIndex(clear => !clear);
        this.coverPoint = index >= 0 ? tested[index] : null;
        this.coverThreat = this.coverPoint ? searchedFrom : null;
        if (!this.coverPoint) {
          this.coverRetryTimer = COVER_RETRY_SECONDS;
        }
      },
    );
  }

  // ── Movement plumbing ─────────────────────────────────────────────

  private updateGoto(dt: number): void {
    const goto = this.goto;
    if (!goto) {
      return;
    }
    goto.desiredSpeed = this.mode === ShooterMode.Retreat ? this.retreatSpeed : this.moveSpeed;
    goto.stuckNudgeSeconds = this.stuckNudgeSeconds;
    goto.stuckNudgeDistance = this.stuckNudgeDistance;
    if (!this.moving || !this.destination) {
      return;
    }
    if (!this.gotoTarget || horizontalDistance(this.gotoTarget, this.destination) > RETARGET_MIN_MOVE) {
      this.gotoTarget = this.destination;
      goto.targetPosition = this.destination;
    }
    goto.update(dt);
  }

  /**
   * `to`, pulled back to just short of the first navmesh edge on the straight
   * line from `from`, so a chosen point is never inside a wall or off a ledge.
   * With no navmesh in the world the point is returned unchanged; when
   * navmeshes exist but none is picked for this actor here, or the query fails
   * (`from` off the navmesh, or the query throws), `from` is returned.
   */
  protected clampToNavMesh(from: Vec3, to: Vec3): Vec3 {
    const navMesh = this.resolveNavMesh();
    if (!navMesh) {
      return this.navMeshLookup.isWorldWithoutNavMesh() ? to : from;
    }
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 0.01) {
      return to;
    }
    const dir = new Vec3(dx / length, 0, dz / length);
    let hit;
    try {
      hit = navMesh.raycast(from, dir, length, {maxSearchDistance: NAVMESH_SNAP_TOLERANCE});
    } catch {
      // Nothing is known to be reachable: fail closed, as for an off-navmesh origin.
      return from;
    }
    if (hit.hit) {
      const reach = Math.max(0, hit.distance - NAVMESH_WALL_BACKOFF);
      return new Vec3(from.x + dir.x * reach, to.y, from.z + dir.z * reach);
    }
    if (hit.distance <= 0) {
      // Query failed (origin off the navmesh): nothing is known to be reachable,
      // so stay put; callers drop a point this close as not worth moving to.
      return from;
    }
    return to;
  }

  private resolveNavMesh(): NavMeshComponent | null {
    return this.navMeshLookup.resolveFor(this.behaviorManager?.actorEntity ?? null);
  }
}

function usesCover(mode: ShooterMode): boolean {
  return mode === ShooterMode.Cover || mode === ShooterMode.Retreat;
}

/** Whether `threat` is more than COVER_THREAT_MOVED_DISTANCE from where it was (`was`). */
function movedFrom(threat: Vec3, was: Vec3 | null): boolean {
  return was != null && horizontalDistance(threat, was) > COVER_THREAT_MOVED_DISTANCE;
}

/** Closest horizontal distance from `point` to the segment from `a` to `b`. */
function distanceToSegment(point: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 1e-9 ? Math.min(1, Math.max(0, ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSq)) : 0;
  const dx = point.x - (a.x + abx * t);
  const dz = point.z - (a.z + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Unit XZ direction from `from` to `to`, or null when they coincide. */
function facing(from: Vec3, to: Vec3): Vec3 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.sqrt(dx * dx + dz * dz);
  return length > 0.001 ? new Vec3(dx / length, 0, dz / length) : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/** Whether `attack` fires a weapon whose reach covers `distance`. A weapon with no finite reach never does. */
function firesWeaponAt(attack: IActorAttackController, distance: number): boolean {
  return (
    attack.attacksThroughWeapon === true &&
    Number.isFinite(attack.attackReach) &&
    distance <= (attack.attackReach as number)
  );
}

const GAS_RETRY_SECONDS = 1.0;
