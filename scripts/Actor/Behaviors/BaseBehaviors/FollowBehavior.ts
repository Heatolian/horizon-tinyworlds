/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v41

import { Vec3, TransformComponent, WorldTextComponent } from 'meta/worlds';
import type { Entity } from 'meta/worlds';
import { ActorBehavior } from 'meta/worlds';
import { GotoBehavior } from './GotoBehavior';
import type { ActorController } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';
import type { TargetInfo } from './TargetingBehavior';
import { TargetLog } from '../../Utilities/ActorBehaviorLog';
import { PlayerRoster, type NearestPlayerOptions } from '../../Utilities/PlayerRoster';

// Upper bound on `stuckSettleHardMultiplier`. Bounded on both sides: below 1
// the escape fires before the normal fallback and defeats the gate, while a
// large FINITE value deletes the escape as effectively as `Infinity`.
const MAX_HARD_STUCK_MULTIPLIER = 60;

// Floor on the settled-exit debounce (s), used whenever `stuckSettleTime`
// sanitizes to 0 (which is where negative and non-finite values map).
const MIN_SETTLE_EXIT_DEBOUNCE_S = 0.2;

// Ceiling on the settled-exit debounce (s). Without it a large FINITE
// `stuckSettleTime` holds a jostled actor at zero speed outside its attack
// band for that whole interval. 1s sits above the 0.5 default (no shipped
// caller moves) and well under the 5s stall-warning threshold.
const MAX_SETTLE_EXIT_DEBOUNCE_S = 1.0;

// Per-second decay applied to a gate timer while the actor is on the
// favourable side of the edge. Decay rather than reset, so an actor
// oscillating across the gate cannot zero the timer every other frame and
// park out of range forever, while single-frame jitter still cannot trip it.
const GATE_TIMER_DECAY_RATE = 0.5;

// Cap on how many STEPS the park interval grows over consecutive failed
// retries. Distinct from the fraction cap below: this bounds the step count,
// that bounds the resulting DURATION.
const MAX_PARK_BACKOFF = 8;

// Cap on the park interval as a fraction of the pursue window. This, not the
// step cap, holds the asymmetry: the park scales with `consecutiveParks`
// while the pursue window does not, so an unconditional step cap of 8 against
// the default multiplier of 6 would make a saturated park LONGER than pursue.
const MAX_PARK_FRACTION_OF_PURSUE = 0.8;

// Declared defaults for the fields whose degenerate-value fallback is a
// magnitude rather than a semantic sentinel. Each is shared by the field
// initializer and the accessor that resolves it, so the two cannot drift.
const DEFAULT_STUCK_SPEED_THRESHOLD = 0.1;
const DEFAULT_PLAYER_SEARCH_INTERVAL = 0.5;
const DEFAULT_DISTANCE_TO_STOP = 0.1;
const DEFAULT_REPATH_INTERVAL = 0.2;
const DEFAULT_TARGET_MOVING_THRESHOLD = 0.1;
const DEFAULT_BODY_DIRECTION_ANGULAR_SPEED = 3.14;
const DEFAULT_FOLLOW_SPEED = 5.0;

// Finite stand-in for an authored `Infinity` body-direction rate. Large enough
// that `rate * deltaTime` exceeds any angular distance (< 2π rad) in a single
// frame, so the controller's `t` still saturates at 1 and the snap is
// indistinguishable from a literal `Infinity`.
const MAX_BODY_DIRECTION_ANGULAR_SPEED = 1e6;

/**
 * FollowBehavior - A behavior that follows a target entity.
 *
 * Navigates to the target's actual position via the NavMesh (routing around
 * walls) and stops `followRange` short of the target measured along the path,
 * parking there while the target is still.
 *
 * Supports two modes:
 * - **Composite mode** (`targetInfo` provided): Reads `predictedPosition`
 *   from the shared TargetInfo written by TargetingBehavior. With the parent
 *   `velocityPredictionTime > 0`, the actor navigates toward where the target
 *   will be in `velocityPredictionTime` seconds — leading the chase. Set
 *   `velocityPredictionTime = 0` on the parent to revert to pure
 *   current-position tracking.
 * - **Standalone mode** (`targetInfo` is null): Uses the raw target position.
 *   When `followPlayer` is true, the closest player is resolved dynamically.
 *
 * ## Hysteresis (motion state machine + arrival deceleration)
 *
 * To avoid stop-go cycles AND smoothly handle target stops without any
 * dependency on velocity smoothing, the behavior combines a two-state
 * motion machine with arrival-style speed control:
 *
 * - **`pursuing`**: actor drives toward the follow point at a speed that
 *   linearly decelerates with distance — full `followSpeed` at or beyond
 *   `hysteresisRadius` from the follow point, ramping to 0 at the center.
 * - **`settled`**: actor parks (`desiredSpeed = 0`); body direction still
 *   tracks the target. With `hysteresisRadius > 0` this is entered only when
 *   the target is essentially still (`targetSpeedXZ ≤ targetMovingThreshold`);
 *   with `hysteresisRadius = 0` it is entered purely on arrival at the follow
 *   point, regardless of target motion.
 *
 * **Arrival speed (Reynolds-style)**:
 * ```
 *   t           = min(1, distToFollow / hysteresisRadius)  // 0 at center
 *   desiredSpeed = followSpeed * t                           // smooth ramp
 * ```
 * Self-equilibrates when the target moves at constant speed: the actor
 * naturally cruises at an offset behind the follow point such that
 * `followSpeed * (offset / hysteresisRadius) ≈ targetSpeed`. For a
 * player walking at 2 m/s with `followSpeed = 5` and `hysteresisRadius =
 * 1.5`, the actor settles ~0.6 m behind the follow point and matches
 * pace — no burst-and-brake cycle, no transient when the target stops
 * (since `desiredSpeed` depends only on distance, never on a smoothed
 * velocity that lags).
 *
 * **Trade-off**: while the target is moving, the actor sits *behind* the
 * follow point by an offset proportional to target speed (rather than
 * exactly *at* the follow point). Acceptable for chase / tail-following;
 * if you need tighter tracking, shrink `hysteresisRadius` (smaller soft
 * zone → smaller equilibrium offset, but less hysteresis benefit).
 *
 * **Transitions** (XZ-plane distances):
 * - `pursuing → settled` when actor is **inside** `hysteresisRadius` AND
 *   (arrived within `distanceToStop` of the follow point, OR stuck-but-close
 *   fallback fires, OR the hard-stuck escape fires) AND target is essentially
 *   still.
 * - `settled → pursuing` the moment actor is **outside** `hysteresisRadius`,
 *   or — for a follower with a finite `stuckSettleMaxDistance` — when it is
 *   pushed beyond that gate without having arrived within `distanceToStop`.
 *   A target that starts moving while its follow point still sits inside
 *   the hysteresis zone is intentionally ignored — the actor waits until
 *   the player has walked far enough to drag the follow point out.
 *   With the default `Infinity` gate only the hysteresis clause can fire, so
 *   non-combat followers keep the original exit rule exactly.
 *
 * Set `hysteresisRadius = 0` to disable arrival deceleration (pure pursuit at
 * `followSpeed`); the actor still parks at `followRange` on arrival (within
 * `distanceToStop`) regardless of target motion — the original
 * stop-at-followRange behavior, without the soft-zone smoothing.
 *
 * **Tuning note**: when using composite mode with velocity prediction, set
 * `hysteresisRadius` ≳ `velocityPredictionTime * expectedTargetSpeed` so
 * that the predicted-point snap-back when a moving target stops stays
 * inside the soft zone (no backpedal). The radius can be changed at any
 * time; the state machine reads it every frame.
 */
export class FollowBehavior extends ActorBehavior {
  override name: string = 'FollowBehavior';
  private readonly targetLog: TargetLog = new TargetLog('following');

  /** True once the behavior manager has removed this behavior; it no longer updates. */
  isRemoved: boolean = false;

  /**
   * Target entity to follow.
   * In composite mode, this is overridden by targetInfo.targetEntity.
   */
  targetEntity: Entity | null = null;

  /**
   * Desired follow distance from target in meters.
   *
   * Must be zero or positive. `0` is honoured and means "walk to the follow
   * point itself" — `PatrolBehavior`, `DeliverToTagBehavior` and
   * `SearchAndPickupBehavior` all set it deliberately. A negative or non-finite
   * value also reads as 0, because it would otherwise poison `distToFollow` for
   * the state machine as well as the speed ramp; since that fallback is
   * indistinguishable from an authored `0`, it warns once.
   */
  followRange: number = 1.0;

  /**
   * Movement speed in meters per second.
   *
   * `0` is honoured and parks the actor. A negative or non-finite value resolves
   * to the declared default and warns once: those previously produced an absurdly
   * fast or reversed but MOVING actor, so reading them as 0 would newly freeze
   * one, and running them at the default rate instead is still a change to what
   * that actor did. A parked actor is not a settled actor — `motionState` is
   * driven by `distToFollow`, which a zero speed never shrinks — so the honoured
   * `0` warns as well; it is the file's only honoured value that does.
   */
  followSpeed: number = DEFAULT_FOLLOW_SPEED;

  // GotoBehavior pass-through parameters

