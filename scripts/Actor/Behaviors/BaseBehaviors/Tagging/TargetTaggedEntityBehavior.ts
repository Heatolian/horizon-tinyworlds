/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v35

import {Vec3, TransformComponent, type Entity} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {TargetInfo} from '../TargetingBehavior';
import {BlackboardScope} from 'meta/worlds';
import {ActorTaggingBlackboard} from 'meta/worlds';
import {findCharacterGAS} from '../../../../Character/gas/CharacterGASComponent';
import {TargetDeathReader} from '../../../Utilities/ActorDeathReader';
import {TargetLog} from '../../../Utilities/ActorBehaviorLog';

/**
 * Named `candidateFilter` functions for `TargetTaggedEntityBehavior`. Scene
 * data cannot carry a function, so a world script registers one under a name
 * and sets `candidateFilterKey` to that name (directly, or through the
 * starter). Lives here — not in a world file — so both the behavior and any
 * world-side registrar import the same registry without the behavior
 * importing world code.
 */
export class CandidateFilterRegistry {
  private static readonly filters: Map<string, (entity: Entity) => boolean> =
    new Map();

  static register(key: string, filter: (entity: Entity) => boolean): void {
    CandidateFilterRegistry.filters.set(key, filter);
  }

  static unregister(key: string): void {
    CandidateFilterRegistry.filters.delete(key);
  }

  static resolve(key: string): ((entity: Entity) => boolean) | null {
    return CandidateFilterRegistry.filters.get(key) ?? null;
  }
}

/**
 * Acquires and tracks the closest entity matching a given tag, writing
 * smoothed position, velocity, and predicted position data to a shared
 * TargetInfo object.
 *
 * Designed to run inside a CompositeBehavior at the highest internal
 * priority so that target data is established before other sub-behaviors
 * (e.g. FollowBehavior) execute.
 *
 * Does not use any controllers (getControllerUsePriority always returns -1).
 */
export class TargetTaggedEntityBehavior extends ActorBehavior {
  override name: string = 'TargetTaggedEntityBehavior';

  /**
   * The tags to query for (e.g. ["enemy"], ["player", "enemy"]).
   * The closest entity matching any tag is selected.
   *
   * ⚠️ Consumer half only. The target entity must ALSO carry a matching
   * `ActorSdkTagComponent` (set its `tags` property to the same case-sensitive
   * string, or register the entity via `ActorTaggingBlackboard.registerTags`);
   * players are auto-tagged "player". Otherwise this resolves no target. See the
   * Tag Targeting Contract in implementing-actor-behaviors.
   */
  targetTags: string[] = [];

  /**
   * Time constant for position smoothing in seconds.
   */
  positionSmoothingTimeConstant: number = 0.3;

  /**
   * Time constant for velocity smoothing in seconds.
   */
  velocitySmoothingTimeConstant: number = 0.5;

  /**
   * How far ahead to predict the target's position in seconds.
   */
  velocityPredictionTime: number = 0.5;

  /**
   * The shared TargetInfo object this behavior writes to.
   * Must be set by the parent CompositeBehavior before initialize().
   */
  targetInfo: TargetInfo = new TargetInfo();

  /**
   * Maximum range in meters for target acquisition and retention.
   * Targets beyond this distance are ignored. Set to 0 or negative to disable.
   */
  maxRange: number = 0;

  /**
   * Horizontal view angle (deg) a candidate must fall inside to be NOTICED,
   * measured from the actor's body facing. 0 (default) disables the check and
   * keeps the omniscient acquisition; a positive value makes the actor notice
   * only what is in front of it, so it must search rather than know. An
   * acquired target is kept without re-checking the cone, so turning away
   * does not drop it. Facing only: no occlusion is tested, so a candidate
   * behind a wall inside the cone still resolves — pair with
   * `candidateFilter` for line-of-sight.
   */
  viewAngleDeg: number = 0;

  /**
   * Extra per-candidate veto, checked after the tag, range, view-angle and
   * death filters. Game-specific notions of "useful" live here rather than in
   * this class: a world script sets it (e.g. skip opened chests, skip ammo the
   * actor cannot use), and the layering check stays clean because this file
   * never imports item or loot internals. Null (default) vetoes nothing.
   */
  candidateFilter: ((entity: Entity) => boolean) | null = null;

