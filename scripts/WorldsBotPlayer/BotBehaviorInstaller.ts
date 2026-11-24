/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v8

// Bot Player Scripts v2

/**
 * BotBehaviorInstaller — builds a managed bot's brains from starter-registry
 * ids. "follow" makes a bot follow the closest player, gated by a periodic
 * line-of-sight raycast (when LOS is blocked the bot idles in place; when
 * LOS is clear it resumes following). "shooter-combat" turns a bot holding
 * a gun into a solo-shooter opponent through ShooterCombatBehavior, which
 * runs its own sight, cover, retreat and search and needs no LOS gate here.
 * "wander" makes a bot roam on its own through IdleWanderBehavior: pause,
 * stroll to a random nearby point, pause again. Composed as "follow, wander"
 * the bot follows real players and roams whenever there is none to follow.
 * Wander stays parked while any other brain drives (follow with a target, an
 * engaged shooter); once they all let go (no target, LOS blocked, fight over)
 * the bot pauses where it stands, then roams around that spot rather than its
 * spawn point.
 *
 * brainId takes one id or several comma-separated ("follow, shooter-combat"):
 * every listed brain is attached to the same actor and the framework
 * arbitrates shared controllers per frame, so an engaged shooter takes
 * movement while idle brains yield. Priorities come from the brains' starter
 * roles with behaviorPriority shifting the whole bot as one knob.
 *
 * Spawn: WorldsBotFillService spawns this template as a LocalOnly child
 *   under each managed bot. It may also sit on a child entity of a
 *   scene-placed actor. Either way the actor root is resolved by walking
 *   ancestors to find ActorSdkLogicComponent — no per-bot references.
 * Authority: server (fill-spawned installers are server-owned).
 *
 * Uses the Actor Framework's FollowBehavior with followPlayer=true so the
 * actor auto-discovers the closest human player via PlayerService and
 * navigates to them via NavMesh pathfinding.
 */

import {
  component,
  editor,
  property,
  subscribe,
  subscribePropertyChange,
  ActorSdkLogicComponent,
  ActorMovementControllerTypeId,
  ExecuteOn,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  PhysicsService,
  CastMode,
  CollisionLayerMask,
  TransformComponent,
  Vec3,
} from 'meta/worlds';
import type {
  ActorBehavior,
  ActorMovementController,
  Entity,
  Maybe,
  OnWorldUpdateEventPayload,
  RayCastInput,
} from 'meta/worlds';
import { BehaviorStarterComponent, StarterPriority } from '../Actor/Behaviors/Starters/BehaviorStarterComponent';
import type { RemovalTrackedBehavior } from '../Actor/Behaviors/Starters/BehaviorStarterComponent';
import { FollowBehavior } from '../Actor/Behaviors/BaseBehaviors/FollowBehavior';
import { ShooterCombatBehavior } from '../Actor/Behaviors/CompositeBehaviors/ShooterCombatBehavior';
import { IdleWanderBehavior } from '../Actor/Behaviors/BaseBehaviors/IdleWanderBehavior';

import { WorldsBotFillService } from './WorldsBotFillService';

/** Eye-height offset added to both bot and player positions so the ray
 *  casts at chest/head level instead of at the feet (avoids false LOS
 *  blocks from ground geometry). */
const EYE_HEIGHT_OFFSET = 1.0;

// The brains this installer can build, by starter-registry id. Anything else
// is skipped with a warning; an id list with nothing known falls back to
// 'follow'. Several ids compose (see brainId): add a new brain only when no
// single brain or combination covers the request.
type BotBrainKind = 'follow' | 'shooter-combat' | 'wander';

// Priority each brain claims above the Social baseline, added to
// behaviorPriority so the one knob still lifts the whole bot. Follow keeps
// behaviorPriority exactly; combat brains claim higher, so an engaged shooter
// takes movement from follow while idle brains yield with -1. Wander claims
// lower, so it only drives a bot nothing else is steering. A Map (not an
// object literal) because brain ids are kebab-case.
const BRAIN_ROLE_OFFSET: ReadonlyMap<BotBrainKind, number> = new Map([
  ['follow', 0],
  ['shooter-combat', StarterPriority.Combat - StarterPriority.Social],
  ['wander', StarterPriority.Ambient - StarterPriority.Social],
]);