  /**
   * Seconds between the nested goto's periodic repaths.
   *
   * Must be positive; anything else resolves to the declared default. The
   * nested goto compares `repathTimer >= repathInterval` and does not sanitize
   * the value, so `NaN` and `Infinity` make that test false forever — and
   * because a follower sets `repathOnTargetChange = false`, the periodic repath
   * is the only thing that re-routes toward a moved target.
   *
   * `0` and negatives are also rejected, and both repathed at the tick floor
   * rather than not at all (`repathTimer` starts at 0 and only grows, so
   * `0 >= -1` holds on frame one exactly as `0 >= 0` does). Every rejected value
   * warns once per actor, whichever direction it moved the behaviour in.
   */
  repathInterval: number = DEFAULT_REPATH_INTERVAL;

  /**
   * Along-path distance (m) to the follow point within which the actor counts as
   * arrived. 0 is honoured (arrive only at the point itself); a negative or
   * non-finite value reads as the declared default, since it would otherwise
   * make every arrival test false and delete the arrival settle.
   */
  distanceToStop: number = DEFAULT_DISTANCE_TO_STOP;

  /**
   * Controls which direction the actor faces while following.
   *   'faceTarget'   — face toward the target entity
   *   'faceMovement' — face the direction the actor is moving (its travel heading)
   *   'matchTarget'  — face the same direction as the target
   *   'none'         — do not control body direction (actor keeps its facing)
   */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /**
   * Angular speed in radians per second for body direction rotation.
   *
   * `0` (hold the current facing) and `Infinity` (snap instantly) are both
   * honoured: the in-tree controller computes `t = min(rate * dt, dist) / dist`
   * and slerps by it, so those are working configurations, and the four sibling
   * behaviors that declare this field pass it through raw. `NaN` and negatives
   * resolve to the declared default — a `NaN` rate yields a `NaN` quaternion
   * written straight to `worldRotation`, and a negative one slerps backwards.
   * An authored `Infinity` is forwarded as a large finite rate that snaps the
   * same way, because `Infinity * 0` is `NaN` and a zero-length frame is a value
   * the runtime produces. `bodyDirectionMode = 'none'` also stops facing control
   * entirely.
   */
  bodyDirectionAngularSpeed: number = DEFAULT_BODY_DIRECTION_ANGULAR_SPEED;

  /**
   * Shared target info from a parent CompositeBehavior.
   * When provided, position/velocity/prediction data is read from here.
   * When null, standalone mode is used (raw target position, no prediction).
   */
  targetInfo: TargetInfo | null = null;

  /**
   * When true, the behavior dynamically resolves the closest player as the
   * target every `playerSearchInterval` seconds. This handles the case where
   * the player spawns after the NPC: the behavior keeps searching until a
   * player appears, then follows them. If the followed player disconnects,
   * it will re-acquire the next closest player.
   */
  followPlayer: boolean = false;

  /**
   * How often (in seconds) to search for the closest player when
   * `followPlayer` is true. Lower values are more responsive but slightly
   * more expensive. Only used in standalone + followPlayer mode.
   *
   * `0`, negatives and `NaN` read as the declared default and warn once: each of
   * them makes the throttle comparison false forever, leaving the O(players)
   * `PlayerService` scan running on every frame — identically, so all three are
   * disclosed the same way. `Infinity` is honoured and means "acquire a target
   * once, then never re-scan while it lives" — re-acquisition after the target is
   * destroyed is gated by the missing-target check, not by this interval, so that
   * path still works.
   */
  playerSearchInterval: number = DEFAULT_PLAYER_SEARCH_INTERVAL;

  /**
   * Optional filter applied to each candidate player entity during
   * `resolvePlayerTarget()`. Return `true` to keep the candidate, `false`
   * to skip it. When null, all players pass. Used by BotBehaviorInstaller to
   * exclude managed bot-fill players so bots only follow real humans.
   */
  playerFilter: ((entity: Entity) => boolean) | null = null;

  /** The player query, built once: it reads `playerFilter` live, so a filter set later still applies. */
  private readonly playerQuery: NearestPlayerOptions = {
    filter: (entity: Entity): boolean => this.playerFilter == null || this.playerFilter(entity),
  };

  protected gotoBehavior: GotoBehavior | null = null;
  protected actorTransform: TransformComponent | null = null;

  /**
   * Internal timer for throttling player searches in followPlayer mode.
   */
  protected playerSearchTimer: number = 0;

  // Every latch below suppresses one diagnostic while the offending value keeps
  // reading degenerate, and CLEARS on the accept path so a later, distinct
  // corruption of the same field is reported rather than healed silently. That is
  // the shape `EngageCombatBehavior.sanitizeAttackBand` already uses for the
  // package's other per-frame author-field validator, and these fields are
  // demonstrably re-assigned after construction: `PatrolBehavior.update` pushes a
  // new `followSpeed` every frame, `FollowTaggedEntityBehavior.setFollowSpeed`
  // and `applyRuntimeRanges` push `followSpeed`, `followRange`, `hysteresisRadius`
  // and `distanceToStop` at arbitrary times. Without the re-arm the rule the file
  // states — every rejected value warns, once per actor — would hold only for the
  // FIRST rejected value an actor ever held on that field. The cost of re-arming
  // is one diagnostic per contiguous degenerate episode rather than per actor; a
  // value that stays degenerate still warns exactly once. `followSpeed` carries
  // TWO latches because it is the one field with two honoured-vs-rejected
  // diagnostics that have different remediations — see `hasWarnedZeroFollowSpeed`.

  /**
   * Latch for the one-shot `playerSearchInterval` misconfiguration warning, so
   * the diagnostic cannot spam at tick rate.
   */
  protected hasWarnedSearchInterval: boolean = false;

  /**
   * Latch for the one-shot `followSpeed` REJECTED-value warning (`NaN`,
   * `Infinity`, negatives). `effectiveFollowSpeed()` runs once per frame from the
   * speed ramp, so the diagnostic needs the same latch treatment as the
   * search-interval one above. Only a positive finite speed re-arms it: `0` is
   * honoured yet warns, so clearing on that leg would re-emit every frame.
   */
  protected hasWarnedFollowSpeed: boolean = false;

  /**
   * Latch for the one-shot honoured-`followSpeed === 0` warning, held separately
   * from `hasWarnedFollowSpeed` above. One shared latch meant a direct
   * `0 -> NaN` transition (no intervening valid speed — `PatrolBehavior.update`
   * re-assigns the field every frame) reported only whichever came first, even
   * though the two messages carry different remediations. Two latches surface
   * each class once per degenerate episode while still bounding the total at two,
   * which a single value-class marker would not: an actor alternating
   * `0 <-> NaN` would re-warn on every transition.
   */
  protected hasWarnedZeroFollowSpeed: boolean = false;

  /**
   * Latch for the one-shot `followRange` misconfiguration warning.
   * `effectiveFollowRange()` runs once per frame from `followTarget`. BOTH
   * honoured values re-arm it — the positive-finite one and `0` — because
   * neither warns; a `NaN -> 0 -> NaN` sequence through `applyRuntimeRanges`
   * therefore reports the second corruption instead of healing it silently.
   */
  protected hasWarnedFollowRange: boolean = false;

  /**
   * Latch for the one-shot `repathInterval === 0` warning. `initialize()` is the
   * only call site today, but the accessor is `protected` and a subclass may
   * read it per frame, so it carries the same latch as its siblings.
   */
  protected hasWarnedRepathInterval: boolean = false;

  /**
   * Latch for the one-shot `stuckSpeedThreshold === 0` warning. The guard lives
   * inline in `updateMotionState`, which runs every frame — but BELOW the
   * `radius <= 0` disable return, so neither the guard nor this diagnostic is
   * reachable for a follower that has not opted into a soft zone. Nothing is
   * mis-resolved on that branch: the stuck detector the threshold feeds is
   * equally unreachable there, so the value is never read. See the scope clause
   * on `stuckSpeedThreshold` itself.
   */
  protected hasWarnedStuckSpeed: boolean = false;

  /**
   * The direction the actor should face (towards target).
   * Null if body direction is not being controlled by this behavior.
   */
  protected desiredBodyDirection: Vec3 | null = null;

  // ── Hysteresis ────────────────────────────────────────────────────

  /**
   * Soft-zone radius (meters, XZ plane) around the follow point. When the
   * actor is inside this radius AND has arrived (or is stuck-but-close),
   * the actor settles and stops issuing movement requests until the follow
   * point drifts outside the radius.
   *
   * Set to 0 to disable hysteresis (pure pursuit — original behavior).
   * May be changed dynamically; read every frame.
   */
  hysteresisRadius: number = 0;