  /**
   * Registry key for a world-provided `candidateFilter`. Scene data cannot
   * carry a function, so a world script registers one under a name
   * (`CandidateFilterRegistry.register`) and names it here — through the
   * starter, like `excludedTags`. Empty (default) uses no registry filter.
   * A directly assigned `candidateFilter` and a keyed one must both pass.
   */
  candidateFilterKey: string = '';

  /**
   * Tags whose carriers are never selected, even when they also carry a
   * target tag. The declarative form of `candidateFilter` for tag-shaped
   * game state: a world tags looted chests "opened" and lists it here, and
   * the search skips them without any script. Empty (default) skips nothing.
   * Resolved through the same blackboard as the target tags, so no new
   * component dependency.
   */
  excludedTags: string[] = [];

  /**
   * Optional forced target override. When set (non-null), resolveTarget()
   * returns this entity directly instead of querying the ActorTaggingBlackboard.
   * A dead override resolves no target until it is revived or cleared; a
   * destroyed one is skipped, and the blackboard query runs.
   */
  forcedTargetOverride: Entity | null = null;

  /**
   * Entities this search must never select, even when they carry a matching
   * tag and are the closest candidate.
   *
   * Picking an item up does NOT remove its tag, and a held item rides the
   * actor's hand roughly half a metre away — so without this a repeating
   * search re-acquires the thing it is already carrying and walks toward a
   * point that moves with it, which reads as the actor wandering off in a
   * straight line forever. `SearchAndPickupBehavior` populates this with what
   * it has picked up.
   *
   * Null rather than an empty Set by default so the common case allocates
   * nothing; this runs inside per-frame target resolution.
   *
   * Read back in `resolveTarget` below, which skips every listed entity —
   * that is what makes a retirement stick: the writer (give-up, pickup,
   * seeding) publishes the set here and the next resolution honors it.
   */
  excludeEntities: Set<Entity> | null = null;

  /**
   * Grace period in seconds before warning that `targetTags` resolved zero
   * tagged entities. Gives producer `ActorSdkTagComponent`s time to register on
   * their own OnEntityStartEvent before we conclude none exist. See the Tag
   * Targeting Contract in implementing-actor-behaviors.
   */
  noProducerGraceSeconds: number = 3;

  protected actorTransform: TransformComponent | null = null;
  protected smoothedTargetPos: Vec3 | null = null;
  protected previousSmoothedTargetPos: Vec3 | null = null;
  protected rawVelocity: Vec3 = new Vec3(0, 0, 0);
  protected internalSmoothedVelocity: Vec3 = new Vec3(0, 0, 0);

  // ── Tag-resolution observability (latched one-shot diagnostics) ─────
  /**
   * Total tagged entities the blackboard returned on the last resolveTarget()
   * call, BEFORE range filtering. 0 with a non-empty `targetTags` means no
   * producer registered the tag at runtime (see Tag Targeting Contract).
   */
  private lastTaggedCandidateCount: number = 0;
  private noProducerElapsed: number = 0;
  private hasLoggedAcquire: boolean = false;
  private hasWarnedNoProducer: boolean = false;
  private hasWarnedFilterThrew: boolean = false;
  private hasWarnedFilterNonBoolean: boolean = false;
  private hasWarnedKeyedFilterThrew: boolean = false;
  private hasWarnedKeyedFilterNonBoolean: boolean = false;

  private readonly overrideDeath = new TargetDeathReader();
  private readonly targetLog: TargetLog = new TargetLog('targeting');

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  override update(deltaTime: number): void {
    const currentTarget = this.resolveTarget();
    this.updateTagObservability(deltaTime, currentTarget);
    this.targetLog.note(this, currentTarget && !currentTarget.isDestroyed() ? currentTarget : null);

    if (!currentTarget || currentTarget.isDestroyed()) {
      this.targetInfo.isValid = false;
      this.targetInfo.targetEntity = null;
      this.resetSmoothing();
      return;
    }

    const targetTransform = currentTarget.getComponent(TransformComponent);
    if (!targetTransform) {
      this.targetInfo.isValid = false;
      return;
    }

    const rawPos = targetTransform.worldPosition;

    const smoothedPos = this.smoothTargetPosition(rawPos, deltaTime);
    this.updateTargetVelocity(smoothedPos, deltaTime);
    const predictedPos = this.computePredictedPosition(smoothedPos);

    this.targetInfo.targetEntity = currentTarget;
    this.targetInfo.rawPosition = rawPos;
    this.targetInfo.smoothedPosition = smoothedPos;
    this.targetInfo.smoothedVelocity = this.internalSmoothedVelocity;
    this.targetInfo.predictedPosition = predictedPos;
    this.targetInfo.isValid = true;
  }

