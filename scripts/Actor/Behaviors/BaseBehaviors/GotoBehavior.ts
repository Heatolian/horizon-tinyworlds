/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  Vec3,
  TransformComponent,
  NavMeshComponent,
  CharacterControllerBase,
} from 'meta/worlds';
import type { Maybe } from 'meta/worlds';
import { NavMeshLookup } from '../../../Navigation/NavMeshLookup';
import { logActorBehavior } from '../../Utilities/ActorBehaviorLog';
import {ActorNavMeshAgentDriver} from '../../Controllers/Implementations/ActorNavMeshAgentDriver';
import type {IActorJump} from '../../Controllers/Definitions/IActorJump';
import { ActorBehavior } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import type { ActorController } from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  type ActorMovementController,
  ActorMoveParams,
  ActorPathSegment,
} from 'meta/worlds';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';

/** Reusable XZ-plane mask (Y zeroed) for horizontal distance checks. */
const XZ_MASK = new Vec3(1, 0, 1);

/**
 * A destination gets an `is heading to` line only this far (XZ) from the actor
 * and from the last one logged: closer to the actor it is a stop, not a goal,
 * and closer to the last one it is the same goal nudged.
 */
const GOAL_LOG_MIN_M = 1.0;

/** Compact XZ formatter for the path-outcome observability logs. */
function fmtXZ(v: Vec3): string {
  return `(${v.x.toFixed(1)},${v.z.toFixed(1)})`;
}

/**
 * Higher-precision XZ formatter for the [GotoTrace] samples. Those are consumed
 * as measurements (distance to a goal, inside/outside an obstacle footprint),
 * where fmtXZ's 0.1 rounding is a tenth of a typical wall thickness.
 */
function fmtXZPrecise(v: Vec3): string {
  return `(${v.x.toFixed(3)},${v.z.toFixed(3)})`;
}

// Minimum update ticks between periodic repaths, gated together with
// repathInterval (a wall-clock floor). A low frame rate gives too few ticks
// per interval to advance past path[0] (which sits at the actor's own
// position), so without a frame floor the actor repaths itself back to the
// start every cycle and never leaves spawn.
const MIN_UPDATES_PER_REPATH = 10;

/** Cadence (seconds) between [GotoTrace] position samples while travelling. */
const TRACE_INTERVAL = 0.5;

/**
 * Minimum frame time (seconds) for [GotoTrace] to emit at all.
 *
 * The trace exists for the headless character-eval runtime, which ticks far
 * slower than any shipping build, so frame time doubles as the environment
 * discriminator: a live game stays silent without a build flag the eval
 * worlds have no way to set. Calibrated, not guessed: two
 * `navmesh_wall_detour` anvil runs (n=2882) measured min 0.181 / median 0.249 /
 * max 0.589s, so this value sits ~3.6x below the slowest eval frame and ~3x
 * above a 60Hz game (0.017).
 */
const TRACE_MIN_DELTA_S = 0.05;

/**
 * XZ magnitude below which a transform read is the unset (0,0,0) default rather
 * than a real position.
 */
const UNSET_TRANSFORM_EPSILON = 1e-4;

/**
 * Smoothing factor for the exponential mean frame time — a ~20-frame time
 * constant, so a lone hitch moves the mean by 1/20th of its excess.
 *
 * WHY 20 and not a longer window: the mean's only job is rejecting a lone
 * hitch, because {@link GotoBehavior.getRuntimeStopDistance}'s `min` already
 * collapses the band on any fast frame. A longer constant buys no extra
 * hitch rejection and costs recovery time when a host genuinely degrades.
 */
const DELTA_TIME_SMOOTHING = 1 / 20;

/**
 * GotoBehavior — moves an actor to a target position.
 *
 * Uses the actor's server-simulated `NavMeshAgentComponent` when present, feeding
 * its avoidance position and speed through the movement controller. Path queries
 * on the agent's linked mesh are retained for remaining-route distance only.
 * Otherwise auto-detects a `NavMeshComponent` and follows its path, with a
 * straight-line fallback when no usable path is available.
 *
 * Set `forceStraightLine = true` to opt out of NavMesh use entirely (cutscene
 * puppets, tutorial actors, deliberately ground-confined entities).
 *
 * `findPath` is async (`Promise<Maybe<Vec3[]>>`); the synchronous `update()`
 * fires-and-forgets the repath and writes the result into `currentPath` when
 * it resolves. The `pathReady` guard suppresses movement until the first
 * resolution to avoid driving toward a stale or default target.
 */
export class GotoBehavior extends ActorBehavior {
  override name: string = 'GotoBehavior';
  private targetPositionValue!: Vec3;
  desiredSpeed: number = 1.0;

  /**
   * Configured arrival tolerance (meters, XZ), and the floor of
   * {@link getRuntimeStopDistance}.
   *
   * Two sites widen it on a slow host — waypoint advance and body-direction
   * release, both steering decisions. Three read it raw: the repath-change
   * test (compares two authored positions), stall detection (a diagnostic the
   * widening would blind), and the `[GotoTrace]` arrival latch (the eval's
   * pass criterion, which must not move with the mitigation it grades).
   */
  distanceToStop: number = 0.1;
  verticalThreshold: number = 0.3;
  // Repath with this interval so that the actor can respond to blocked path.
  // Fallback interval only; assigning targetPosition repaths immediately, so
  // this can be large. Tuned for a static destination; entity-following
  // behaviors pass through a smaller value to re-route as the target moves.
  repathInterval: number = 3.0;

  // Assigning targetPosition repaths immediately when true (discrete goto).
  // When false the target is only stored; repaths run on repathInterval, for
  // continuous trackers (Follow/Flee) that reassign the target every frame.
  repathOnTargetChange: boolean = true;