  /**
   * Actor XZ speed (m/s) below which the actor is considered "stuck" — i.e.
   * unable to make further progress toward the follow point (e.g. blocked
   * by collision, peer actor crowding).
   *
   * Must be positive. `0`, negatives and `NaN` all classify even a frozen actor
   * as moving — the comparison is against a magnitude, so none of them can ever
   * be met — which left the in-zone stuck fallback dead; `Infinity` classifies a
   * sprinting one as stuck. All four read as the declared default and warn once,
   * since the override wakes or normalises a settle path the authored value had
   * changed.
   *
   * Scope: this field is read only on the in-zone branch of `updateMotionState`,
   * below the `hysteresisRadius <= 0` disable return. A follower with no soft zone
   * — the default, and what `PatrolBehavior`, `DeliverToTagBehavior` and
   * `SearchAndPickupBehavior` construct — never reaches the guard, so it neither
   * resolves the default nor warns there. Raising `hysteresisRadius` at runtime
   * makes both live from that frame on.
   */
  stuckSpeedThreshold: number = DEFAULT_STUCK_SPEED_THRESHOLD;

  /**
   * Sustained time (seconds) the actor must remain "stuck" while inside
   * `hysteresisRadius` before the motion state is force-settled. Prevents
   * unreachable-point thrashing. Set to 0 to disable the fallback — which
   * also disables the `stuckSettleHardMultiplier` escape that backstops it.
   *
   * A finite `stuckSettleMaxDistance` narrows where this fallback may park
   * the actor; `stuckSettleHardMultiplier` is what preserves the
   * anti-thrashing guarantee outside that zone.
   */
  stuckSettleTime: number = 0.5;

  /**
   * Maximum along-path distance to the follow point (meters) at which the
   * stuck fallback is allowed to force-settle the actor. Beyond this the actor
   * stays `pursuing` even while stuck, so it keeps issuing move requests and
   * can resume closing the gap the moment the blockage clears (e.g. peer
   * crowding at a shared objective) instead of permanently parking short of
   * goal.
   *
   * Defaults to `Infinity` — the legacy rule where the stuck fallback settles
   * anywhere inside `hysteresisRadius`. Combat followers tighten this to their
   * attack band so a jostled actor stopped just OUTSIDE attack range does not
   * park there for good (see `EngageCombatBehavior`). Only the stuck branch is
   * gated; genuine arrival (within `distanceToStop`) still settles regardless.
   */
  stuckSettleMaxDistance: number = Number.POSITIVE_INFINITY;

  /**
   * Multiple of `stuckSettleTime` after which a follower held out of the
   * `stuckSettleMaxDistance` zone parks anyway, and — having parked — waits
   * before retrying.
   *
   * Gating the stuck fallback removes the only quiescence path for a follow
   * point that is permanently unreachable (blocked geometry rather than
   * transient crowding): such an actor would otherwise pursue and repath
   * forever. This bounds that to an ASYMMETRIC duty cycle — pursue for
   * `stuckSettleTime * clamped`, then park for
   * `stuckSettleTime * consecutiveParks` (backing off over consecutive failed
   * retries), retry — so an unreachable goal costs bounded LOCOMOTION while a
   * crowd that clears is still closed on. It bounds only LOCOMOTION, and no
   * other per-frame cost: `GotoBehavior` gates `findPath` on `repathInterval`
   * and a minimum tick count, never on motion state, so a parked actor keeps
   * repathing — and keeps arbitrating its movement controller and building
   * move params — at exactly the rate it pursued at.
   *
   * `clamped` is this value clamped to `[1, MAX_HARD_STUCK_MULTIPLIER]`, with
   * any non-finite value collapsing to 1 — so `Infinity` yields the SHORTEST
   * pursue window and the most eager escape. Note the deliberate contrast with
   * `stuckSettleMaxDistance`, where `Infinity` is the inert value.
   *
   * The park is deliberately the SHORT half: a parked actor cannot shorten its
   * own path, so the park duration is the worst-case added attack latency. It
   * is bounded by whichever of two caps binds first — `MAX_PARK_BACKOFF`
   * steps, or `MAX_PARK_FRACTION_OF_PURSUE` of the pursue window — leaving it
   * always strictly shorter than the pursue half, never equal to it. At the
   * default 6 the fraction binds (80% of the window); above 10 the step cap
   * binds instead, so the park becomes a progressively smaller share of an
   * ever-longer pursue window (13% at the ceiling of 60).
   *
   * Three separate conditions leave this inert. `stuckSettleMaxDistance` at
   * `Infinity` (its default), because the actor then always parks via the
   * normal fallback. `stuckSettleTime` at 0, which disables the fallback the
   * escape is derived from. And `hysteresisRadius <= 0` — the default of this
   * class and of `FollowTaggedEntityBehavior` — which returns before any of
   * this runs, so the duty cycle exists only for a caller that opts into a
   * soft zone. `EngageCombatBehavior` is the one that does.
   */
  stuckSettleHardMultiplier: number = 6;

  /**
   * XZ speed (m/s) below which the target is considered "essentially still".
   *
   * - When target speed is **below** this, the actor is allowed to enter
   *   `settled` (full stop) on arrival inside hysteresis.
   * - When target speed is **at or above** this, the actor stays in
   *   `pursuing` and uses arrival deceleration instead — naturally
   *   cruising at an equilibrium offset behind the follow point.
   *
   * Must be zero or positive. `targetSpeedXZ` is a magnitude, so a NEGATIVE
   * threshold reads every target as moving — in standalone mode too, where the
   * speed is always 0 — which blocks all three settle entries AND the
   * hard-stuck escape, leaving the actor pursuing and repathing forever.
   * `Infinity` and NaN fail the other way, reading every target as still. Each
   * of them resolves to the declared default; 0 is honoured and means "any
   * motion at all counts as moving".
   *
   * Composite mode only (uses `targetInfo.smoothedVelocity`): in standalone
   * mode the speed is 0, so with any accepted threshold the target reads as
   * still and this has no effect.
   */
  targetMovingThreshold: number = DEFAULT_TARGET_MOVING_THRESHOLD;

  /**
   * Internal motion state. Drives whether follow issues move requests
   * (`pursuing`) or parks the actor (`settled`).
   */
  protected motionState: 'pursuing' | 'settled' = 'pursuing';

  /**
   * Actor world position recorded last frame. Used to compute the actor's
   * actual XZ speed for stuck detection.
   */
  protected prevActorPos: Vec3 | null = null;

  /**
   * Time (seconds) the actor has been below `stuckSpeedThreshold`
   * continuously. Reset on adequate movement or on transition out of
   * `settled`.
   */
  protected stuckTimer: number = 0;

  /**
   * True while `settled` was entered by the hard-stuck escape rather than by
   * arrival or the in-zone stuck fallback. Suppresses the
   * `stuckSettleMaxDistance` exit clause that would otherwise evict the actor
   * on the very next frame, and marks it for the retry release.
   */
  protected settledOutOfZone: boolean = false;

  /**
   * Time (s) the actor has been continuously beyond `stuckSettleMaxDistance`
   * while settled. The settled-exit edge is debounced in TIME rather than by a
   * distance margin: a distance margin would move the threshold off the attack
   * edge and re-open the out-of-range parking the gate exists to close.
   */
  protected settleExitDebounceTimer: number = 0;

  /**
   * Time (s) the actor has been continuously held BEYOND the settle gate while
   * pursuing, with the target still. Drives ENTRY to the hard-stuck park.
   *
   * Deliberately not `stuckTimer`: that measures "not moving" and resets on any
   * frame above `stuckSpeedThreshold`, which a jostling crowd clears
   * continuously — so a `stuckTimer`-driven entry never fires in exactly the
   * crowded scenario the escape exists for.
   */
  protected pursuingOutOfRangeTimer: number = 0;

  /**
   * Time (s) since the actor was parked out-of-zone by the hard-stuck escape.
   * Drives the RETRY release. Separate from the entry timer because a parked
   * actor cannot shorten its own path, so only elapsed time can re-engage it.
   */
  protected parkedRetryTimer: number = 0;

  /**
   * Consecutive hard-stuck parks without the actor reaching its gate in
   * between. Lengthens the park so a genuinely unreachable goal decays into a
   * slower duty cycle, while transient crowding still re-engages promptly.
   */
  protected consecutiveParks: number = 0;

  // ── Debug ──────────────────────────────────────────────────────────

  /**
   * Optional in-world text entity for live debug output. Each frame, a
   * line containing the motion state, desiredSpeed and distance to the
   * follow point is appended to a circular buffer of `debugMaxFrames`
   * entries; the buffer is then written into the entity's
   * `WorldTextComponent.text` (newline-separated, oldest first).
   *
   * If null or the entity has no `WorldTextComponent`, debug output
   * is skipped entirely (no buffering, no overhead beyond the null check).
   */
  debugTextEntity: Entity | null = null;

  /**
   * Maximum number of frames retained in the rolling debug log.
   */
  debugMaxFrames: number = 10;

  /** Internal: rolling log of debug lines (newest at the end). */
  protected debugLog: string[] = [];

  /** Internal: monotonic frame counter prefixed onto each log entry. */
  protected debugFrameCounter: number = 0;

  /** Internal: snapshot of the desiredSpeed sent to goto this frame. */
  protected debugLastDesiredSpeed: number = 0;