  override getControllerUsePriority(_controllerType: string): number {
    return -1;
  }

  // ── Target Resolution ───────────────────────────────────────────────

  /**
   * Finds the closest entity matching any tag in `targetTags` from the
   * global ActorTaggingBlackboard, excluding the owning entity itself.
   */
  protected resolveTarget(): Entity | null {
    // Forced override takes precedence over the blackboard query.
    if (this.forcedTargetOverride && !this.forcedTargetOverride.isDestroyed()) {
      return this.overrideDeath.isDead(this.forcedTargetOverride) ? null : this.forcedTargetOverride;
    }

    if (!this.behaviorManager || !this.actorTransform || this.targetTags.length === 0) {
      return null;
    }

    // Reset up front so the null-blackboard early return below leaves a 0 count
    // (no blackboard => nothing registered) rather than a stale value.
    this.lastTaggedCandidateCount = 0;

    const taggingBB = this.behaviorManager.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      /* actorId */ undefined,
      /* groupId */ undefined,
      BlackboardScope.Global,
    );

    if (!taggingBB) {
      return null;
    }

    const actorPos = this.actorTransform.worldPosition;
    const selfEntity = this.getEntity();
    const maxRangeSq = this.maxRange > 0 ? this.maxRange * this.maxRange : Infinity;
    const facing = this.viewFacing();
    // Entities carrying an excluded tag, resolved once per frame rather than
    // per candidate. Tag populations are small; a world excluding a tag
    // carried by hundreds of entities should use candidateFilter instead.
    // Refilled into a cached set: this runs inside per-frame target
    // resolution, so it must not allocate.
    let excluded: Set<Entity> | null = null;
    if (this.excludedTags.length > 0) {
      excluded = this.excludedScratch;
      excluded.clear();
      for (const tag of this.excludedTags) {
        for (const entry of taggingBB.getTaggedEntities(tag)) {
          excluded.add(entry.entity);
        }
      }
    }

    let closestEntity: Entity | null = null;
    let closestDistSq = Infinity;
    let taggedCount = 0;

    // The keyed world filter, resolved once per frame rather than per
    // candidate — same world-supplied closure as candidateFilter, same guard.
    const keyedFilter =
      this.candidateFilterKey.length > 0
        ? CandidateFilterRegistry.resolve(this.candidateFilterKey)
        : null;