  // ── Body direction ─────────────────────────────────────────────────
  /**
   * When true (the default), a bare GotoBehavior rotates the actor to face its
   * travel direction — the XZ heading toward the path waypoint it is steering
   * toward — by driving the body-direction controller itself. This makes an
   * actor moved by a plain GotoBehavior turn to look where it walks without any
   * extra behavior (and without a hand-rolled per-frame rotation).
   *
   * Behaviors that compose a GotoBehavior and own body direction themselves
   * (FollowBehavior, FleeBehavior, IdleWanderBehavior, LeadBehavior,
   * SimpleFetchBehavior, UseItemBehavior) set this false on their nested goto
   * so it does not compete with them for the controller.
   */
  shouldFaceDirection: boolean = true;

  /** Angular speed (rad/s) for travel-direction rotation. 3.14 ≈ 180°/s. */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── NavMesh integration ────────────────────────────────────────────
  /** Skip NavMesh discovery and pathfinding; always use straight-line. */
  forceStraightLine: boolean = false;
  /** Snap radius (m) passed to `findPath` for projecting off-mesh endpoints. */
  navMeshSnapDistance: number = 2;
  /** Cap on number of path points returned by `findPath`. */
  navMeshMaxPathSize: number = 50;

  protected transformComponent!: TransformComponent;

  /**
   * Character controller driving this actor, when one exists. Null for actors
   * moved by direct transform writes.
   */
  protected characterController: CharacterControllerBase | null = null;

  protected currentPath: Vec3[] = [];
  protected currentTargetIndex: number = 0;
  protected repathTimer: number = 0;

  /** Update ticks since the last repath; frame-floor half of the repath gate. */
  protected framesSincePath: number = 0;

  /**
   * False until the first repath has resolved. Suppresses movement during
   * the gap between `initialize()` and the first async findPath result.
   */
  protected pathReady: boolean = false;

  /** Token used to ignore stale findPath results when a newer repath fires. */
  private repathToken: number = 0;

  /** Set by abandonPath() until the next repath starts. */
  private pathAbandoned: boolean = false;

  private readonly navMeshLookup = new NavMeshLookup({owner: 'GotoBehavior'});
  private navMeshDriver: ActorNavMeshAgentDriver | null = null;

  /**
   * True once we've warned about an apparently-unbaked NavMesh for this actor,
   * to avoid spamming the log every repath cycle.
   */
  private warnedUnbaked: boolean = false;

  /**
   * Last path-outcome tag emitted by {@link logPathOutcome}, so observability
   * logs fire only when the outcome changes rather than every repath cycle.
   */
  private lastPathOutcome: string = '';

  /**
   * Observability: emit the navmesh path outcome (permanent, unconditional
   * `console.log`) whenever it changes for this actor. findPath success and the
   * "no NavMeshComponent → straight-line" branch are otherwise silent, so a
   * headless/eval run cannot tell a real detour path from a straight-line
   * fallback. Deduped on the outcome tag to avoid per-frame spam; transitions
   * (e.g. PATH_DETOUR → NO_PATH) still re-log because they are signal.
   */
  private logPathOutcome(outcome: string, detail: string): void {
    if (outcome === this.lastPathOutcome) {
      return;
    }
    this.lastPathOutcome = outcome;
    console.log(`[GotoFindPath] ${this.actorLabel()} ${outcome} ${detail}`);
  }

  /** Physical-stall observability: last XZ position, no-progress timer, latch. */
  private stuckLastPos: Vec3 | null = null;
  private stuckTimer: number = 0;
  private stuckLogged: boolean = false;
  /**
   * The waypoint a stall episode is sidestepping from, with its repeat count
   * and the frozen sidestep axis. The axis is captured from the first nudge
   * and reused: recomputing it from the live position each time would rotate
   * it as the body slides, and the alternating sides would stop mirroring the
   * original corridor. A fresh path, arrival, or detour consumption clears it;
   * plain progress does not, so the episode survives the post-nudge slide and
   * the next stall re-bases instead of steering off a dead waypoint.
   */
  private nudgeAnchor: {index: number; point: Vec3; perpX: number; perpZ: number; count: number; inserted: boolean} | null = null;

  /**
   * Seconds of no XZ progress after which a stalled actor nudges itself free.
   * The nudge sidesteps the current waypoint — inserting a temporary detour
   * ahead of a final one, never moving the goal — so a blocked corridor is
   * re-entered from a different angle while a reachable goal still completes.
   * 0 (default) keeps the log-only stall detection, as before.
   */
  stuckNudgeSeconds: number = 0;
  /** Sideways distance (m) of each stuck nudge. */
  stuckNudgeDistance: number = 1.0;

  /**
   * Movement-command observability. The STUCK detector proves the body is not
   * advancing, but not WHY: a zombie can be stuck because the movement
   * controller is still commanding it and physics/geometry pins it in place, or
   * because this behavior lost the controller to a competing behavior (e.g. an
   * EngageCombat that ties on priority) and is no longer being driven at all.
   * These counters make that fork observable — `useController` bumps them every
   * time the framework actually hands this behavior the movement controller, so
   * a stall line can report "still commanded N frames ago" vs "never / long
   * ago". `frameCount` is a monotonic tick counter to anchor the "how long ago".
   */
  private frameCount: number = 0;
  private moveCmdCount: number = 0;
  private lastMoveCmdFrame: number = -1;
  private firstMoveCmdLogged: boolean = false;