// Lowest priority each brain claims: its rank among the role offsets. The
// behavior manager drops claims below 0 and breaks a tie by registration
// (brainId) order, so distinct floors keep the role order however low
// behaviorPriority goes.
const BRAIN_PRIORITY_FLOOR: ReadonlyMap<BotBrainKind, number> = new Map(
  [...BRAIN_ROLE_OFFSET].map(([brain, offset]): [BotBrainKind, number] => [
    brain,
    [...BRAIN_ROLE_OFFSET.values()].filter((other) => other < offset).length,
  ]),
);

@component()
export class BotBehaviorInstaller extends BehaviorStarterComponent {
  /**
   * Which brains this installer builds, by starter-registry id: "follow",
   * "shooter-combat", "wander", or several comma-separated
   * ("follow, shooter-combat", "follow, wander").
   * Read when the behavior starts; edits apply on restart.
   * A shooter bot needs a gun: the behavior maneuvers
   * without one but never fires, warning once. Unknown ids are skipped with
   * a warning; a list with nothing known falls back to follow. The resolved
   * brains are recorded in activeBrains.
   */
  @property()
  @editor({ description: 'Brain ids from starterRegistry.json, comma-separated: "follow", "shooter-combat", "wander". Read when the behavior starts; edits apply on restart.' })
  brainId: string = 'follow';

  /** Movement speed of the bot when following. */
  @property()
  followSpeed: number = 4.0;

  /** Distance from the target at which the bot stops. */
  @property()
  followRange: number = 2.0;

  /** Base priority for the whole bot: each brain adds its starter-role offset, so the bot lifts as one knob. */
  @property()
  behaviorPriority: number = 10;

  /** Walk speed (m/s) of the wander brain; 0 or less (an installer saved without it loads 0) means IdleWanderBehavior's default. Read when the behavior starts; edits apply on restart. */
  @property()
  wanderSpeed: number = 2.0;

  /** How far (m) the wander brain roams from where it took over the bot; 0 or less (an installer saved without it loads 0) means IdleWanderBehavior's default, and values below 2 m are raised to 2 m. Read when the behavior starts; edits apply on restart. */
  @property()
  wanderLeashRadius: number = 20.0;

  /** How often (seconds) the NavMesh path is recalculated. */
  @property()
  repathInterval: number = 0.2;

  /** How often (seconds) to re-query for the closest player. */
  @property()
  playerSearchInterval: number = 1.0;

  /** Soft-zone radius for hysteresis to avoid stop-go jitter. */
  @property()
  hysteresisRadius: number = 1.5;

  /** How often (seconds) to perform the line-of-sight raycast. */
  @property()
  losCheckInterval: number = 0.3;

  /** Maximum distance at which LOS is considered (beyond this the bot idles). */
  @property()
  losMaxDistance: number = 50.0;

  /** Gate for LOS-path console logging. Off by default: the raycast fires
   *  every losCheckInterval per bot, so unconditional logging is log spam. */
  @property()
  debugLogEnabled: boolean = false;

  /** Tags the shooter brain hunts; the closest living tagged entity is the target. */
  @property()
  shooterTargetTags: string = 'player';

  /** Farthest distance (m) the shooter brain spots its target. */
  @property({ minValue: 5, maxValue: 100 })
  @editor({ label: 'Shooter sight range', description: 'Farthest distance (m) at which the bot spots its target.' })
  shooterSightRange: number = 30;

  /** Farthest distance (m) the shooter brain fires from. */
  @property({ minValue: 1, maxValue: 100 })
  @editor({ label: 'Shooter max firing distance', description: 'Farthest distance (m) the bot shoots from.' })
  shooterFireRange: number = 25;

  /** Seconds the target must stay visible before the bot's first shot. */
  @property({ minValue: 0.05, maxValue: 2 })
  @editor({ label: 'Shooter reaction time', description: 'Seconds the target must stay in view before the first shot. Lower is deadlier.' })
  shooterReactionTime: number = 0.4;

  // ---- internal state (local to the server) ----
  // One running behavior per resolved brain, in brainId order. The framework
  // arbitrates shared controllers per frame, so composition needs no
  // coordination here beyond per-brain handles for the LOS gate (follow),
  // parking the wander brain, and live tuning pushes (shooter). Brains track
  // their own removal (RemovalTrackedBehavior), so an externally detached
  // brain reads as gone and rebuilds on next start.
  private activeBrains: BotBrainKind[] = [];
  private brainBehaviors = new Map<BotBrainKind, ActorBehavior & RemovalTrackedBehavior>();
  private losTimer: number = 0;
  private losRayPending: boolean = false;
  private hasLineOfSight: boolean = true; // optimistic start