    for (const tag of this.targetTags) {
      const tagged = taggingBB.getTaggedEntities(tag);
      taggedCount += tagged.length;

      for (const entry of tagged) {
        if (entry.entity === selfEntity) {
          continue;
        }

        // A deregistered handle is never resolvable: without this the query
        // stalls on the nearest dead handle instead of taking the next-nearest
        // live candidate (the blackboard drops destroyed entries, not invalid ones).
        if (entry.entity.valid === false) {
          continue;
        }

        if (this.excludeEntities?.has(entry.entity)) {
          continue;
        }

        if (excluded?.has(entry.entity)) {
          continue;
        }

        // A corpse keeps its tag, so without this the actor keeps pursuing it
        // after the attack controller has already refused to hit it.
        if (isDead(entry.entity)) {
          continue;
        }

        const transform = entry.entity.getComponent(TransformComponent);
        if (!transform) {
          continue;
        }

        const pos = transform.worldPosition;
        const dx = pos.x - actorPos.x;
        const dy = pos.y - actorPos.y;
        const dz = pos.z - actorPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        // The cone gates noticing, not keeping: the held target skips it (range,
        // exclusion and death below still drop it).
        if (facing && entry.entity !== this.targetInfo.targetEntity && !inViewCone(dx, dz, facing)) {
          continue;
        }

        if (this.candidateFilter) {
          let keep = false;
          try {
            keep = this.candidateFilter(entry.entity);
          } catch {
            // A game-supplied closure: one throwing entity must veto itself,
            // not abort the whole per-frame resolution.
            if (!this.hasWarnedFilterThrew) {
              this.hasWarnedFilterThrew = true;
              console.warn('[TargetTaggedEntity] candidateFilter threw; vetoing that candidate.');
            }
          }
          if (typeof keep !== 'boolean' && !this.hasWarnedFilterNonBoolean) {
            this.hasWarnedFilterNonBoolean = true;
            console.warn(
              '[TargetTaggedEntity] candidateFilter returned a non-boolean; vetoing that candidate.',
            );
          }
          // Fail closed: only an explicit true keeps the candidate.
          if (keep !== true) {
            continue;
          }
        }

        if (keyedFilter) {
          let keepKeyed = false;
          try {
            keepKeyed = keyedFilter(entry.entity);
          } catch {
            // Same guard as candidateFilter above: a throwing world filter
            // vetoes that candidate instead of aborting the resolution.
            if (!this.hasWarnedKeyedFilterThrew) {
              this.hasWarnedKeyedFilterThrew = true;
              console.warn(
                `[TargetTaggedEntity] candidateFilterKey='${this.candidateFilterKey}' threw; vetoing that candidate.`,
              );
            }
          }
          if (typeof keepKeyed !== 'boolean' && !this.hasWarnedKeyedFilterNonBoolean) {
            this.hasWarnedKeyedFilterNonBoolean = true;
            console.warn(
              `[TargetTaggedEntity] candidateFilterKey='${this.candidateFilterKey}' returned a non-boolean; vetoing that candidate.`,
            );
          }
          if (keepKeyed !== true) {
            continue;
          }
        }

        if (distSq <= maxRangeSq && distSq < closestDistSq) {
          closestDistSq = distSq;
          closestEntity = entry.entity;
        }
      }
    }