  /**
   * Observability: detect when the actor has a path and is not yet at the goal
   * but has physically stopped advancing (XZ speed ~0) for a sustained window —
   * i.e. findPath returned a route the mover cannot traverse (stuck on geometry,
   * corner it cannot round, gap narrower than its collision radius). Logs the
   * stall position once per stall (re-arms if it starts moving again). This is
   * the signal the navmesh/findPath logs cannot give: a valid path that the body
   * fails to follow. Permanent, unconditional console.log.
   */
  private updateStuckDetection(deltaTime: number): void {
    const pos = this.getPosition();
    const goalXZ = this.targetPosition
      .sub(pos)
      .componentMul(XZ_MASK)
      .magnitude();
    // WHY the raw value and not getRuntimeStopDistance(): this disarms the
    // stall diagnostic, it is not an arrival decision. Widening it would blind
    // the detector across a metre-scale radius on exactly the slow hosts the
    // detector was written for.
    if (!this.pathReady || goalXZ <= this.distanceToStop) {
      this.stuckTimer = 0;
      this.stuckLogged = false;
      this.clearNudgeAnchor();
      this.stuckLastPos = pos;
      return;
    }
    const moved =
      this.stuckLastPos != null
        ? pos.sub(this.stuckLastPos).componentMul(XZ_MASK).magnitude()
        : 0;
    this.stuckLastPos = pos;
    // Below ~0.05 m/s of XZ travel this frame = effectively not advancing.
    if (moved < 0.05 * deltaTime + 1e-4) {
      this.stuckTimer += deltaTime;
    } else {
      // Progress resets the stall clock, but not the nudge anchor: the slide
      // toward a sidestep is movement, and dropping the episode here would
      // orphan the detour and restart alternation on the next stall. The
      // anchor lives until a fresh path, arrival, or detour consumption.
      this.stuckTimer = 0;
      this.stuckLogged = false;
    }
    if (this.stuckTimer >= 2.0 && !this.stuckLogged) {
      this.stuckLogged = true;
      const wp = this.getCurrentTargetPosition();
      // moveCmds/lastMoveCmdFrame are the fork: a stall while still being
      // commanded (lastMoveCmdFrame ≈ frameCount) is a physics/geometry pin; a
      // stall with 0 commands or a stale lastMoveCmdFrame means this behavior
      // never got, or lost, the movement controller (priority-tie starvation).
      console.log(
        `[GotoFindPath] ${this.actorLabel()} STUCK at ${fmtXZ(
          pos,
        )} dist_to_goal=${goalXZ.toFixed(1)} wp ${this.currentTargetIndex}/${this.currentPath.length
        } moveCmds=${this.moveCmdCount} lastCmdFrame=${this.lastMoveCmdFrame
        }/${this.frameCount}` + (wp ? ` steering->${fmtXZ(wp)}` : ''),
      );
    }
    if (this.stuckNudgeSeconds > 0 && this.stuckTimer >= this.stuckNudgeSeconds) {
      this.nudgeAroundWaypoint(pos);
    }
  }

  /**
   * Recovery for a detected stall: steps the current waypoint sideways so the
   * next frames steer around whatever pins the body, then resets the stall
   * clock (but not the log latch, so the stall still reads as one stall). The
   * first nudge of an episode also grants the sidestep a full repath interval —
   * a periodic repath landing right after would otherwise rebuild the blocking
   * route and drop the nudge, as would an in-flight path result, which the
   * token bump discards. A
   * stalled final waypoint (straight-line and direct paths) inserts a
   * temporary sidestep ahead of the goal instead of moving the arrival test
   * off the authored destination; repeat nudges replace that sidestep rather
   * than stacking more. Repeated stalls alternate sides around the waypoint
   * the episode started from (left, right, then a larger left), so the target
   * zigzags out instead of spiraling one way into the blocker.
   */
  private nudgeAroundWaypoint(pos: Vec3): void {
    this.stuckTimer = 0;
    const index = this.currentTargetIndex;
    if (index < 0 || index >= this.currentPath.length) {
      return;
    }
    let anchor = this.nudgeAnchor;
    if (!anchor || anchor.index !== index) {
      const wp = this.currentPath[index];
      const bx = wp.x - pos.x;
      const bz = wp.z - pos.z;
      const blen = Math.sqrt(bx * bx + bz * bz);
      if (blen < 1e-4) {
        // Flush against the waypoint: nothing to sidestep around, and no
        // clock or token is touched, so a denied nudge never starves repaths.
        return;
      }
      anchor = {index, point: new Vec3(wp.x, wp.y, wp.z), perpX: -bz / blen, perpZ: bx / blen, count: 0, inserted: false};
      this.nudgeAnchor = anchor;
    }
    // The first nudge of an episode grants the sidestep a full repath interval,
    // and any in-flight path result predating it is stale: a periodic repath
    // landing right after would otherwise rebuild the blocking route and drop
    // the nudge. Once per episode, not per repeat nudge, or the resets and the
    // token bump would starve every repath while the body stays pinned.
    if (anchor.count === 0) {
      this.repathTimer = 0;
      this.framesSincePath = 0;
      this.repathToken++;
    }
    const side = anchor.count % 2 === 0 ? 1 : -1;
    // Widening pairs zigzag out (left, right, then larger), but the growth is
    // capped: a body that never moves would otherwise walk the waypoint
    // metres off.
    const pair = Math.min(Math.floor(anchor.count / 2), 3);
    const distance = Math.max(0.1, this.stuckNudgeDistance) * (1 + 0.5 * pair);
    const nudged = new Vec3(
      anchor.point.x + anchor.perpX * side * distance,
      anchor.point.y,
      anchor.point.z + anchor.perpZ * side * distance,
    );
    anchor.count++;
    if (index >= this.currentPath.length - 1 && !anchor.inserted) {
      this.currentPath.splice(index, 0, nudged);
      anchor.inserted = true;
    } else {
      this.currentPath[index] = nudged;
    }
  }

  /** [GotoTrace] cadence accumulator and one-shot arrival latch. */
  private traceTimer: number = 0;
  private traceArrivalLogged: boolean = false;