  // Cached raycast objects for the last-fired endpoints. Vec3 is immutable
  // in the SDK, so unchanged endpoints reuse these with zero allocation;
  // changed endpoints build fresh ones in getOrUpdateRaycastInput.
  private rayScratch: {
    input: RayCastInput;
    ox: number;
    oy: number;
    oz: number;
    dx: number;
    dy: number;
    dz: number;
    dist: number;
  } | null = null;


  /**
   * Resolved actor root entity. When this component lives on a child entity
   * (not the actor root), we walk ancestors to find the entity that carries
   * ActorSdkLogicComponent and cache it here. Used for transform lookups and
   * entity-set collection so the LOS raycast references the full bot hierarchy.
   */
  private actorEntity: Maybe<Entity> = null;

  // Sets of entities that belong to the bot and the current target player,
  // used to filter out self/target hits from the LOS raycast. The
  // excludeEntities field on RayCastInput only supports up to 4 entries,
  // which is not enough when both bot and player have deep child hierarchies
  // with colliders. Instead we use UnsortedHits and filter every hit.
  private botEntitySet: Set<Entity> = new Set();
  private targetEntitySet: Set<Entity> = new Set();
  private lastExcludedTarget: Maybe<Entity> = null;

  /**
   * Resolve the actor root by walking ancestors. The parent class's onStart()
   * checks this.entity for ActorSdkLogicComponent; on a child entity that
   * returns null, so controlledActor stays unset and startBehavior() is never
   * called. We resolve it ourselves here.
   */
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  private onChildStart(): void {
    this.resolveActorFromAncestors();
  }

  /**
   * Mirror the parent's OnOwnershipTransferEvent handler. Only takes effect
   * before the behavior starts: afterwards the entity references are still
   * valid, so resolveActorFromAncestors exits early on brainBehaviors and
   * nothing is re-seeded. Relevant when a transfer races start.
   */
  @subscribe(OnOwnershipTransferEvent, { execution: ExecuteOn.Owner })
  private onChildOwnershipGained(): void {
    this.resolveActorFromAncestors();
  }

  /**
   * Walk this.entity.getAncestors() to find the first entity with
   * ActorSdkLogicComponent, then start the behavior unless autoStart is off.
   * Resolution runs even when off, mirroring the parent: a starter left off
   * stays drivable by another component.
   */
  private resolveActorFromAncestors(): void {
    // Guard: if any brain is still attached, skip to avoid double-start on
    // ownership transfer where both inherited and child handlers fire. Map
    // entries pointing at externally removed brains read as absent, so
    // startBehavior() below drops and rebuilds them instead of going quiet.
    if ([...this.brainBehaviors.values()].some((brain) => !brain.isRemoved)) {
      return;
    }

    // If controlledActor was already set (e.g. via scene property), use it.
    if (this.controlledActor) {
      this.actorEntity = this.controlledActor;
    } else if (this.entity.getComponent(ActorSdkLogicComponent)) {
      // Component IS on the actor root.
      this.controlledActor = this.entity;
      this.actorEntity = this.entity;
    } else {
      // Walk ancestors to find the actor root
      const ancestors = this.entity.getAncestors();
      for (const ancestor of ancestors) {
        if (ancestor.getComponent(ActorSdkLogicComponent)) {
          this.controlledActor = ancestor;
          this.actorEntity = ancestor;
          this.log('Resolved actor root from ancestor hierarchy.');
          break;
        }
      }
      if (!this.controlledActor) {
        this.log('Could not resolve actor root from ancestors.');
        return;
      }
    }

    if (!this.autoStart) {
      return;
    }
    this.startBehavior();
  }

  override startBehavior(): ActorBehavior | void {
    // Builds only brains missing from the map: the inherited onStart and
    // onChildStart both subscribe to OnEntityStartEvent with no guaranteed
    // order, so either may run first, and a second call must neither attach
    // duplicates nor rebuild brains a push dropped after removal (those build
    // fresh here). A brain removed externally without a tuning push reads as
    // missing, so it rebuilds instead of skipping a dead map entry.
    if (!this.controlledActor) {
      this.log('No controlled actor found, aborting.');
      return;
    }

    const logic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!logic) {
      this.log('ActorSdkLogicComponent not found on controlled actor.');
      return;
    }