  /** Internal: snapshot of distance from actor to follow point this frame. */
  protected debugLastDistToFollow: number = 0;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);

    const currentPos = this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.basePriority = this.basePriority;
    this.gotoBehavior.desiredSpeed = this.effectiveFollowSpeed();
    this.gotoBehavior.targetPosition = currentPos;
    this.gotoBehavior.repathInterval = this.effectiveRepathInterval();
    this.gotoBehavior.distanceToStop = this.effectiveDistanceToStop();
    // Follower reassigns the target every frame; repath on the interval only.
    this.gotoBehavior.repathOnTargetChange = false;
    // FollowBehavior owns body direction (see updateBodyDirection); the nested
    // goto must not also claim the body-direction controller and fight it.
    this.gotoBehavior.shouldFaceDirection = false;
    this.gotoBehavior.initialize(this.behaviorManager!);
  }

  override onRemove(): void {
    this.isRemoved = true;
    super.onRemove();
  }

  override update(deltaTime: number): void {
    if (!this.gotoBehavior || !this.actorTransform) {
      return;
    }

    const targetPos = this.resolveTargetPosition(deltaTime);
    if (targetPos === null) {
      return;
    }

    this.followTarget(targetPos, deltaTime);
  }

  /**
   * Decides *what* to follow this frame and returns its world position.
   *
   * - Composite mode (`targetInfo` set): reads `predictedPosition` from the
   *   shared TargetInfo (smoothed position projected forward by
   *   `velocityPredictionTime`). When the parent's `velocityPredictionTime`
   *   is 0, this equals `smoothedPosition`.
   * - Standalone mode (`targetInfo` null): reads `worldPosition` from
   *   `targetEntity`. When `followPlayer` is true, the closest player is
   *   resolved into `targetEntity` first.
   *
   * Returns null when no valid target is available this frame.
   */
  protected resolveTargetPosition(_deltaTime: number): Vec3 | null {
    if (this.targetInfo) {
      return this.targetInfo.isValid ? this.targetInfo.predictedPosition : null;
    }

    if (this.followPlayer) {
      this.resolvePlayerTarget(_deltaTime);
    }

    // Composite mode's targeting sub-behavior logs its own target.
    const followed = this.targetEntity && !this.targetEntity.isDestroyed() ? this.targetEntity : null;
    this.targetLog.note(this, followed);
    if (!followed) {
      return null;
    }

    const targetTransform = followed.getComponent(TransformComponent);
    return targetTransform ? targetTransform.worldPosition : null;
  }

  /**
   * Decides *how* to follow: navigates to the target's actual position via
   * the NavMesh (routing around walls) and stops `followRange` short of the
   * target measured ALONG THE PATH. Mode-agnostic.
   *
   * Precondition: `gotoBehavior` and `actorTransform` are non-null
   * (verified by `update()`).
   */
  protected followTarget(targetPos: Vec3, deltaTime: number): void {
    const actorPos = this.actorTransform!.worldPosition;

    // Along-path distance to the standoff point: remaining route length minus
    // `followRange` (0 once within `followRange` of the target). Drives the
    // motion state machine and the arrival speed ramp.
    // Note: pre-first-repath getRemainingPathLength() is 0 (empty path), so
    // distToFollow is 0 and a hysteresis follower may settle for the first
    // spawn frame; benign — movement is gated on pathReady and it self-corrects
    // once a path exists.
    const standoff = this.effectiveFollowRange();
    const remainingPathLength = this.gotoBehavior!.getRemainingPathLength();
    const distToFollow = Math.max(0, remainingPathLength - standoff);

    // Target XZ speed — gates settled entry only (a slow-but-moving target
    // shouldn't briefly settle each cycle); speed itself is distance-derived.
    let targetSpeedXZ = 0;
    if (this.targetInfo && this.targetInfo.isValid) {
      const sv = this.targetInfo.smoothedVelocity;
      targetSpeedXZ = Math.sqrt(sv.x * sv.x + sv.z * sv.z);
    }
    const isTargetMoving =
      targetSpeedXZ > this.effectiveTargetMovingThreshold();

    // Drive the hysteresis state machine (decides pursue vs. park)
    this.updateMotionState(actorPos, deltaTime, distToFollow, isTargetMoving);

    // Update body direction (always — even when settled). Runs after the
    // motion state is resolved so faceMovement can gate its release on the
    // same settled state the motion machine uses this frame.
    this.updateBodyDirection(actorPos, targetPos);

    // Keep goto aimed at the target even when settled; retargeting actorPos
    // zeroes getRemainingPathLength() and traps the actor in `settled`.
    this.gotoBehavior!.targetPosition = targetPos;
    const computedDesiredSpeed =
      this.motionState === 'settled' ? 0 : this.computePursuitSpeed(distToFollow);
    this.gotoBehavior!.desiredSpeed = computedDesiredSpeed;
    this.gotoBehavior!.update(deltaTime);

    // Snapshot for debug, then push a frame entry into the rolling log.
    this.debugLastDistToFollow = distToFollow;
    this.debugLastDesiredSpeed = computedDesiredSpeed;
    this.updateDebugText();

    this.renderDebug();
  }

  /**
   * Pushes a frame entry into the rolling debug log and writes the log
   * to the configured `WorldTextComponent` on `debugTextEntity`. No-ops
   * cheaply when no debug entity is configured.
   *
   * Line format: `#<frame> <state> v=<desiredSpeed> d=<distToFollow>`
   * Example:    `#1247 pursuing v=2.43 d=0.85`
   */
  protected updateDebugText(): void {
    if (!this.debugTextEntity || this.debugTextEntity.isDestroyed()) {
      return;
    }

    this.debugFrameCounter++;
    const line =
      `#${this.debugFrameCounter} ${this.motionState} ` +
      `v=${this.debugLastDesiredSpeed.toFixed(2)} ` +
      `d=${this.debugLastDistToFollow.toFixed(2)}`;
    this.debugLog.push(line);
    while (this.debugLog.length > this.debugMaxFrames) {
      this.debugLog.shift();
    }

    const textComp = this.debugTextEntity.getComponent(WorldTextComponent);
    if (textComp) {
      textComp.text = this.debugLog.join('\n');
    }
  }

  /**
   * Hysteresis state machine. Reads `hysteresisRadius` and
   * `targetMovingThreshold` every frame so they can change dynamically.
   *
   * `distToFollow` is the remaining NavMesh path distance to the follow
   * point (not straight-line), so a follow point behind a wall keeps the
   * actor pursuing until it has detoured around the obstacle.
   *
   * - `pursuing → settled` when inside hysteresis AND (arrived at center
   *   within `distanceToStop`, or stuck-but-close fallback fires, or the
   *   hard-stuck escape fires) AND the target is essentially still. While the
   *   target is moving the actor stays in `pursuing` and arrival deceleration
   *   self-equilibrates the actor at an offset behind the follow point — no
   *   settle, no cycle.
   * - `settled → pursuing` when the actor falls outside the hysteresis
   *   radius, or when it is beyond `stuckSettleMaxDistance` without having
   *   arrived within `distanceToStop`. A moving target whose follow point
   *   still sits inside the soft zone is intentionally ignored so small
   *   player movements do not wake a parked actor.
   *
   * The arrival exemption on the second bullet is load-bearing: it keeps the
   * exit edge from being stricter than the entry edge, which would flap the
   * state every frame for any caller whose gate is below `distanceToStop`.
   *
   * `hysteresisRadius <= 0` disables the soft zone: full-speed pursuit that
   * still settles once the actor arrives at the follow point (within
   * `distanceToStop`), so `followRange` is honored.
   */
  /**
   * Clears every accumulator and latch the stuck/settle machinery owns.
   *
   * Extracted so the reset sites cannot drift apart: each previously cleared
   * its own subset, and the `hysteresisRadius <= 0` early return cleared only
   * `stuckTimer` — leaving `settledOutOfZone` latched, so re-enabling
   * hysteresis resumed in a park the actor could not leave.
   *
   * `consecutiveParks` is cleared here too, and the `settledOutOfZone` retry
   * release in `updateMotionState()` carries it across this call: the backoff
   * must survive a retry to accumulate at all. A future field with that same
   * retry-surviving property needs BOTH halves of that treatment — carried
   * across this call there, and cleared on the gate-reached edge — or it
   * accumulates for as long as the actor stays inside hysteresis.
   */
  protected resetStuckState(): void {
    this.stuckTimer = 0;
    this.settledOutOfZone = false;
    this.settleExitDebounceTimer = 0;
    this.pursuingOutOfRangeTimer = 0;
    this.parkedRetryTimer = 0;
    this.consecutiveParks = 0;
  }

  /**
   * `hysteresisRadius` as the state machine and the arrival ramp read it.
   *
   * A non-finite radius resolves to 0, the documented "no soft zone" disable.
   * NaN makes every `distToFollow <= radius` test false, so no settle can fire
   * and the `distToFollow / radius` ramp is NaN; `Infinity` keeps the actor
   * permanently inside the zone and collapses that ramp to 0, freezing it.
   */
  protected effectiveHysteresisRadius(): number {
    return Number.isFinite(this.hysteresisRadius) ? this.hysteresisRadius : 0;
  }

  /**
   * `distanceToStop` as the arrival tests read it. 0 is honoured; a negative or
   * non-finite value resolves to the declared default, because `Infinity` marks
   * the actor arrived everywhere and NaN marks it arrived nowhere.
   */
  protected effectiveDistanceToStop(): number {
    return Number.isFinite(this.distanceToStop) && this.distanceToStop >= 0
      ? this.distanceToStop
      : DEFAULT_DISTANCE_TO_STOP;
  }

  /**
   * `repathInterval` as the nested goto receives it. Only a positive finite
   * interval is an interval; anything else resolves to the declared default and
   * warns once. `GotoBehavior` stores this raw and gates its periodic repath on
   * `repathTimer >= repathInterval`, so `NaN` and `Infinity` stop that repath
   * for the actor's life, while `0` and negatives both leave the tick floor as
   * the only throttle (`repathTimer` starts at 0 and only grows, so `0 >= -1` is
   * true on frame one exactly as `0 >= 0` is). Three sibling behaviors forward
   * their own `repathInterval` into this field — `DeliverToTagBehavior`,
   * `SearchAndPickupBehavior` and `FollowTaggedEntityBehavior` — so an unset
   * property on any of them reaches this guard as `0`.
   */
  protected effectiveRepathInterval(): number {
    if (Number.isFinite(this.repathInterval) && this.repathInterval > 0) {
      // Interval reads valid again: clear the latch so a later, distinct
      // corruption is reported instead of healed silently — the same accept-path
      // re-arm `EngageCombatBehavior.sanitizeAttackBand` performs.
      this.hasWarnedRepathInterval = false;
      return this.repathInterval;
    }
    // WHY: this is where the file's one warn rule is stated, because every
    // diagnostic in it follows from the same test — EVERY REJECTED VALUE WARNS,
    // once per contiguous degenerate episode; an honoured value stays silent and
    // RE-ARMS the latch. `followSpeed === 0` is the sole exception on both counts:
    // it is honoured yet warns anyway (it silently freezes the actor), so it must
    // not re-arm or the diagnostic would re-emit every frame. Every other honoured
    // value — including `followRange === 0` — re-arms, so a second, distinct
    // corruption of the same field is reported rather than healed silently.
    //
    // Earlier versions instead warned only on `=== 0`, on the theory that the
    // remaining legs had "deleted the control path outright" and so needed no
    // disclosure. That per-leg classification was wrong three review rounds
    // running, and it was wrong structurally rather than by accident: an override
    // changes what an already-authored actor does in EVERY case, because the
    // resolved value is by definition not the authored one. `0` and negatives
    // here both repathed at the `MIN_UPDATES_PER_REPATH` floor; `NaN` and
    // `Infinity` deleted the periodic repath, so the override restores a control
    // path — which is equally a change to that actor's observable behaviour, just
    // in the other direction. Classifying which direction counts as "a fix" is
    // the author's call to make with the value in front of them, not this
    // accessor's to make silently.
    if (!this.hasWarnedRepathInterval) {
      this.hasWarnedRepathInterval = true;
      console.warn(
        `[FollowBehavior] repathInterval is ${this.repathInterval}, which is ` +
          `not an interval; using ${DEFAULT_REPATH_INTERVAL}s instead. 0 and ` +
          'negatives repathed as fast as the tick floor allowed, and NaN and ' +
          'Infinity stopped the periodic repath entirely — so a follower could ' +
          'not re-route toward a target that had moved. Set a positive interval ' +
          'explicitly (a template stores an unset numeric property as 0).',
      );
    }
    return DEFAULT_REPATH_INTERVAL;
  }

  /**
   * `followRange` as the standoff computation reads it.
   *
   * `0` is honoured and means "walk to the follow point itself" — three sibling
   * behaviors set it deliberately. A negative or non-finite value also resolves
   * to 0 rather than to the declared default: `Math.max(0, x - NaN)` is NaN, not
   * 0, so a degenerate range would poison `distToFollow` for the state machine
   * as well as for the speed ramp, and a sink clamp cannot repair that half.
   * Because that fallback is indistinguishable from an authored `0`, it warns
   * once — a negative range previously WIDENED `distToFollow` rather than
   * zeroing it, so this leg is a behaviour change and not only a fix.
   *
   * This accessor already followed the file's warn rule (see
   * `effectiveRepathInterval`): every rejected value warns, the honoured `0`
   * stays silent AND re-arms the latch. It re-arms because it is silent — only
   * `followSpeed === 0`, which warns while it is honoured, must not re-arm.
   * `Infinity` is among the rejected values, and resolving it to
   * `0` is a visible change — at master `Math.max(0, remainingPath - Infinity)`
   * was `0` every frame, so the actor counted as arrived and never moved; it now
   * pursues to the follow point. That is what the warning discloses.
   */
  protected effectiveFollowRange(): number {
    if (Number.isFinite(this.followRange) && this.followRange > 0) {
      // Accept-path re-arm — see `effectiveRepathInterval`. `applyRuntimeRanges`
      // in `FollowTaggedEntityBehavior` re-assigns `followRange` every frame, so
      // a later distinct corruption on the same actor is reachable.
      this.hasWarnedFollowRange = false;
      return this.followRange;
    }
    if (this.followRange === 0) {
      // Honoured, and it re-arms like any other honoured value. `followSpeed === 0`
      // is the rule's sole non-re-arming exception because that leg warns while it
      // is honoured, so clearing there would re-emit every frame; this leg is
      // silent, so a later NaN after an authored 0 must still be reported.
      this.hasWarnedFollowRange = false;
      return 0;
    }
    if (!this.hasWarnedFollowRange) {
      this.hasWarnedFollowRange = true;
      console.warn(
        `[FollowBehavior] followRange is ${this.followRange}, which is not a ` +
          'distance; using 0, so this actor walks to the follow point itself ' +
          'instead of standing off from it. Set a non-negative finite range.',
      );
    }
    return 0;
  }

  /**
   * `followSpeed` as the speed ramp reads it.
   *
   * A negative or non-finite speed resolves to the declared default rather than
   * to 0. Reading them as 0 would freeze an actor that previously moved, and a
   * frozen follower is the worst outcome available here: a zero speed never
   * shrinks `distToFollow`, so `inHysteresis` stays false, no settle can fire,
   * and the nested goto keeps paying a navmesh query every `repathInterval` for
   * the actor's life. `0` is honoured — it is what an author sets to hold an
   * actor still, and it froze the actor before these guards existed too — but it
   * is also the value a template instance zero-inits an unset property to, and
   * it produces the most visible symptom in the file with no other signal, so it
   * warns anyway.
   *
   * The honoured-`0` and rejected-value diagnostics carry separate latches, so a
   * direct `0 -> NaN` transition reports both rather than only the first. Their
   * remediations differ — "set a positive speed" versus "this value is not a
   * speed at all" — so suppressing the second would hide the actor's current
   * misconfiguration behind its previous one.
   */
  protected effectiveFollowSpeed(): number {
    if (Number.isFinite(this.followSpeed) && this.followSpeed > 0) {
      // Accept-path re-arm — see `effectiveRepathInterval`. `PatrolBehavior.update`
      // re-assigns `followSpeed` every frame and `setFollowSpeed` pushes a new one
      // at arbitrary times, so a later distinct corruption is reachable. A positive
      // finite speed is the ONLY value that re-arms either latch: the honoured `0`
      // leg below warns while it is honoured, so clearing on it would re-emit that
      // diagnostic every frame.
      this.hasWarnedFollowSpeed = false;
      this.hasWarnedZeroFollowSpeed = false;
      return this.followSpeed;
    }
    if (this.followSpeed === 0) {
      // The one honoured value in the file that warns anyway — see the rule on
      // `effectiveRepathInterval`. Nothing is overridden here; the diagnostic
      // exists because an actor that never moves AND never settles is the file's
      // most visible symptom and `0` is what a template stores for an unset
      // property, so silence would read as working content.
      if (!this.hasWarnedZeroFollowSpeed) {
        this.hasWarnedZeroFollowSpeed = true;
        console.warn(
          `[FollowBehavior] followSpeed is 0, so this actor will never move ` +
            `and never settle. Set a positive speed, or leave the field unset ` +
            `to use ${DEFAULT_FOLLOW_SPEED}.`,
        );
      }
      return 0;
    }
    if (!this.hasWarnedFollowSpeed) {
      this.hasWarnedFollowSpeed = true;
      console.warn(
        `[FollowBehavior] followSpeed is ${this.followSpeed}, which is not a ` +
          `speed; using ${DEFAULT_FOLLOW_SPEED}. Each of these described a ` +
          'MOVING actor before this guard existed — absurdly fast, or reversed ' +
          '— so this actor now runs at the default rate rather than at the ' +
          'authored one. Set a positive finite speed.',
      );
    }
    return DEFAULT_FOLLOW_SPEED;
  }

  /**
   * `targetMovingThreshold` as the settle gate reads it. 0 is honoured; a
   * negative or non-finite value resolves to the declared default. A negative
   * threshold is the dangerous direction: it reads every target as moving, and
   * that gate gates all three settle entries and the hard-stuck escape, so the
   * actor can never park and repaths for its whole life.
   */
  protected effectiveTargetMovingThreshold(): number {
    return Number.isFinite(this.targetMovingThreshold) &&
      this.targetMovingThreshold >= 0
      ? this.targetMovingThreshold
      : DEFAULT_TARGET_MOVING_THRESHOLD;
  }

  /**
   * `bodyDirectionAngularSpeed` as the controller call reads it.
   *
   * Among the values the declared `number` type admits, only `NaN` and
   * negatives are degenerate; anything that is not a number also resolves to the
   * declared default rather than to the snap rate.
   * `ActorBodyDirectionParams` is a plain unvalidating carrier, but the only
   * in-tree implementer of `rotateBodyTo` that reads `angularSpeed` is
   * `ActorTransformMoveComponent`, which is TypeScript: it
   * computes `t = min(rate * dt, angularDistance) / angularDistance` and slerps
   * by `t`, so the rate itself never crosses into native. What a `NaN` rate
   * produces is a `NaN` quaternion assigned to `worldRotation`, and a negative
   * one slerps away from the target. `0` (`t = 0`, facing held) and `Infinity`
   * (`t = 1`, instant snap) are both working configurations, and the four
   * sibling behaviors declaring this field pass it through raw — remapping them
   * here would make one authored value mean two things across the package. An
   * authored `Infinity` is honoured as a snap but forwarded as a large finite
   * rate, which snaps identically without the `Infinity * 0` hazard below.
   *
   * SCOPE — this guard does NOT close the `NaN`-quaternion hazard for the actor,
   * only for this behavior's own forward. `ActorTransformMoveComponent` stores
   * the rate in the per-controller field `wantedAngularSpeed` and reads it on
   * later frames, and five other producers forward the same field raw into the
   * same controller: `GotoBehavior`, `FleeBehavior`, `IdleWanderBehavior`,
   * `LeadBehavior`, and `AttackEntityInRangeBehavior` (as `rotationSpeed`).
   * One actor can run several behaviors, so any of
   * those can still poison `worldRotation` on an actor whose `FollowBehavior`
   * rate was clamped here. Closing it for the actor means clamping at the shared
   * sink — `rotateBodyTo` / `ActorBodyDirectionParams` — which is outside this
   * diff's two files and is not attempted here.
   */
  protected effectiveBodyDirectionAngularSpeed(): number {
    const rate = this.bodyDirectionAngularSpeed;
    // WHY: `Infinity` is matched explicitly rather than caught by a non-finite
    // fallthrough. A literal `Infinity` must not reach the controller — it
    // computes `min(rate * deltaTime, angularDistance)`, and `Infinity * 0` is
    // `NaN`, so a zero-length frame (produced whenever the simulation clock is
    // stopped, per `PlatformAPI::dispatchPlatformApiUpdateEvent`) slerps by
    // `NaN` and writes a `NaN` quaternion to `worldRotation`, which never
    // recovers because the `angularDistance < 0.01` snap escape is false for
    // `NaN` too. A catch-all instead of this equality test would resolve any
    // value that is not a number to the most aggressive rate in the file rather
    // than to the safest one, inverting the failure direction of the seven
    // sibling accessors, all of which accept only what they recognise.
    if (rate === Number.POSITIVE_INFINITY) {
      return MAX_BODY_DIRECTION_ANGULAR_SPEED;
    }
    return Number.isFinite(rate) && rate >= 0
      ? rate
      : DEFAULT_BODY_DIRECTION_ANGULAR_SPEED;
  }

  protected updateMotionState(
    actorPos: Vec3,
    deltaTime: number,
    distToFollow: number,
    isTargetMoving: boolean,
  ): void {
    // Every numeric this state machine reads is a public field an author can
    // set to anything, and `deltaTime` feeds an accumulator. Sanitize once,
    // here, and use the local copies below.
    //
    // A non-finite `deltaTime` would make `stuckTimer` NaN, and every
    // `NaN >= threshold` comparison is false — so the actor would never settle
    // via the fallback again, for its whole lifetime.
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    // Non-finite or negative reads as 0, which is exactly what an author-set 0
    // already means (fallback disabled).
    const settleTime =
      Number.isFinite(this.stuckSettleTime) && this.stuckSettleTime > 0
        ? this.stuckSettleTime
        : 0;
    const radius = this.effectiveHysteresisRadius();
    const stopDistance = this.effectiveDistanceToStop();

    if (radius <= 0) {
      // No soft zone: pursuit aims goto at the target itself, so settle at the
      // follow point (followRange out) instead of walking all the way in.
      this.motionState =
        distToFollow <= stopDistance ? 'settled' : 'pursuing';
      // Route through the helper rather than clearing `stuckTimer` alone.
      // Disabling hysteresis mid-engagement previously left `settledOutOfZone`
      // latched, so a subsequent re-enable resumed in a hard-stuck park the
      // actor could not leave.
      this.resetStuckState();
      this.prevActorPos = actorPos;
      return;
    }

    const inHysteresis = distToFollow <= radius;
    const arrivedAtCenter = distToFollow <= stopDistance;

    // Stuck detection: actual XZ speed of the actor over the last frame.
    // Only a positive finite threshold classifies motion correctly. `actualSpeed`
    // below is a magnitude, so `NaN`, `0` AND negatives all make the comparison
    // false even for a completely frozen actor — `actualSpeed < -1` is false for
    // exactly the reason `actualSpeed < 0` is — leaving `stuckTimer` pinned and
    // the in-zone stuck fallback dead. `Infinity` fails the other way: the
    // comparison is true however fast the actor moves, force-settling one that is
    // making progress. The hard-stuck escape is unaffected either way — it runs
    // off `pursuingOutOfRangeTimer`, not `stuckTimer`.
    const stuckSpeedIsUsable =
      Number.isFinite(this.stuckSpeedThreshold) && this.stuckSpeedThreshold > 0;
    const stuckSpeed = stuckSpeedIsUsable
      ? this.stuckSpeedThreshold
      : DEFAULT_STUCK_SPEED_THRESHOLD;
    // Warns on every rejected value, per the rule stated on
    // `effectiveRepathInterval`. An earlier version warned only on `=== 0`, on
    // the premise that the other legs "misclassified motion outright" and so
    // needed no disclosure. The magnitude argument above refutes that for the
    // negative leg: a negative threshold pinned `stuckTimer` at master exactly as
    // `0` did, so the override wakes the same dead settle path — a change to
    // already-authored behaviour that was being made silently.
    //
    // The latch re-arms on the accept path, as every other one in this file does
    // (see `effectiveRepathInterval`), so a later distinct corruption is reported
    // rather than healed silently.
    if (stuckSpeedIsUsable) {
      this.hasWarnedStuckSpeed = false;
    }
    if (!stuckSpeedIsUsable && !this.hasWarnedStuckSpeed) {
      this.hasWarnedStuckSpeed = true;
      console.warn(
        `[FollowBehavior] stuckSpeedThreshold is ${this.stuckSpeedThreshold}, ` +
          'which does not classify motion; using ' +
          `${DEFAULT_STUCK_SPEED_THRESHOLD} instead. NaN, 0 and negatives left ` +
          'the in-zone stuck fallback dead and this override makes it live; ' +
          'Infinity force-settled an actor that was still making progress. Set ' +
          'a positive threshold explicitly (a template stores an unset numeric ' +
          'property as 0).',
      );
    }
    if (this.prevActorPos !== null && dt > 0) {
      const adx = actorPos.x - this.prevActorPos.x;
      const adz = actorPos.z - this.prevActorPos.z;
      const actualSpeed = Math.sqrt(adx * adx + adz * adz) / dt;
      if (actualSpeed < stuckSpeed) {
        this.stuckTimer += dt;
      } else {
        this.stuckTimer = 0;
      }
    }
    this.prevActorPos = actorPos;

    const stuckFallback = settleTime > 0 && this.stuckTimer >= settleTime;
    // Gate the stuck fallback on proximity to the follow point. A stuck actor
    // only parks when it is within `stuckSettleMaxDistance` of the goal;
    // stuck-but-still-far (e.g. jostled just outside an attack band) keeps
    // pursuing so it can re-close once the blockage clears. Default Infinity
    // keeps the legacy "settle anywhere inside hysteresis" behavior.
    // ONLY a positive value is a gate. 0 (the zero-init case a `@property`
    // template instance gets), negatives and NaN all read as the `Infinity`
    // default — each would otherwise make every `distToFollow <= gate` test
    // false and DELETE the fallback rather than narrow it. A genuine
    // `Infinity` is honoured: "do not narrow" is coherent and equals
    // pre-change behaviour.
    // `Infinity` itself is not finite, so it takes the same branch as the bad
    // values and yields `Infinity` — which is exactly what it means.
    const settleGate =
      Number.isFinite(this.stuckSettleMaxDistance) &&
      this.stuckSettleMaxDistance > 0
        ? this.stuckSettleMaxDistance
        : Number.POSITIVE_INFINITY;
    const withinStuckSettleZone = distToFollow <= settleGate;
    const forcedSettle = inHysteresis && stuckFallback && withinStuckSettleZone;
    // Hard-stuck escape: bounds the pursue-repath loop for a permanently
    // unreachable follow point, which gating `forcedSettle` would otherwise
    // leave with no quiescence path at all. See `stuckSettleHardMultiplier`.
    // Clamped on BOTH sides, because the two failure modes are symmetric:
    // below 1 the escape fires before the normal fallback and defeats the gate,
    // while a large value deletes the escape entirely — and a large FINITE
    // value (1e9) does that just as effectively as `Infinity`, so a
    // `Number.isFinite` guard alone closes one door and leaves the other open.
    // Any non-finite value reads as the floor of 1. Note the deliberate
    // contrast with `settleGate` above: there `Infinity` is the SAFE state,
    // here it is the unsafe one.
    const hardMultiplier = Number.isFinite(this.stuckSettleHardMultiplier)
      ? Math.min(
          Math.max(this.stuckSettleHardMultiplier, 1),
          MAX_HARD_STUCK_MULTIPLIER,
        )
      : 1;
    // Held beyond the gate, with the target essentially still. `!isTargetMoving`
    // is part of the ENTRY condition, not just of the settle: arrival
    // deceleration deliberately holds a chasing actor at an equilibrium offset
    // behind the follow point (`hysteresisRadius * targetSpeed / followSpeed`),
    // which exceeds a combat-derived gate for any target above ~1.5 m/s at the
    // shipped defaults. Without this term a healthy pace-matching chase — the
    // DEFAULT case, not a corner case — arms the escape for its whole duration
    // and parks the actor the first frame the target stops.
    const heldOutOfRange =
      inHysteresis && !withinStuckSettleZone && !arrivedAtCenter && !isTargetMoving;
    // Reaching the gate clears the backoff in EITHER motion state, so a
    // transient jam cannot lengthen the park for an unrelated later one.
    if (withinStuckSettleZone || arrivedAtCenter) {
      this.consecutiveParks = 0;
    }
    if (this.motionState === 'pursuing') {
      if (heldOutOfRange) {
        this.pursuingOutOfRangeTimer += dt;
      } else {
        // Decay, not reset — same reason as the settled-exit edge. A hard reset
        // lets an actor that dips inside the gate one frame in five hold the
        // timer at zero, and since `forcedSettle` is already gated off for such
        // an actor that leaves it with NO quiescence path at all.
        this.pursuingOutOfRangeTimer = Math.max(
          0,
          this.pursuingOutOfRangeTimer - dt * GATE_TIMER_DECAY_RATE,
        );
      }
    }
    const hardStuck =
      settleTime > 0 &&
      this.pursuingOutOfRangeTimer >= settleTime * hardMultiplier;

    if (this.motionState === 'pursuing') {
      // Only park when the target is essentially still. While the target
      // is moving, pace matching handles things smoothly inside pursuing
      // (entering settled here would cause stop-go cycles).
      if (
        inHysteresis &&
        (arrivedAtCenter || forcedSettle || hardStuck) &&
        !isTargetMoving
      ) {
        this.motionState = 'settled';
        // Spend the debounce charge at the single ENTRY site rather than at
        // each of the ways out: exits are easy to add and forget.
        this.settleExitDebounceTimer = 0;
        // Only a hard-stuck park is out-of-zone: arrival and `forcedSettle`
        // both imply the actor is somewhere the settled branch will hold it.
        this.settledOutOfZone =
          !arrivedAtCenter && !withinStuckSettleZone && hardStuck;
        // Spend the entry charge at the single ENTRY site. The timer is frozen
        // while settled (only the pursuing branch above touches it), so a
        // charge carried across the settled state would trip the escape within
        // a frame or two of the actor next being evicted and park it straight
        // back out of range, instead of granting a full pursue window.
        this.pursuingOutOfRangeTimer = 0;
        if (this.settledOutOfZone) {
          // Start the park clock. The retry release below waits a full
          // interval rather than firing immediately.
          this.parkedRetryTimer = 0;
          this.consecutiveParks = Math.min(
            this.consecutiveParks + 1,
            MAX_PARK_BACKOFF,
          );
        }
      }
    } else {
      // settled — exit on hysteresis exit, OR when the actor is pushed back
      // out past `stuckSettleMaxDistance` (jostled beyond the settle zone).
      // The second clause mirrors the pursuing-side gate: a combat actor that
      // settled in-band and is then bumped outside its attack range must
      // resume pursuing to re-close, not stay parked out of range — the same
      // failure this change targets, reached via settle-then-jostle instead of
      // stall-then-settle. Default Infinity `stuckSettleMaxDistance` makes the
      // second clause a no-op, preserving the legacy "exit only on hysteresis
      // exit" behavior for non-combat followers. A moving target whose follow
      // point still sits inside both zones is intentionally ignored: we wait
      // for it to walk far enough that the follow point escapes the soft zone.
      //
      // `arrivedAtCenter` exempts the zone clause so this edge can never be
      // STRICTER than the pursuing-side entry edge: the actor physically parks
      // anywhere within `distanceToStop`, so a caller whose gate is tighter
      // than that would otherwise settle on arrival and be evicted on the very
      // next frame, flapping at tick rate forever. `EngageCombatBehavior`
      // floors its derived gate at `distanceToStop` for the same reason; this
      // clause makes the state machine robust to any caller that does not.
      if (!inHysteresis) {
        this.motionState = 'pursuing';
        this.resetStuckState();
      } else if (this.settledOutOfZone) {
        // Parked by the hard-stuck escape. Wake either when the actor is back
        // inside its gate (the blockage cleared and something moved it), or
        // after the park interval elapses.
        //
        // The park is the SHORT half of the duty cycle on purpose: a parked
        // actor cannot shorten its own path, so a crowd that clears is only
        // noticed on the retry — which makes the park duration the worst-case
        // added attack latency in exactly the case this exists to fix.
        //
        // Driven by its own timer, not `stuckTimer`: `stuckTimer` resets on any
        // frame above `stuckSpeedThreshold`, so an actor shoved by a crowd
        // while parked would never satisfy it and would stay parked forever.
        this.parkedRetryTimer += dt;
        // Backed off over consecutive failed retries, but capped as a FRACTION
        // of the pursue window so the park can never grow to match or exceed
        // it. The step cap alone does not hold that: at the multiplier clamp
        // floor of 1 a step-capped park equals the pursue window exactly.
        const parkInterval = Math.min(
          settleTime * Math.max(1, this.consecutiveParks),
          settleTime * hardMultiplier * MAX_PARK_FRACTION_OF_PURSUE,
        );
        if (
          withinStuckSettleZone ||
          arrivedAtCenter ||
          this.parkedRetryTimer >= parkInterval
        ) {
          this.motionState = 'pursuing';
          // Carried across the helper's clear: the backoff must survive a retry
          // or it can never accumulate, which would make the park interval fixed.
          const backoff = this.consecutiveParks;
          this.resetStuckState();
          this.consecutiveParks = backoff;
        }
      } else if (!withinStuckSettleZone && !arrivedAtCenter) {
        // DEBOUNCED, not instantaneous. Once `EngageCombatBehavior`'s derived
        // gate equals `distanceToStop` — which it does at every band where the
        // outer inset binds, since both come from `getArrivalTolerance()` —
        // settle-entry (`<= gate`) and this exit (`> gate`) sit on ONE shared
        // threshold, and contact jitter alone would flap `desiredSpeed`
        // between 0 and full pursuit at tick rate. That is worse than the
        // out-of-range parking this clause exists to fix, and it would also
        // zero `stuckTimer` on every flip.
        // The interval is clamped on BOTH sides. `settleTime` derives from the
        // author-settable `stuckSettleTime`, which is sanitized only against
        // non-finite/non-positive values, so a large FINITE value (30s) would
        // hold a jostled actor in `settled` for that whole interval and
        // re-create the out-of-range parking this clause exists to fix —
        // exactly the asymmetry `MAX_HARD_STUCK_MULTIPLIER` above exists to
        // close. This bounds THIS edge only; the `settledOutOfZone` park above
        // has its own interval and its own bound.
        // Floor applied LAST, so it wins if the two constants ever cross. The
        // opposite order lets a ceiling below the floor delete the floor for
        // every caller, and the flap that guards against is the worse failure
        // of the two (see above). Identical at the shipped constants.
        this.settleExitDebounceTimer += dt;
        if (
          this.settleExitDebounceTimer >=
          Math.max(
            Math.min(settleTime, MAX_SETTLE_EXIT_DEBOUNCE_S),
            MIN_SETTLE_EXIT_DEBOUNCE_S,
          )
        ) {
          this.motionState = 'pursuing';
          this.resetStuckState();
        }
      } else {
        // Back on the favourable side: DECAY the charge rather than clearing
        // it. A hard reset here lets an actor oscillating across the gate zero
        // the timer every other frame and stay parked out of range forever.
        this.settleExitDebounceTimer = Math.max(
          0,
          this.settleExitDebounceTimer - dt * GATE_TIMER_DECAY_RATE,
        );
      }
    }
  }

  /**
   * Arrival-style pursuit speed (Reynolds steering).
   *
   * `desiredSpeed = followSpeed * clamp(distToFollow / hysteresisRadius, 0, 1)`
   *
   * `distToFollow` here is the remaining NavMesh path distance (see
   * `GotoBehavior.getRemainingPathLength`), so deceleration ramps down over
   * the actual route rather than the straight-line gap.
   *
   * - At or beyond `hysteresisRadius`: full `followSpeed` (max chase).
   * - Inside the zone: linearly ramps to 0 at the follow-point center.
   *
   * Depends only on distance — no target-velocity input — so there is
   * no transient when the target's smoothed velocity is mid-decay. When
   * the target moves at a steady speed the actor self-equilibrates at an
   * offset behind the follow point (offset ≈ `hysteresisRadius *
   * targetSpeed / followSpeed`), automatically pace-matching without any
   * explicit pace-match formula.
   *
   * `hysteresisRadius <= 0` disables arrival deceleration entirely —
   * pursuit always uses `followSpeed`.
   */
  protected computePursuitSpeed(distToFollow: number): number {
    // Total by contract: always a finite speed >= 0, for every input.
    // `GotoBehavior` forwards `desiredSpeed` into `ActorMoveParams` without
    // validating it, and every author-settable numeric that feeds the per-frame
    // speed — `followSpeed`, `hysteresisRadius`, and `followRange` via
    // `distToFollow` — passes through here, so the bound lives here rather than
    // at each source. A degenerate input yields 0, which stops the actor without
    // settling it: `motionState` is driven by `distToFollow`, not by speed. The
    // one other write to `desiredSpeed` is the initial push in `initialize()`,
    // which routes `followSpeed` through the same accessor.
    const speed = this.effectiveFollowSpeed();
    const radius = this.effectiveHysteresisRadius();
    if (radius <= 0) {
      return speed;
    }
    const rampedSpeed = speed * Math.min(1, distToFollow / radius);
    return Number.isFinite(rampedSpeed) && rampedSpeed > 0 ? rampedSpeed : 0;
  }

  /**
   * Updates the actor's body direction based on bodyDirectionMode.
   *   faceTarget:   actor faces toward the target entity
   *   faceMovement: actor faces its travel heading (toward its path waypoint)
   *   matchTarget:  actor faces the same direction as the target entity
   *   none:         body direction is left uncontrolled (facing held)
   */
  protected updateBodyDirection(actorPos: Vec3, targetPos: Vec3): void {
    if (this.bodyDirectionMode === 'none') {
      this.desiredBodyDirection = null;
      return;
    }

    if (this.bodyDirectionMode === 'faceMovement') {
      if (this.gotoBehavior?.usesNavMeshAgent) {
        this.desiredBodyDirection = this.motionState !== 'settled'
          ? this.gotoBehavior.getTravelDirection()
          : null;
        return;
      }
      // Face the current path waypoint (target as pre-path fallback) so facing
      // follows the route around corners instead of pointing through a wall.
      // Gate release on the settled state — not a separate distance test — so
      // facing and motion agree at the arrival boundary; the magnitude guard
      // skips a degenerate heading when the actor sits on the waypoint.
      //
      // Resolving `distanceToStop` here also changes body-direction CONTROLLER
      // ARBITRATION for a degenerate authored value, not just the facing: at
      // master `magnitude() > NaN` and `magnitude() > Infinity` were both false,
      // so `desiredBodyDirection` stayed null, `getControllerUsePriority` fell
      // through to the nested goto's and `useController` never called
      // `rotateBodyTo`. Against the resolved default the comparison holds, so this
      // behavior now bids `basePriority` for that controller and can take it from
      // a sibling behavior that previously won it. `effectiveDistanceToStop()` is
      // one of the accessors that deliberately emits no diagnostic, so this is
      // disclosed here and in the summary rather than at runtime.
      const movePoint = this.gotoBehavior?.getCurrentWaypoint() ?? targetPos;
      const toMove = movePoint.sub(actorPos);
      const moveXZ = new Vec3(toMove.x, 0, toMove.z);
      if (
        this.motionState !== 'settled' &&
        moveXZ.magnitude() > this.effectiveDistanceToStop()
      ) {
        this.desiredBodyDirection = moveXZ.normalize();
      } else {
        this.desiredBodyDirection = null;
      }
      return;
    }

    if (this.bodyDirectionMode === 'matchTarget') {
      const entity = this.targetInfo?.targetEntity ?? this.targetEntity;
      if (!entity || entity.isDestroyed()) return;
      const transform = entity.getComponent(TransformComponent);
      if (!transform) return;
      const forward = transform.worldRotation.mulVec3(Vec3.forward);
      const forwardXZ = new Vec3(forward.x, 0, forward.z);
      if (forwardXZ.magnitude() > 0.001) {
        this.desiredBodyDirection = forwardXZ.normalize();
      }
      return;
    }

    // faceTarget (default)
    const toTarget = targetPos.sub(actorPos);
    const directionXZ = new Vec3(toTarget.x, 0, toTarget.z);
    if (directionXZ.magnitude() > 0.001) {
      this.desiredBodyDirection = directionXZ.normalize();
    }
  }

  /**
   * Renders debug visualization. Override to add custom debug rendering.
   */
  protected renderDebug(): void {
    // No-op by default
  }

  /**
   * Searches for the closest player and sets it as targetEntity.
   * Called every frame in followPlayer mode but only performs the actual
   * PlayerService query at playerSearchInterval intervals (or immediately
   * when there is no valid target).
   */
  protected resolvePlayerTarget(deltaTime: number): void {
    const needsTarget = !this.targetEntity || this.targetEntity.isDestroyed();

    // A non-finite frame would contribute NaN to the timer, costing one
    // unthrottled scan before the reset below clears it.
    this.playerSearchTimer +=
      Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    // The accept test admits a positive number, `Infinity` included, and nothing
    // else. `NaN`, `0` and negatives all make the comparison below false forever
    // — `playerSearchTimer` only ever accumulates non-negative deltas, so
    // `timer < -1` is false for the reason `timer < 0` is — leaving the early
    // return unreachable and the O(players) scan running every frame, including a
    // fresh `Vector<Entity>` across the V8 boundary each time.
    //
    // `typeof interval === 'number'` is load-bearing and not redundant: `>`
    // applies ToNumber coercion where `Number.isFinite` does not, so without it a
    // `Date`, a numeric string or `true` passes the accept test and is then used
    // verbatim as the interval — `new Date() > 0` would hold the early return
    // open for ~1.7e12 seconds and delete re-acquisition silently. The seven
    // sibling accessors are anchored on `Number.isFinite`, which rejects those
    // already; this guard cannot use `Number.isFinite` because it must admit
    // `Infinity`, so it spells the same accept-list out longhand.
    //
    // `Infinity` is NOT degenerate and is honoured. `timer < Infinity` is always
    // true, so the early return is always taken while a target is held: it means
    // "acquire once, then never re-scan". Re-acquisition after the target dies
    // runs off `needsTarget` below, not off the interval, so nothing is deleted.
    // Overriding it would impose a re-scan twice a second on an actor authored to
    // lock on — the per-frame cost this guard exists to avoid — and would
    // silently re-target that follower to whichever player is nearest.
    //
    // Every REJECTED value warns, latched once per actor, per the rule stated on
    // `effectiveRepathInterval`. An earlier version narrowed this to `=== 0` on
    // the premise that `NaN` and negatives had "deleted the throttle outright"
    // and so needed no disclosure; they had not — both left the same unthrottled
    // per-frame scan that `0` did, so the override changes all three identically.
    // The latch re-arms on the accept path, as every other one in this file does
    // (see `effectiveRepathInterval`), so a later distinct corruption of the same
    // field is reported rather than healed silently.
    const interval = this.playerSearchInterval;
    const intervalThrottles = typeof interval === 'number' && interval > 0;
    if (intervalThrottles) {
      this.hasWarnedSearchInterval = false;
    }
    if (!intervalThrottles && !this.hasWarnedSearchInterval) {
      this.hasWarnedSearchInterval = true;
      console.warn(
        `[FollowBehavior] playerSearchInterval is ${String(interval)}, which is ` +
          'not an interval, so the O(players) player search was running on ' +
          `every frame; using ${DEFAULT_PLAYER_SEARCH_INTERVAL}s instead. Set a ` +
          'positive interval explicitly (a template stores an unset numeric ' +
          'property as 0), or Infinity to acquire a target once and never ' +
          're-scan.',
      );
    }
    const searchInterval = intervalThrottles
      ? interval
      : DEFAULT_PLAYER_SEARCH_INTERVAL;
    if (!needsTarget && this.playerSearchTimer < searchInterval) {
      return;
    }
    this.playerSearchTimer = 0;

    // The roster skips this actor (bot players are in the player list and
    // would target themselves at distance 0, parking at their spawn position)
    // and dead players; the query adds the caller's filter (e.g. managed bots).
    const nearestPlayer = PlayerRoster.get().nearest(
      this.actorTransform!.worldPosition,
      this.getEntity(),
      Number.POSITIVE_INFINITY,
      this.playerQuery,
    );

    if (nearestPlayer) {
      this.targetEntity = nearestPlayer;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    const hasTarget = this.targetInfo
      ? this.targetInfo.isValid
      : (this.targetEntity && !this.targetEntity.isDestroyed());

    if (!hasTarget || !this.gotoBehavior) {
      return super.getControllerUsePriority(controllerType);
    }

    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      return this.basePriority;
    }

    return this.gotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(
          this.desiredBodyDirection,
          this.effectiveBodyDirectionAngularSpeed(),
        ),
      );
    }

    if (this.gotoBehavior) {
      this.gotoBehavior.useController(controllerType, controller);
    }
  }
}