  /**
   * Observability: emit this actor's OWNER-side XZ position on a fixed cadence
   * while it is travelling, plus one line the moment it arrives.
   *
   * The [GotoFindPath] markers report which route the navmesh returned; they do
   * not report where the body actually went. A WebDriver reader cannot recover
   * that either: the entity endpoints resolve the CLIENT world
   * (TravelFramework::getWorldContext defaults to world::kClient), where a
   * server-simulated NPC is a replica whose transform is interpolated between
   * network snapshots. This trace runs on the owner, so it is the position the
   * simulation actually produced, before replication.
   *
   * Gated on isOwned() so a proxy copy on another endpoint cannot emit an
   * interpolated duplicate of the same actor, and on pathReady so an actor that
   * has not begun travelling stays silent.
   */
  private updateTrace(deltaTime: number): void {
    if (!this.pathReady || !this.getEntity().isOwned()) {
      return;
    }
    // Frame-time gate: silent in a live game, active in the slow headless eval
    // runtime. See TRACE_MIN_DELTA_S.
    if (deltaTime <= TRACE_MIN_DELTA_S) {
      return;
    }
    const pos = this.getPosition();
    // A freshly created actor reads the unset (0,0,0) transform for the ticks
    // between entity creation and the spawner writing its spawn position.
    // Dropping those reads stays safe in a world whose obstacle straddles the
    // origin: a real crossing spans the obstacle's whole thickness over several
    // samples, so losing the one that lands within epsilon of dead centre
    // cannot change a clip verdict, whereas keeping the unset reads would
    // manufacture one.
    if (
      Math.abs(pos.x) < UNSET_TRANSFORM_EPSILON &&
      Math.abs(pos.z) < UNSET_TRANSFORM_EPSILON
    ) {
      return;
    }
    const goalXZ = this.targetPosition
      .sub(pos)
      .componentMul(XZ_MASK)
      .magnitude();
    // WHY the raw value and not getRuntimeStopDistance(): this latch is the
    // eval's pass criterion, and the widened band is the mitigation under test.
    // Grading the mitigation with a threshold that moves with it lets a run go
    // green because the band grew rather than because the NPC arrived — at 5m/s
    // on a 0.5s host that is a 2.5m acceptance radius. The band the actor was
    // actually steering by is reported on the cadence line instead.
    if (goalXZ <= this.distanceToStop) {
      // Latched rather than rate-limited: a world that destroys an actor on
      // arrival can remove it on this very tick, so the arrival sample must not
      // wait for the next cadence slot.
      if (!this.traceArrivalLogged) {
        this.traceArrivalLogged = true;
        console.log(
          `[GotoTrace] ${this.actorLabel()} ARRIVED at ${fmtXZPrecise(pos)}`,
        );
      }
      return;
    }
    this.traceArrivalLogged = false;
    this.traceTimer += deltaTime;
    if (this.traceTimer < TRACE_INTERVAL) {
      return;
    }
    this.traceTimer = 0;
    // The trailing fields characterise the server tick the sample was taken on
    // (frame time, commanded speed, and how stale the current path is), which is
    // what separates "the mover is slow" from "the mover is starved of frames"
    // when a wave misses the goal. The eval's parser anchors on " at (x,z)" and
    // ignores anything after it, so these are additive.
    console.log(
      `[GotoTrace] ${this.actorLabel()} at ${fmtXZPrecise(pos)}` +
      ` deltaTime=${deltaTime.toFixed(3)}` +
      ` speed=${this.desiredSpeed}` +
      ` band=${this.getRuntimeStopDistance().toFixed(2)}` +
      ` repathTimer=${this.repathTimer.toFixed(2)}` +
      ` framesSincePath=${this.framesSincePath}`,
    );
  }

  /**
   * Unique per-instance actor label shared by every [GotoTrace] / [GotoFindPath]
   * marker: the entity name followed by the engine's unique debug id, e.g.
   * `Zombie(Id: 4294967297 NetId: 12)`.
   *
   * The bare name is NOT unique -- `spawnTemplate` gives every instance of a
   * wave the same one, so a ten-zombie wave emits ten interleaved streams that
   * all read `Zombie` and no reader (human or parser) can tell them apart.
   * `entity.toString()` supplies the unique part. Tagging the STUCK and
   * path-outcome markers with the same label is what lets a stall be tied to a
   * specific zombie and cross-referenced against that zombie's [GotoTrace]
   * position stream.
   *
   * The name is KEPT rather than replaced because `toString()` alone carries
   * no name (`NativeEntityManager::getEntityDebugString` formats exactly
   * `(Id: <id> NetId: <id>)`), and consumers select these markers by NPC-name
   * keyword -- see the pathfinding_obstacle eval's
   * `_root_name_is_zombie_distinctive`. An id-only label would match no
   * keyword, so every sample would be dropped and the eval would silently fall
   * back to the interpolated client-side positions this trace exists to avoid.
   */
  private actorLabel(): string {
    const entity = this.getEntity();
    if (!entity.valid) {
      return '<destroyed>';
    }
    return `${entity.name}${entity.toString()}`;
  }

  /**
   * Exponential mean of recent frame times; see {@link DELTA_TIME_SMOOTHING}.
   */
  private meanDeltaTime: number = 0;
  private meanDeltaTimeSeeded: boolean = false;

  /** This frame's raw frame time; sizes {@link getRuntimeStopDistance}. */
  private lastDeltaTime: number = 0;