    this.lastTaggedCandidateCount = taggedCount;
    return closestEntity;
  }

  /**
   * The actor's normalized XZ facing when view gating is on, or null when it
   * is off or unreadable (no facing, stacked vectors) — null reads as
   * unobstructed, never as blind. Fills and returns a shared scratch object:
   * this runs inside per-frame target resolution, so it must not allocate.
   * Consumed synchronously by the caller; never held across frames.
   */
  private readonly viewScratch = {x: 1, z: 0, cosHalf: -1};
  /** Cached exclusion set for resolveTarget(): cleared and refilled per call, never held. */
  private readonly excludedScratch = new Set<Entity>();
  private viewFacing(): {x: number; z: number; cosHalf: number} | null {
    if (this.viewAngleDeg <= 0 || this.viewAngleDeg >= 360 || !this.actorTransform) {
      return null;
    }
    const forward = this.actorTransform.worldForward;
    if (!forward) {
      return null;
    }
    const lenSq = forward.x * forward.x + forward.z * forward.z;
    if (lenSq < 1e-8) {
      return null;
    }
    const len = Math.sqrt(lenSq);
    this.viewScratch.x = forward.x / len;
    this.viewScratch.z = forward.z / len;
    this.viewScratch.cosHalf = Math.cos((this.viewAngleDeg * Math.PI) / 360);
    return this.viewScratch;
  }

  /**
   * Emits one-shot diagnostics that make tag targeting observable in ASCP/anvil
   * traces (the authoring build-verify loop cannot see runtime resolution):
   *  - `[TargetTaggedEntity] acquired` the first frame a target resolves;
   *  - `[TargetTaggedEntity] no producer` once, if `targetTags` are configured but
   *    the blackboard yields zero tagged entities for `noProducerGraceSeconds`
   *    (the producer `ActorSdkTagComponent` never registered at runtime — see the
   *    Tag Targeting Contract). A non-zero candidate count merely out of range is a
   *    distance problem, not a tagging one, and is intentionally left silent.
   * Both logs are latched so each fires at most once per behavior instance. The
   * warning is additionally suppressed once a target has ever resolved: pickup,
   * delivery, and kills legitimately drain the tag to zero, and reporting that as
   * missing producer wiring would be a false positive in the common terminal state.
   */
  protected updateTagObservability(deltaTime: number, currentTarget: Entity | null): void {
    if (this.forcedTargetOverride || this.targetTags.length === 0) {
      return;
    }

    if (currentTarget) {
      if (!this.hasLoggedAcquire) {
        this.hasLoggedAcquire = true;
        console.log(
          `[TargetTaggedEntity] acquired target for targetTags=[${this.targetTags.join(', ')}]`,
        );
      }
      this.noProducerElapsed = 0;
      return;
    }

    // A prior acquisition proves the producer was wired, so a later drop to zero
    // is consumption or destruction, not the missing-tag failure this warns about.
    if (
      this.hasLoggedAcquire ||
      this.lastTaggedCandidateCount > 0 ||
      this.hasWarnedNoProducer
    ) {
      return;
    }

    this.noProducerElapsed += deltaTime;
    if (this.noProducerElapsed >= this.noProducerGraceSeconds) {
      this.hasWarnedNoProducer = true;
      console.warn(
        `[TargetTaggedEntity] no producer: targetTags=[${this.targetTags.join(', ')}] ` +
          `resolved 0 tagged entities after ${this.noProducerGraceSeconds}s — the target is ` +
          `missing an ActorSdkTagComponent with a matching tag (Tag Targeting Contract).`,
      );
    }
  }

  // ── Smoothing & Prediction ──────────────────────────────────────────

  protected smoothTargetPosition(reportedPos: Vec3, deltaTime: number): Vec3 {
    if (this.smoothedTargetPos === null) {
      this.smoothedTargetPos = reportedPos;
      return this.smoothedTargetPos;
    }

    const f = 1 - Math.exp(-deltaTime / this.positionSmoothingTimeConstant);

    this.smoothedTargetPos = new Vec3(
      this.smoothedTargetPos.x + (reportedPos.x - this.smoothedTargetPos.x) * f,
      this.smoothedTargetPos.y + (reportedPos.y - this.smoothedTargetPos.y) * f,
      this.smoothedTargetPos.z + (reportedPos.z - this.smoothedTargetPos.z) * f,
    );

    return this.smoothedTargetPos;
  }

  protected updateTargetVelocity(smoothedPos: Vec3, deltaTime: number): void {
    if (this.previousSmoothedTargetPos === null || deltaTime <= 0) {
      this.previousSmoothedTargetPos = smoothedPos;
      this.rawVelocity = new Vec3(0, 0, 0);
      this.internalSmoothedVelocity = new Vec3(0, 0, 0);
      return;
    }

    const displacement = smoothedPos.sub(this.previousSmoothedTargetPos);
    this.rawVelocity = displacement.mul(1 / deltaTime);

    const f = 1 - Math.exp(-deltaTime / this.velocitySmoothingTimeConstant);
    this.internalSmoothedVelocity = new Vec3(
      this.internalSmoothedVelocity.x + (this.rawVelocity.x - this.internalSmoothedVelocity.x) * f,
      this.internalSmoothedVelocity.y + (this.rawVelocity.y - this.internalSmoothedVelocity.y) * f,
      this.internalSmoothedVelocity.z + (this.rawVelocity.z - this.internalSmoothedVelocity.z) * f,
    );

    this.previousSmoothedTargetPos = smoothedPos;
  }

  protected computePredictedPosition(smoothedPos: Vec3): Vec3 {
    if (this.velocityPredictionTime <= 0) {
      return smoothedPos;
    }

    const offset = this.internalSmoothedVelocity.mul(this.velocityPredictionTime);
    return smoothedPos.add(offset);
  }

  protected resetSmoothing(): void {
    this.smoothedTargetPos = null;
    this.previousSmoothedTargetPos = null;
    this.rawVelocity = new Vec3(0, 0, 0);
    this.internalSmoothedVelocity = new Vec3(0, 0, 0);
  }
}

/**
 * Whether the entity's health reports death, resolved with `findCharacterGAS`
 * as the attack controller resolves its target's. An entity with no health is
 * never dead.
 */
export function isDead(entity: Entity): boolean {
  return findCharacterGAS(entity)?.isDead ?? false;
}

/** Whether the XZ offset (dx, dz) falls inside the view cone `facing`. Stacked points count as seen. */
function inViewCone(dx: number, dz: number, facing: {x: number; z: number; cosHalf: number}): boolean {
  const distSq = dx * dx + dz * dz;
  if (distSq < 1e-8) {
    return true;
  }
  return (dx * facing.x + dz * facing.z) / Math.sqrt(distSq) >= facing.cosHalf;
}