    const brains = this.parsedBrainIds();
    for (const brain of brains) {
      const existing = this.brainBehaviors.get(brain);
      if (existing && existing.isRemoved) {
        // Detached externally without a tuning push: drop the dead entry so
        // a fresh brain builds below instead of skipping it.
        this.brainBehaviors.delete(brain);
      } else if (existing) {
        continue;
      }
      switch (brain) {
        case 'follow':
          this.startFollowBehavior(logic);
          break;
        case 'shooter-combat':
          this.startShooterCombatBehavior(logic);
          break;
        case 'wander':
          this.startWanderBehavior(logic);
          break;
      }
    }
    this.activeBrains = brains;
    return this.primaryBehavior();
  }

  /** First listed brain, which startBehavior returns. */
  private primaryBehavior(): ActorBehavior | undefined {
    return this.brainBehaviors.get(this.activeBrains[0]);
  }

  /**
   * brainId as an order-preserved, de-duplicated brain list. Unknown ids are
   * skipped with a warning each; a list with nothing known warns and falls
   * back to follow (normalizing the field), so a bot always runs something.
   */
  private parsedBrainIds(): BotBrainKind[] {
    const ids = this.brainId
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const brains: BotBrainKind[] = [];
    for (const id of ids) {
      if (id !== 'follow' && id !== 'shooter-combat' && id !== 'wander') {
        console.warn(`BotBehaviorInstaller: unknown brainId "${id}", skipping.`);
        continue;
      }
      if (!brains.includes(id)) {
        brains.push(id);
      }
    }
    if (brains.length > 0) {
      return brains;
    }
    console.warn(
      `BotBehaviorInstaller: no known brains in "${this.brainId}", falling back to follow.`
    );
    this.brainId = 'follow';
    return ['follow'];
  }

  /**
   * behaviorPriority shifted by the brain's starter-role offset, never below
   * the brain's floor (BRAIN_PRIORITY_FLOOR). The behavior manager drops every
   * claim below 0, so an unfloored Ambient offset (-20) under the default
   * behaviorPriority (10) leaves a wander brain that never moves the bot.
   */
  private brainPriority(brain: BotBrainKind): number {
    return Math.max(
      BRAIN_PRIORITY_FLOOR.get(brain) ?? 0,
      this.behaviorPriority + (BRAIN_ROLE_OFFSET.get(brain) ?? 0),
    );
  }

  private startFollowBehavior(logic: ActorSdkLogicComponent): ActorBehavior {
    this.log('Starting follow behavior on bot.');

    const follow = new FollowBehavior();
    follow.followPlayer = true;
    follow.followSpeed = this.followSpeed;
    follow.followRange = this.followRange;
    follow.basePriority = this.brainPriority('follow');
    follow.repathInterval = this.repathInterval;
    follow.playerSearchInterval = this.playerSearchInterval;
    follow.hysteresisRadius = this.hysteresisRadius;
    follow.bodyDirectionMode = 'faceMovement';
    // Filter out managed bot-fill players so bots only follow real humans,
    // preventing clumping where bots follow each other.
    follow.playerFilter = (entity: Entity) =>
      !WorldsBotFillService.get().isManagedBot(entity);

    logic.addBehavior(follow, this.removeDuplicates);
    this.brainBehaviors.set('follow', follow);

    // Cache all entities in the bot's hierarchy (root + descendants) so the
    // LOS raycast can ignore hits on child colliders (e.g. KinematicCharacter).
    // Use actorEntity (the resolved actor root) so the full hierarchy is captured,
    // even when this component lives on a child entity. Refreshed on every
    // raycast fire as well, so late-attached colliders never read as geometry.
    const rootForCollection = this.actorEntity ?? this.entity;
    this.botEntitySet = this.collectEntitySet(rootForCollection);
    this.log(`Cached ${this.botEntitySet.size} bot entities for LOS filtering.`);
    this.log('FollowBehavior added successfully.');

    return follow;
  }

  private startShooterCombatBehavior(logic: ActorSdkLogicComponent): ActorBehavior {
    this.log('Starting shooter-combat behavior on bot.');

    const shooter = new ShooterCombatBehavior();
    shooter.basePriority = this.brainPriority('shooter-combat');
    this.applyShooterTargetTags(shooter);
    shooter.sightRange = this.shooterSightRange;
    shooter.fireRange = this.clampedShooterFireRange(this.shooterSightRange);
    shooter.reactionTime = this.shooterReactionTime;
    // The installer offers only the fixed delay: zero bounds keep the
    // behavior's legacy fallback instead of rolling the 0.1/0.5 defaults.
    shooter.reactionTimeMin = 0;
    shooter.reactionTimeMax = 0;
    // Same for perception: installer bots keep all-direction awareness
    // instead of silently taking the new 120 cone.
    shooter.fieldOfViewDeg = 0;

    logic.addBehavior(shooter, this.removeDuplicates);
    this.brainBehaviors.set('shooter-combat', shooter);
    this.log('ShooterCombatBehavior added successfully.');

    return shooter;
  }

  private startWanderBehavior(logic: ActorSdkLogicComponent): ActorBehavior {
    this.log('Starting wander behavior on bot.');

    // Set before addBehavior: initialize() copies basePriority into the
    // nested goto that claims movement. A fresh behavior still holds its own
    // defaults, which stand in for unset tunables.
    const wander = new IdleWanderBehavior();
    wander.basePriority = this.brainPriority('wander');
    wander.wanderSpeed = BehaviorStarterComponent.positiveOr(this.wanderSpeed, wander.wanderSpeed);
    // A leash inside the arrival tolerance clamps every walk onto a point
    // already reached, so it is floored as StarterWanderComponent floors it.
    wander.leashRadius = Math.max(
      BehaviorStarterComponent.positiveOr(this.wanderLeashRadius, wander.leashRadius),
      wander.arrivalDistance * 2,
    );

    logic.addBehavior(wander, this.removeDuplicates);
    this.brainBehaviors.set('wander', wander);
    this.log('IdleWanderBehavior added successfully.');

    return wander;
  }

  // The labelled shooter tunables above surface as live controls (MHS
  // property panel now, GenStudio Behaviors tab later), and the behavior
  // reads them every frame — so a runtime edit pushes through instead of
  // waiting for a restart. Each shooter handler re-applies all four: one
  // edit path, no ordering dependence. brainId is identity, not tuning: its
  // handler warns that a switch needs a restart.
  @subscribePropertyChange('shooterSightRange')
  private onShooterSightRangeChanged(): void {
    this.pushShooterSettings();
  }

  @subscribePropertyChange('shooterFireRange')
  private onShooterFireRangeChanged(): void {
    this.pushShooterSettings();
  }

  @subscribePropertyChange('shooterReactionTime')
  private onShooterReactionTimeChanged(): void {
    this.pushShooterSettings();
  }

  @subscribePropertyChange('shooterTargetTags')
  private onShooterTargetTagsChanged(): void {
    this.pushShooterSettings();
  }

  @subscribePropertyChange('brainId')
  private onBrainIdChanged(): void {
    if (this.brainBehaviors.size === 0) {
      // Silent during start: the unknown-id fallback normalizes brainId
      // before any brain runs, so no restart is pending.
      return;
    }
    // Brain identity is read at start: a live switch would orphan LOS state
    // and controller claims, so say so instead of silently doing nothing.
    console.warn(
      `BotBehaviorInstaller: brainId "${this.brainId}" takes effect on restart; the current brain keeps running.`,
    );
  }

  /** Forwards the labelled shooter tunables to the running brain, if alive. */
  private pushShooterSettings(): void {
    const shooter = this.brainBehaviors.get('shooter-combat');
    if (!(shooter instanceof ShooterCombatBehavior)) {
      return;
    }
    if (shooter.isRemoved) {
      // Drop the dead reference so a later startBehavior() builds a fresh
      // brain instead of skipping a map entry that points at a removed one.
      this.brainBehaviors.delete('shooter-combat');
      return;
    }
    const sightRange = this.shooterSightRange;
    shooter.sightRange = sightRange;
    shooter.fireRange = this.clampedShooterFireRange(sightRange);
    shooter.reactionTime = this.shooterReactionTime;
    // Fixed delay only here too: a live edit must not silently switch the
    // running brain to a rolled delay.
    shooter.reactionTimeMin = 0;
    shooter.reactionTimeMax = 0;
    // Nor to the cone: the installer has no FOV knob, so the legacy
    // all-direction awareness stays in force here as well.
    shooter.fieldOfViewDeg = 0;
    this.applyShooterTargetTags(shooter);
  }

  /**
   * One tag path for start and live edit: parsed tags win, an emptied field
   * falls back to the behavior default (matching ShooterCombatBehavior and
   * StarterShooterCombatComponent), and a configured-but-blank field warns.
   */
  private applyShooterTargetTags(shooter: ShooterCombatBehavior): void {
    const tags = this.parsedShooterTargetTags();
    if (tags.length > 0) {
      shooter.targetTags = tags;
      return;
    }
    shooter.targetTags = ['player'];
    if (this.shooterTargetTags.trim().length > 0) {
      console.warn(
        `BotBehaviorInstaller: shooterTargetTags "${this.shooterTargetTags}" parsed to no tags; using ShooterCombatBehavior default targets.`,
      );
    }
  }

  /**
   * Firing distance capped at what the bot can see, mirroring
   * StarterShooterCombatComponent: past sight range the bot would maneuver
   * without ever firing.
   */
  private clampedShooterFireRange(sightRange: number): number {
    const authoredFire = this.shooterFireRange;
    if (authoredFire > sightRange) {
      console.warn(
        `BotBehaviorInstaller: max firing distance ${authoredFire} m is past ` +
          `the sight range ${sightRange} m; capping it at ${sightRange} m.`,
      );
    }
    return Math.min(authoredFire, sightRange);
  }

  /** Installer-owned tag list, parsed the same way at start and on live edit. */
  private parsedShooterTargetTags(): string[] {
    return this.shooterTargetTags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  // Runs on the server (this entity is server-owned) every frame.
  // Accumulates a timer and fires a LOS raycast at the configured interval.
  // Allocation-free by design: endpoint math below is scalar-only, raycast
  // objects come from the scalar-cached getOrUpdateRaycastInput helper, and
  // logging goes through the debug-gated log() helper.
  @subscribe(OnWorldUpdateEvent, { execution: ExecuteOn.Owner })
  private onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.updateWanderSuspension()) {
      this.haltMovement();
    }

    // The LOS gate serves the follow brain only: the shooter brain runs its
    // own sight, cover, retreat and search, and must never be detached here.
    // Keyed off the running behavior, never the brainId string: brainId is
    // read at start and live edits only warn, so a keyed string can disagree
    // with what is actually running and silently drop the gate.
    const follow = this.brainBehaviors.get('follow');
    if (!(follow instanceof FollowBehavior)) {
      return;
    }

    this.losTimer += payload.deltaTime;
    if (this.losTimer < this.losCheckInterval) {
      return;
    }

    // Avoid overlapping async raycasts. The timer is deliberately NOT reset
    // here: no new check was issued, so the next frame retries immediately
    // instead of skipping a full interval.
    if (this.losRayPending) {
      return;
    }

    // The FollowBehavior resolves its own targetEntity when followPlayer=true.
    // Read it here so we stay in sync with whatever player it is tracking.
    // Fall back to the last known target: once LOS is lost the behavior is
    // detached and may stop refreshing targetEntity, and with no target the
    // bot could never observe LOS clearing again.
    const target: Maybe<Entity> =
      follow.targetEntity ?? this.lastExcludedTarget;
    if (!target) {
      return;
    }

    // Rebuild target entity set when the tracked player changes
    if (target !== this.lastExcludedTarget) {
      this.targetEntitySet = this.collectEntitySet(target);
      this.lastExcludedTarget = target;
      this.log(`Cached ${this.targetEntitySet.size} target entities for LOS filtering.`);
    }

    // Use the actor root entity for the bot's world position, not this.entity
    // (which may be a child entity with an identity transform).
    const botRoot = this.actorEntity ?? this.entity;
    // Rebuilt on every fire: colliders attached to the bot hierarchy after
    // start (weapons, effects) must not read as world geometry.
    this.botEntitySet = this.collectEntitySet(botRoot);
    const botTransform = botRoot.getComponent(TransformComponent);
    const targetTransform = target.getComponent(TransformComponent);
    if (!botTransform || !targetTransform) {
      return;
    }

    // Scalar math only — no allocation. The eye-height offset cancels out of
    // the delta, so dy is the plain position difference.
    const botPos = botTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const dx = targetPos.x - botPos.x;
    const dy = targetPos.y - botPos.y;
    const dz = targetPos.z - botPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Beyond max distance → treat as no LOS. A decision was produced, so the
    // interval restarts here.
    if (dist < 0.01 || dist > this.losMaxDistance) {
      this.losTimer = 0;
      this.setLineOfSight(dist < 0.01); // on top of each other = LOS clear
      return;
    }

    // Cached raycast objects, rebuilt only when the endpoints move (Vec3 is
    // immutable in the SDK, so changed scalars need fresh instances while
    // stationary endpoints reuse the previous fire's objects).
    const rayInput = this.getOrUpdateRaycastInput(botPos, targetPos, dist);
    this.losTimer = 0;
    this.losRayPending = true;
    PhysicsService.get()
      .rayCast(rayInput)
      .then((result) => {
        this.losRayPending = false;

        if (!result.hasHitSomething) {
          // Nothing between bot and player — LOS is clear.
          this.setLineOfSight(true);
          return;
        }

        // Iterate over ALL hits. Any hit that does NOT belong to the bot or
        // player hierarchy is world geometry → LOS blocked.
        const hits = result.hits;
        if (hits && hits.length > 0) {
          let worldGeometryHit = false;
          for (const hit of hits) {
            const hitEntity = hit.actorEntity ?? hit.shapeEntity;
            if (hitEntity && (this.botEntitySet.has(hitEntity) || this.targetEntitySet.has(hitEntity))) {
              continue; // skip self / target colliders
            }
            // Check if the hit entity (or any ancestor) belongs to another
            // managed bot player — their colliders should not block LOS.
            if (hitEntity && this.isEntityManagedBot(hitEntity)) {
              continue; // skip other managed bots' colliders
            }
            // This hit is real world geometry — LOS is blocked.
            worldGeometryHit = true;
            this.log(`World geometry hit at distance ${hit.distance.toFixed(2)}`);
            break;
          }
          this.setLineOfSight(!worldGeometryHit);
          return;
        }

        // hasHitSomething was true but hits array was empty/null — treat as clear.
        this.setLineOfSight(true);
      })
      .catch(() => {
        this.losRayPending = false;
        // On error, keep last known state — do not flicker.
      });
  }

  /**
   * Raycast input for the current endpoints, reusing the previous fire's
   * objects when nothing moved. A stationary bot watching a stationary
   * player therefore fires with zero allocation.
   */
  private getOrUpdateRaycastInput(
    botPos: Vec3,
    targetPos: Vec3,
    dist: number,
  ): RayCastInput {
    const ox = botPos.x;
    const oy = botPos.y + EYE_HEIGHT_OFFSET;
    const oz = botPos.z;
    const inv = 1 / dist;
    const dx = (targetPos.x - botPos.x) * inv;
    const dy = (targetPos.y - botPos.y) * inv;
    const dz = (targetPos.z - botPos.z) * inv;
    const s = this.rayScratch;
    if (
      s != null &&
      s.ox === ox &&
      s.oy === oy &&
      s.oz === oz &&
      s.dx === dx &&
      s.dy === dy &&
      s.dz === dz &&
      s.dist === dist
    ) {
      return s.input;
    }
    // Use UnsortedHits so we receive ALL hits along the ray, not just the
    // closest one.  ClosestHit only returned 1 hit — typically the bot's own
    // collider — so world geometry behind it was invisible and LOS was always
    // reported as clear.
    const input: RayCastInput = {
      origin: new Vec3(ox, oy, oz),
      dir: new Vec3(dx, dy, dz),
      distance: dist,
      mode: CastMode.UnsortedHits,
      collisionLayerMask: CollisionLayerMask.AllLayers,
      includeTriggers: false,
      maxUnsortedHits: 10,
    };
    this.rayScratch = {input, ox, oy, oz, dx, dy, dz, dist};
    return input;
  }

  /** Debug-gated logging: the LOS path fires per bot per interval, so even
   *  transition-only logs stay behind this flag. */
  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log('[BotBehaviorInstaller]', ...args);
    }
  }

  /**
   * Gates movement on LOS — removes the FollowBehavior when LOS is lost
   * so the bot idles in place, and re-adds it when LOS is regained.
   * The LOS raycast already filters out other managed bots' colliders
   * so one bot standing between another and the player does not
   * permanently block LOS.
   */
  private setLineOfSight(canSee: boolean): void {
    if (canSee === this.hasLineOfSight) {
      return; // no change
    }
    this.hasLineOfSight = canSee;

    const follow = this.brainBehaviors.get('follow');
    if (!follow || !this.controlledActor) {
      return;
    }
    const logic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!logic) {
      return;
    }

    if (canSee) {
      this.log('LOS clear — resuming follow behavior.');
      logic.addBehavior(follow, this.removeDuplicates);
      // Detaching ran its onRemove(); it is attached again.
      follow.isRemoved = false;
      if (this.updateWanderSuspension()) {
        this.haltMovement();
      }
    } else {
      this.log('LOS blocked — stopping follow behavior.');
      logic.removeBehavior(follow);
      this.updateWanderSuspension();
      // Composition: halt the controllers only when no other brain claims
      // movement. Halting under one that does (an engaged shooter) would cut
      // off its cover and retreat; not halting under an idle one would leave
      // the bot walking follow's last path. Covers a wander that just resumed.
      if (!this.anotherBrainDrives(follow)) {
        this.haltMovement();
      }
    }
  }

  /**
   * Stops any in-flight movement on the actor's movement controllers, so the
   * bot halts immediately instead of continuing toward the last waypoint the
   * brain that let go of it gave.
   */
  private haltMovement(): void {
    const logic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!logic) {
      return;
    }
    const moveControllers = logic.getControllers<ActorMovementController>(ActorMovementControllerTypeId);
    for (const mc of moveControllers) {
      mc.stopMovement();
    }
    this.log(`Called stopMovement() on ${moveControllers.length} movement controller(s).`);
  }

  /**
   * Parks the wander brain while any other brain drives movement and resumes
   * it once none does. Parked, wander cannot turn a bot that follow has
   * settled beside its player, or pathfind beneath a fight; resumed, it
   * roams around where the other brain left the bot rather than finishing an
   * old walk or heading back toward spawn. Returns true when wander has just
   * resumed, that is when the last other brain let go of movement, so the
   * caller can halt the bot for wander's opening pause. Runs every frame;
   * allocates only when wander resumes.
   */
  private updateWanderSuspension(): boolean {
    const wander = this.brainBehaviors.get('wander');
    if (!(wander instanceof IdleWanderBehavior) || wander.isRemoved) {
      return false;
    }
    const anotherDrives = this.anotherBrainDrives(wander);
    const resumed = wander.isSuspended && !anotherDrives;
    wander.setSuspended(anotherDrives);
    return resumed;
  }

  /**
   * Whether a brain other than `except` claims movement right now. A brain
   * counts only while attached: not removed (the LOS gate's re-add clears
   * follow's flag) and, for follow, not detached by the LOS gate, since a
   * detached follow keeps its target and still bids.
   */
  private anotherBrainDrives(except: ActorBehavior): boolean {
    for (let i = 0; i < this.activeBrains.length; i++) {
      const brain = this.activeBrains[i];
      const behavior = this.brainBehaviors.get(brain);
      if (behavior == null || behavior === except) {
        continue;
      }
      const attached = !behavior.isRemoved && (brain !== 'follow' || this.hasLineOfSight);
      if (attached && behavior.getControllerUsePriority(ActorMovementControllerTypeId) >= 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the given entity (or any of its ancestors) is a managed
   * bot player. WorldsBotFillService.isManagedBot() only recognizes the
   * top-level bot player entity, so we walk up the hierarchy to catch child
   * collider entities (e.g. KinematicCharacter) that belong to another bot.
   */
  private isEntityManagedBot(entity: Entity): boolean {
    const botFill = WorldsBotFillService.get();
    if (botFill.isManagedBot(entity)) {
      return true;
    }
    for (const ancestor of entity.getAncestors()) {
      if (botFill.isManagedBot(ancestor)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Collect the given entity and all its descendants into a Set for
   * fast membership checks during raycast hit filtering. Iterative with a
   * visited guard: hierarchies can be deep, and a malformed cycle must not
   * overflow the call stack or loop forever.
   */
  private collectEntitySet(root: Entity): Set<Entity> {
    const set = new Set<Entity>();
    const stack: Entity[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current == null || set.has(current)) {
        continue;
      }
      set.add(current);
      for (const child of current.getChildren({})) {
        stack.push(child);
      }
    }
    return set;
  }

  protected override locomotionStarterName(): string | null {
    return 'BotBehaviorInstaller';
  }
}