  private recordDeltaTime(deltaTime: number): void {
    // WHY: the mean is absorbing — `mean += (NaN - mean) * k` stays NaN for
    // the actor's whole life. update() already sanitizes, so this only has to
    // reject the zero it substitutes for a bad frame, which must not seed the
    // mean or collapse the band to zero via `lastDeltaTime`.
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      return;
    }
    this.lastDeltaTime = deltaTime;
    // Seeding to the first sample rather than 0 keeps the mean at the true
    // frame time from frame one, instead of ramping up out of a cold start.
    if (!this.meanDeltaTimeSeeded) {
      this.meanDeltaTime = deltaTime;
      this.meanDeltaTimeSeeded = true;
      return;
    }
    this.meanDeltaTime +=
      (deltaTime - this.meanDeltaTime) * DELTA_TIME_SMOOTHING;
  }

  /**
   * Arrival tolerance to use this frame: the configured `distanceToStop`, or
   * one frame's travel if that is larger.
   *
   * WHY THIS EXISTS — and what is NOT claimed. NPCs steered by a kinematic
   * character controller fail to reach their navmesh waypoints in the headless
   * character-eval runtime (~0.5s frames). D116072221 identified one cause, the
   * root/child transform-sync wobble, and fixed it at the mover; the scenario
   * still fails, so a residual position error remains and its mechanism is not
   * yet established. This is therefore a MITIGATION, not a fix for a understood
   * failure: it makes waypoint advance tolerant of a position error on the
   * order of one frame's travel, whatever produces it. Do not read the formula
   * as a model of the underlying bug.
   *
   * The band is `deltaTime * desiredSpeed` — the distance the actor covers in a
   * frame — floored at the configured value. At 60Hz that term is below the
   * 0.1m default for any speed under 6 m/s, so shipping actors are unaffected.
   *
   * `min(mean, current)` sizes it, which is deliberately the conservative pick
   * on both sides: the mean alone would let a slow spawn frame hold a
   * metre-scale band open for ~20 frames on a healthy host, and the current
   * frame alone would let one hitch do the same for a frame. Taking the smaller
   * widens only while BOTH the recent average and this frame agree the host is
   * slow, and collapses on the first frame either disagrees. That over-reaction
   * guard is close to free here: replayed over the logged frames of three
   * `navmesh_wall_detour` runs, the `min` costs coverage on no frame of the
   * latest run and 0.4% of the two older ones.
   *
   * Known gap: a host that degrades from fast to slow after the actor spawns
   * leaves the mean low for ~10 frames, so the band lags the degradation.
   * Accepted — the eval runtime is slow from the actor's first frame, which
   * `recordDeltaTime` seeds from.
   */
  getRuntimeStopDistance(): number {
    const frameTravel =
      Math.min(this.meanDeltaTime, this.lastDeltaTime) * this.desiredSpeed;
    return Math.max(this.distanceToStop, frameTravel);
  }

  /** True once initialize() has run (transformComponent is available). */
  private initialized: boolean = false;

  /**
   * Destination the actor moves toward. Assigning a new target immediately
   * queries a fresh path, so `repathInterval` can be large without delaying
   * the actor's response to a new destination; the periodic repath is then
   * only a fallback for path invalidation.
   */
  get targetPosition(): Vec3 {
    return this.targetPositionValue;
  }
  set targetPosition(value: Vec3) {
    const previous = this.targetPositionValue;
    this.targetPositionValue = value;
    // Only discrete-goto callers repath on assignment. Continuous trackers
    // (repathOnTargetChange=false) reassign every frame and repath on the
    // interval, so skip the change-check allocation on their hot path. Pre-init
    // assignments are picked up by initialize()'s own updatePath().
    if (!this.initialized || !this.repathOnTargetChange) {
      return;
    }
    // distanceToStop (arrival tolerance) doubles as the repath-change
    // threshold: a reassignment within it is treated as the same target.
    //
    // WHY the raw value and not getRuntimeStopDistance(): this compares two
    // AUTHORED positions, not a sampled actor position against a target, so the
    // discrete-step overshoot the widening exists to absorb cannot occur here.
    // Widening it would swallow real retargets up to the widened band and
    // suppress the repath until the periodic fallback fires.
    const changed =
      this.pathAbandoned ||
      previous == null ||
      previous.sub(value).componentMul(XZ_MASK).magnitude() >
      this.distanceToStop;
    if (changed) {
      // Reset both halves of the repath gate so the periodic repath does not
      // fire right after this setter-triggered repath.
      this.repathTimer = 0;
      this.framesSincePath = 0;
      this.logGoal();
      void this.updatePath();
    }
  }

  /** Last destination an `is heading to` line named. */
  private loggedGoal: Vec3 | null = null;

  /**
   * `[ActorBehavior] <actor> GotoBehavior is heading to (x, y, z)` for a
   * discrete destination (see {@link GOAL_LOG_MIN_M}). Continuous trackers
   * (`repathOnTargetChange` false) reassign the target every frame and never
   * reach here; the behavior that drives them logs what they follow.
   */
  private logGoal(): void {
    const goal = this.targetPositionValue;
    const fromActor = goal.sub(this.getPosition()).componentMul(XZ_MASK).magnitude();
    const fromLogged = this.loggedGoal
      ? goal.sub(this.loggedGoal).componentMul(XZ_MASK).magnitude()
      : Infinity;
    if (fromActor < GOAL_LOG_MIN_M || fromLogged < GOAL_LOG_MIN_M) {
      return;
    }
    this.loggedGoal = goal;
    logActorBehavior(
      this,
      `is heading to (${goal.x.toFixed(2)}, ${goal.y.toFixed(2)}, ${goal.z.toFixed(2)})`,
    );
  }

  /**
   * Travel-direction facing computed this frame when `shouldFaceDirection` is
   * true. Null when facing is not being driven (flag off, no path yet, or the
   * actor has effectively arrived), which releases the body-direction
   * controller so the actor holds its facing at rest.
   */
  protected desiredBodyDirection: Vec3 | null = null;

  override initialize(
    behaviorManager: ActorBehaviorManager,
  ): void {
    super.initialize(behaviorManager);
    const entity = this.getEntity();
    this.transformComponent = entity.getComponent(TransformComponent)!;
    this.characterController =
      entity.getComponent(CharacterControllerBase) ??
      entity
        .getChildrenWithComponent(CharacterControllerBase, true)[0]
        ?.getComponent(CharacterControllerBase) ??
      null;
    this.navMeshDriver = ActorNavMeshAgentDriver.forEntity(entity);
    this.initialized = true;

    // A destination assigned before initialize() skipped the setter's line.
    if (this.repathOnTargetChange && this.targetPositionValue != null) {
      this.logGoal();
    }
    void this.updatePath();
  }

  /**
   * The actor's authoritative position.
   *
   * A character controller integrates its capsule on its own entity during
   * kPrePhysics; this entity's transform only catches up on the next frame's
   * syncCharacterTransform, so it trails the body by a full frame — over a
   * metre per frame at the eval runtime's ~4Hz tick. Steering, repath start
   * points, and waypoint advance all have to read the body, not the trailing
   * transform. Falls back to the transform for actors with no controller.
   */
  protected getPosition(): Vec3 {
    return (
      this.characterController?.simulatedPosition ??
      this.transformComponent.worldPosition
    );
  }

  update(deltaTime: number): void {
    if (this.getEntity().isDestroyed()) {
      return;
    }
    this.frameCount++;

    // WHY: sanitize once here rather than per-consumer. Every accumulator
    // below is additive, and `repathTimer` has no path back from NaN — its
    // reset is gated on `repathTimer >= repathInterval`, false for NaN — so a
    // single bad frame would kill periodic repathing for the actor's life.
    // Zero is the natural "this frame did not happen" value: it advances no
    // timer, and recordDeltaTime discards it rather than storing it, so the
    // arrival band keeps the previous frame's value instead of collapsing.
    const frameDelta =
      Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;

    // Feeds getRuntimeStopDistance(); must precede every arrival check below.
    this.recordDeltaTime(frameDelta);

    // Always update the final target position every frame so straight-line
    // tracking follows a moving target without waiting for the next repath.
    this.updateFinalTargetPosition();

    this.repathTimer += frameDelta;
    this.framesSincePath++;
    // Gate the periodic repath on BOTH the wall-clock interval and a minimum
    // tick count, so a low frame rate cannot repath before the actor has
    // advanced past path[0].
    if (
      this.pathAbandoned ||
      (this.repathTimer >= this.repathInterval &&
        this.framesSincePath >= MIN_UPDATES_PER_REPATH)
    ) {
      this.repathTimer = 0;
      this.framesSincePath = 0;
      void this.updatePath();
    }

    this.updateTargetProgress();
    this.updateBodyDirection();
    this.updateStuckDetection(frameDelta);
    this.updateTrace(frameDelta);
  }

  /**
   * Computes the travel-direction facing for a bare GotoBehavior: the XZ
   * heading from the actor toward the path waypoint it is steering toward this
   * frame. Releases (null) once the actor is within
   * {@link getRuntimeStopDistance} of that waypoint so it holds its facing at
   * rest instead of spinning on a degenerate heading — so on a slow host it
   * releases from the same widened band the waypoint advance uses, not from
   * the configured `distanceToStop`. No-op (null) when `shouldFaceDirection`
   * is false — an owning behavior controls body direction — or before the
   * first path resolves.
   */
  protected updateBodyDirection(): void {
    if (!this.shouldFaceDirection) {
      this.desiredBodyDirection = null;
      return;
    }
    if (!this.forceStraightLine && this.navMeshDriver?.agent != null) {
      this.desiredBodyDirection = this.desiredSpeed > 0
        ? this.navMeshDriver.getTravelDirection(this)
        : null;
      return;
    }
    if (!this.pathReady) {
      this.desiredBodyDirection = null;
      return;
    }

    const waypoint = this.getCurrentTargetPosition();
    if (!waypoint) {
      this.desiredBodyDirection = null;
      return;
    }

    const toWaypoint = waypoint.sub(this.getPosition());
    const headingXZ = new Vec3(toWaypoint.x, 0, toWaypoint.z);
    if (headingXZ.magnitude() > this.getRuntimeStopDistance()) {
      this.desiredBodyDirection = headingXZ.normalize();
    } else {
      this.desiredBodyDirection = null;
    }
  }

  /**
   * Updates the last point in the path to the current targetPosition.
   * This ensures the path endpoint is always up-to-date without expensive repathing.
   */
  protected updateFinalTargetPosition(): void {
    if (this.currentPath.length > 0) {
      this.currentPath[this.currentPath.length - 1] = this.targetPosition;
    } else {
      this.currentPath = [this.targetPosition];
      this.currentTargetIndex = 0;
      this.nudgeAnchor = null;
    }
  }

  protected updateTargetProgress(): void {
    if (
      this.currentPath.length === 0 ||
      this.currentTargetIndex >= this.currentPath.length
    ) {
      return;
    }

    const position = this.getPosition();

    // Advance through intermediate points when close enough
    while (this.currentTargetIndex < this.currentPath.length - 1) {
      const targetPoint = this.currentPath[this.currentTargetIndex];
      const deltaPosition = targetPoint.sub(position);
      if (Math.abs(deltaPosition.y) >= this.verticalThreshold) {
        return;
      }
      const horizontalDistance = deltaPosition.componentMul(XZ_MASK).magnitude();
      if (horizontalDistance >= this.getRuntimeStopDistance()) {
        return;
      }

      this.currentTargetIndex++;
    }

    if (this.nudgeAnchor && this.currentTargetIndex > this.nudgeAnchor.index) {
      this.clearNudgeAnchor();
    }
  }

  /**
   * Rolls back the nudge episode's path edit — splicing out an inserted
   * sidestep or restoring a displaced waypoint — and drops the anchor.
   * Arrival and consume exit through here, so an actor that reaches the goal
   * with a detour still pending does not walk back out to it.
   */
  private clearNudgeAnchor(): void {
    const anchor = this.nudgeAnchor;
    this.nudgeAnchor = null;
    if (!anchor) {
      return;
    }
    if (anchor.inserted) {
      // The detour is gone either way: remove the inserted sidestep so the
      // path rejoins the authored waypoints instead of keeping a stale detour
      // (or a duplicated goal) ahead of the cursor.
      this.currentPath.splice(anchor.index, 1);
      if (this.currentTargetIndex > anchor.index) {
        this.currentTargetIndex--;
      }
    } else {
      // The route rejoins the authored waypoint instead of steering the rest
      // of the episode off the displaced coordinate.
      this.currentPath[anchor.index] = anchor.point;
    }
  }

  /**
   * Recomputes the path. If a NavMesh is available, queries it asynchronously
   * and writes the result back into `currentPath` when it resolves. Falls
   * back to straight-line on any failure (no mesh, query failure, or no usable
   * path). Override in subclasses to implement custom pathfinding.
   */
  protected async updatePath(): Promise<void> {
    this.pathAbandoned = false;
    if (this.forceStraightLine) {
      this.useStraightLinePath();
      return;
    }

    const navMesh = this.resolveNavMeshComponent();
    if (!navMesh) {
      this.logPathOutcome(
        'NO_NAVMESH',
        `no usable NavMesh (none in the world, none fits this actor here, or several and its size is unknown); straight-line to ${fmtXZ(
          this.targetPosition,
        )}`,
      );
      this.useStraightLinePath();
      return;
    }

    const start = this.getPosition();
    const end = this.targetPosition;
    const myToken = ++this.repathToken;

    let path: Maybe<Vec3[]>;
    try {
      path = await navMesh.findPath(start, end, {
        maxPathSize: this.navMeshMaxPathSize,
        maxSearchDistance: this.navMeshSnapDistance,
      });
    } catch (e) {
      // A superseded or abandoned query must not replace the newer route.
      if (myToken !== this.repathToken) {
        return;
      }
      console.warn(
        '[GotoBehavior] navmesh findPath threw; falling back to straight-line',
        e,
      );
      // Include the error message in the marker itself: a headless run greps only
      // the [GotoFindPath] line, so without this the native failure (e.g. the
      // "ErrorUnexpected ... NavMeshApi::findPath" that flags an unbaked navmesh)
      // is lost from the grep-able signal.
      this.logPathOutcome(
        'FINDPATH_THREW',
        `${fmtXZ(start)}->${fmtXZ(end)} error=${e instanceof Error ? e.message : String(e)
        }`,
      );
      this.useStraightLinePath();
      return;
    }

    // Discard stale results from a superseded repath.
    if (myToken !== this.repathToken) {
      return;
    }

    if (path == null || path.length === 0) {
      // findPath returning null/empty in the presence of a NavMesh entity is
      // most commonly caused by the NavMesh being unbaked (no walkable
      // polygons exist). Distinguish this from "no NavMesh entity at all" so
      // authors can fix the underlying problem (run bake_nav_mesh) rather
      // than chase phantom pathfinding bugs. Warn once per actor.
      if (!this.warnedUnbaked) {
        this.warnedUnbaked = true;
        console.warn(
          '[GotoBehavior] NavMesh entity exists but findPath returned no path. ' +
          'Most likely cause: the NavMesh was not baked or not up to date. ' +
          'Run bake_nav_mesh on the NavMesh entity. ' +
          'Falling back to straight-line until a valid path is available.',
        );
      } else {
        console.debug(
          '[GotoBehavior] navmesh returned empty path; falling back to straight-line',
        );
      }
      this.logPathOutcome(
        'NO_PATH',
        `${fmtXZ(start)}->${fmtXZ(end)} (empty path; likely unbaked or ` +
        `disconnected navmesh — cannot route around obstacle)`,
      );
      this.useStraightLinePath();
      return;
    }

    this.currentPath = path;
    this.currentTargetIndex = 0;
    this.nudgeAnchor = null;
    this.pathReady = true;
    // A 2-point path is start->end with no intermediate routing (endpoint
    // snapped straight through) — the actor will clip a wall between them. A
    // >2-point path is a real detour around obstacles. Distinguishing these is
    // the core signal for navmesh-detour scenarios.
    this.logPathOutcome(
      path.length > 2 ? 'PATH_DETOUR' : 'PATH_DIRECT',
      `${fmtXZ(start)}->${fmtXZ(end)} ${path.length} waypoints ` +
      `end@${fmtXZ(path[path.length - 1])}`,
    );
  }

  /**
   * The navmesh this goto paths on right now (its crowd agent's, else the one
   * that fits the actor); null when none does. For callers that check a route
   * before handing it to this goto, so both read the same navmesh.
   */
  currentNavMesh(): NavMeshComponent | null {
    return this.resolveNavMeshComponent();
  }

  /** The navmesh that fits this actor's size and position; null when none does. */
  private resolveNavMeshComponent(): NavMeshComponent | null {
    if (!this.forceStraightLine && this.navMeshDriver?.agent != null) {
      const entity = this.navMeshDriver.agent.navMeshEntity;
      return entity?.valid ? entity.getComponent(NavMeshComponent) : null;
    }
    return this.navMeshLookup.resolveFor(this.behaviorManager?.actorEntity ?? null);
  }

  private useStraightLinePath(): void {
    this.currentPath = [this.targetPosition];
    this.currentTargetIndex = 0;
    this.nudgeAnchor = null;
    this.pathReady = true;
  }

  /**
   * Drops the current route and ignores any repath still in flight, so
   * movement waits until the next path resolves. The next `targetPosition`
   * assignment queries it even for an unchanged target, as does the next
   * update() if none comes first. For an owner resuming this goto after
   * something else moved the actor, when the old route starts somewhere else.
   */
  abandonPath(): void {
    ++this.repathToken;
    this.pathAbandoned = true;
    this.currentPath = [];
    this.currentTargetIndex = 0;
    this.nudgeAnchor = null;
    this.pathReady = false;
    this.repathTimer = 0;
    this.framesSincePath = 0;
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType == ActorMovementControllerTypeId) {
      return this.basePriority;
    }

    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.shouldFaceDirection &&
      this.desiredBodyDirection
    ) {
      return this.basePriority;
    }

    return super.getControllerUsePriority(controllerType);
  }

  /**
   * Builds path segments with desiredSpeed for each point.
   */
  protected buildPathSegments(): ActorPathSegment[] | null {
    if (this.currentPath.length === 0) {
      return null;
    }

    const pathSegments: ActorPathSegment[] = [];

    for (let i = this.currentTargetIndex; i < this.currentPath.length; i++) {
      const targetPoint = this.currentPath[i];
      pathSegments.push(new ActorPathSegment(targetPoint, this.desiredSpeed));
    }

    return pathSegments;
  }

  protected getCurrentTargetPosition(): Vec3 | null {
    if (
      this.currentPath.length === 0 ||
      this.currentTargetIndex >= this.currentPath.length
    ) {
      return null;
    }
    return this.currentPath[this.currentTargetIndex];
  }

  /**
   * The path waypoint the actor is steering toward this frame — the next
   * un-reached point on the NavMesh route (or the straight-line target when
   * no NavMesh path is active). Owners that orient the actor to its travel
   * direction (e.g. FollowBehavior's `faceMovement` mode) should read this
   * rather than the ultimate destination, so facing tracks the actual route
   * around a corner instead of pointing at the destination through the wall.
   * Returns null when no path is active.
   */
  getCurrentWaypoint(): Vec3 | null {
    return this.getCurrentTargetPosition();
  }

  get usesNavMeshAgent(): boolean {
    return !this.forceStraightLine && this.navMeshDriver?.agent != null;
  }

  /** The current crowd heading; null before a usable sample or while stopped. */
  getTravelDirection(): Vec3 | null {
    return this.usesNavMeshAgent && this.desiredSpeed > 0
      ? this.navMeshDriver!.getTravelDirection(this)
      : null;
  }

  /**
   * Remaining travel distance (meters, XZ plane) along the current path:
   * actor position -> next waypoint -> ... -> endpoint, summed over all
   * not-yet-reached waypoints. Because the path is produced by NavMesh
   * pathfinding, this reflects the actual route around obstacles rather
   * than the straight-line distance to the target -- e.g. a target just
   * beyond a wall yields a large remaining length even though it is close
   * as the crow flies.
   *
   * Returns exactly 0 only when there is no path yet (`currentPath` empty,
   * before the first repath resolves). Otherwise it is the remaining
   * along-path distance to the endpoint, which shrinks toward 0 as the actor
   * reaches the destination (the final actor->last-waypoint segment tends to 0
   * on arrival). When running the straight-line fallback (no NavMesh) the path
   * is a single endpoint, so this reduces to the straight-line XZ distance to
   * the target.
   */
  getRemainingPathLength(): number {
    if (this.currentPath.length === 0) {
      return 0;
    }
    const pos = this.getPosition();
    let total = 0;
    let prevX = pos.x;
    let prevZ = pos.z;
    for (let i = this.currentTargetIndex; i < this.currentPath.length; i++) {
      const pt = this.currentPath[i];
      const dx = pt.x - prevX;
      const dz = pt.z - prevZ;
      total += Math.sqrt(dx * dx + dz * dz);
      prevX = pt.x;
      prevZ = pt.z;
    }
    return total;
  }

  override useController(
    controllerType: string,
    controller: ActorController,
  ): void {
    if (controllerType == ActorMovementControllerTypeId) {
      let moveParams: ActorMoveParams;
      if (!this.forceStraightLine && this.navMeshDriver?.agent != null) {
        moveParams = this.navMeshDriver.move(
          this, this.targetPosition, this.desiredSpeed, this.getPosition(),
        );
        // A jump link plays the body's jump; the driver moves it along the arc either way.
        const jumper = controller as Partial<IActorJump>;
        if (typeof jumper.requestJump === 'function' && this.navMeshDriver.takeLinkJump(this)) {
          jumper.requestJump();
        }
      } else {
        this.navMeshDriver?.stop(this.getPosition());
        // Suppress movement until the first repath resolves.
        if (!this.pathReady) {
          return;
        }
        moveParams = new ActorMoveParams(
          this.getCurrentTargetPosition(), this.desiredSpeed, this.buildPathSegments(),
        );
      }
      const currentTarget = moveParams.desiredPosition;
      const pathSegments = moveParams.desiredPath;

      // Movement-authority observability. The framework only calls this when
      // this behavior wins the movement-controller arbitration, so counting the
      // calls proves whether the intended march is actually driving the body —
      // the missing half of the commanded_but_stuck fork the STUCK detector
      // opens. FIRST_MOVE_CMD fires once per actor (a behavior that never wins
      // arbitration emits none, even though pathReady is true and [GotoTrace]
      // keeps sampling), so its absence is itself the signal.
      this.moveCmdCount++;
      this.lastMoveCmdFrame = this.frameCount;
      if (!this.firstMoveCmdLogged) {
        this.firstMoveCmdLogged = true;
        console.log(
          `[GotoFindPath] ${this.actorLabel()} FIRST_MOVE_CMD target=${currentTarget ? fmtXZ(currentTarget) : 'null'
          } speed=${this.desiredSpeed} segs=${pathSegments ? pathSegments.length : 0
          }`,
        );
      }

      (controller as ActorMovementController).moveToPosition(
        moveParams,
      );
      return;
    }

    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.shouldFaceDirection &&
      this.desiredBodyDirection
    ) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(
          this.desiredBodyDirection,
          this.bodyDirectionAngularSpeed,
        ),
      );
    }
  }
}
