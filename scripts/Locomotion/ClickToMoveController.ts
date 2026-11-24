/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Locomotion Scripts v8

/**
 * ClickToMoveController
 *
 * Component Attachment: a scene service entity (`PlayerInputServices` in space.hstf)
 * Component Networking: Everywhere — each client binds to its own local player
 *   and ignores the server context, so the callbacks only ever reach a
 *   character that client owns.
 *
 * Search aliases: point-and-move, tap-to-move, PointAndClick, SetDestination,
 *                 walk to, navigate to, click to move, click-to-move
 *
 * Takes world taps from `TouchTapTarget` (the touch router's tap-to-world
 * layer, which already raycasts and skips the player's own body), snaps the
 * hit point to the NavMesh, computes a NavMesh path, and each frame publishes a
 * camera-relative Vec2 to the 'Move' action on InputActionsManager.
 * PlayerActionController forwards 'Move' to CharacterStateMachine →
 * MovementAbility, so click-to-move shares the same locomotion pipeline as the
 * joystick. Taps on HUD buttons never reach it, because the buttons claim them
 * first in the router.
 *
 * Dragging turns the camera through `TouchCameraLook`, whose zone is the whole
 * screen in the TapToMove touch movement scheme (see TouchMovementScheme.ts), so
 * the turn feels the same as in joystick mode.
 *
 * The 'ClickToMove' Button action is held true while a path is active, and
 * PlayerActionController reads it to drop idle Vec2.zero values from the
 * engine axis rather than let them clobber click-to-move steering.
 *
 * Animation and facing work automatically: MovementAbility receives real
 * input through the normal pipeline, AutoFaceRotationAbility reads the
 * resulting movement direction, and CharacterAnimationController drives Speed.
 *
 * Hosted on the scene's PlayerInputServices entity alongside PlayerActionController,
 * and bound to the local player's character on spawn.
 *
 * Prerequisite: MovementAbility and CharacterUpdateManager must be on the
 * same entity (PlayerCharacter root), and the scene needs the `TouchTapTarget`
 * entity (`space.hstf` has it).
 */

import {
  Component,
  component,
  property,
  subscribe,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  ExecuteOn,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  NetworkingService,
  CameraService,
  TransformComponent,
  WorldService,
  NetworkMode,
  TemplateAsset,
  Vec2,
  Vec3,
  type Maybe,
} from 'meta/worlds';
import type {EventSubscription, OnWorldUpdateEventPayload, Entity} from 'meta/worlds';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';
import {InputActionsManager} from '../Input/InputActionsManager';
import {TouchTapTarget, type TapHitEvent} from '../Input/TouchTapTarget';
import {NavMeshLookup} from '../Navigation/NavMeshLookup';

@component({
  description:
    'Point-and-click / tap-to-move controller: a tap on the ground pathfinds via NavMesh ' +
    'and steers the character through the Move action. Active when ' +
    'LocomotionSettingsComponent.locomotionMode is ClickToMove. Aliases: point-and-move, ' +
    'tap-to-move, PointAndClick, SetDestination, walk to, navigate to.',
})
export class ClickToMoveController extends Component {
  // ═══════════════════════════════════════════════════════════════════════════
  // @property declarations — exposed for per-instance tuning
  // ═══════════════════════════════════════════════════════════════════════════

  /** XZ distance to consider an intermediate waypoint reached. */
  @property()
  waypointReachDistance: number = 0.4;

  /** XZ distance to consider the final destination reached. */
  @property()
  destinationReachDistance: number = 0.3;

  /** Maximum waypoints returned by findPath. NavMesh guide recommends 256. */
  @property()
  maxPathSize: number = 256;

  /**
   * NavMesh search radius for findPath (start/end snap tolerance).
   * Keep small (e.g. 1.0) to avoid snapping far off-navmesh.
   */
  @property()
  findPathSearchDistance: number = 5.0;

  /**
   * NavMesh search radius for findClosestPoint (tap-point snap).
   * Can be larger (e.g. 10.0) so taps near navmesh edges still register.
   */
  @property()
  findClosestPointSearchDistance: number = 10.0;

  /** Seconds between automatic repath requests while following a path. */
  @property()
  repathIntervalSec: number = 0.5;

  /**
   * Distance over which movement input is ramped down on approach to the
   * final waypoint, preventing overshoot/oscillation.
   */
  @property()
  arrivalRampDistance: number = 2.0;

  /** Gate ALL diagnostic console.log calls behind this flag. */
  @property()
  debugLogging: boolean = false;

  /**
   * Optional template spawned at the destination as a persistent marker.
   * Appears on tap, destroyed on arrival or new tap. Leave null for no marker.
   */
  @property()
  destinationMarkerTemplate: Maybe<TemplateAsset> = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // Cached references
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The local player's character. Null before it spawns and again once it is
   * gone, which makes every handler below a no-op in between — and on a client
   * whose local player is not this one.
   */
  private character: Maybe<Entity> = null;
  private transformComponent: Maybe<TransformComponent> = null;
  private stateMachine: Maybe<CharacterStateMachine> = null;
  private readonly navMeshLookup = new NavMeshLookup({owner: 'ClickToMoveController'});

  /**
   * Cached camera XZ-forward for the world→camera-relative inverse projection.
   * When the camera pitches near -90° the XZ projection is degenerate; this
   * cache keeps the last valid direction so steering doesn't jitter.
   */
  private lastValidCamFwdX: number = 0;
  private lastValidCamFwdZ: number = -1;

  // ═══════════════════════════════════════════════════════════════════════════
  // Path state
  // ═══════════════════════════════════════════════════════════════════════════

  private waypoints: Vec3[] = [];
  private currentWaypointIndex: number = 0;
  private isFollowingPath: boolean = false;
  /** The true final destination (survives path truncation). */
  private currentDestination: Vec3 = Vec3.zero;
  /** True when findPath returned maxPathSize points — last waypoint is NOT the real destination. */
  private pathWasTruncated: boolean = false;

  // Async guards (last-tap-wins)
  private pathRequestInFlight: boolean = false;
  private pendingDestination: Maybe<Vec3> = null;
  /** True when pendingDestination was set by a user tap (not a repath). */
  private pendingIsUserTap: boolean = false;

  // Repathing timer
  private timeSinceLastRepath: number = 0;

  // Frame counter for periodic diagnostics
  private frameCount: number = 0;

  // Destination marker entity
  private destinationMarkerEntity: Maybe<Entity> = null;
  /** Generation counter to prevent marker spawn races on rapid taps. */
  private markerGeneration: number = 0;

  // World-tap subscription on TouchTapTarget while click-to-move is active.
  private tapSubscription: Maybe<EventSubscription> = null;

  // Runtime toggle: when false, tap events are ignored (click-to-move disabled)
  private clickToMoveActive: boolean = true;

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bind to the local player's character. Gated on `isLocal` so a remote player
   * spawning on this client does not capture the controller, and on the server
   * context, which drives no input.
   *
   * This replaces the OnOwnershipTransferEvent handler the character-hosted
   * version carried. That existed because ownership of the body could arrive
   * after OnEntityStartEvent had already fired; hosted here the bind is driven
   * by the player's own lifecycle instead, so there is no such race. The case it
   * no longer covers is ownership of an existing character transferring without
   * a destroy/create cycle.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (NetworkingService.get().isServerContext() || !payload.isLocal) {
      return;
    }
    const playerEntity: Maybe<Entity> = payload.entity;
    if (!playerEntity) {
      console.error(
        '[ClickToMoveController] OnPlayerCreateEvent carried no local entity; click-to-move disabled.',
      );
      return;
    }
    this.character = playerEntity;
    this.initReferences();
  }

  /**
   * Drop the character on despawn and stop listening for taps. Without this the
   * per-frame path follower would keep publishing 'Move' input until the next
   * spawn replaced the character.
   */
  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!payload.isLocal) {
      return;
    }
    this.clearPathAndSignal();
    this.unsubscribeTaps();
    this.destroyMarker();
    this.character = null;
    this.transformComponent = null;
    this.stateMachine = null;
  }

  /** Resolve everything this controller drives off the bound character. */
  private initReferences(): void {
    const character = this.character;
    if (!character) {
      return;
    }
    this.transformComponent = character.getComponent(TransformComponent);
    this.stateMachine = character.getComponent(CharacterStateMachine);

    // Loud diagnostics for missing required components
    if (!this.transformComponent) {
      console.error(
        '[ClickToMoveController] MISSING required component: TransformComponent on entity ' +
          character.name +
          '. Click-to-move will not function.',
      );
    }

    // Find NavMesh in the world (auto-discovered, like GotoBehavior). Each path
    // request resolves it again, so a navmesh replaced at runtime is followed.
    if (this.navMeshLookup.resolveAny()) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] NavMeshComponent found');
      }
    } else {
      console.warn(
        '[ClickToMoveController] No NavMeshComponent found — pathfinding disabled. ' +
          'Direct walk-to-destination will be used as fallback.',
      );
    }

    if (this.clickToMoveActive) {
      this.subscribeTaps();
    }

    if (this.debugLogging) {
      console.log('[ClickToMoveController] Initialised (routing through InputActionsManager)');
    }
  }

  /**
   * Listen for world taps. TouchTapTarget may start after this component, so the
   * update loop retries until it exists.
   */
  private subscribeTaps(): void {
    if (this.tapSubscription != null) {
      return;
    }
    const tapTarget = TouchTapTarget.instance;
    if (tapTarget == null) {
      return;
    }
    this.tapSubscription = tapTarget.subscribeTap((event: TapHitEvent) => this.onTap(event));
  }

  private unsubscribeTaps(): void {
    this.tapSubscription?.disconnect();
    this.tapSubscription = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public Runtime Toggle API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enable or disable click-to-move at runtime. When disabled, taps are ignored
   * and any active path is cancelled.
   */
  public setClickToMoveEnabled(enabled: boolean): void {
    this.clickToMoveActive = enabled;
    if (!enabled) {
      if (this.isFollowingPath) {
        this.clearPathAndSignal();
        this.destroyMarker();
      }
      this.unsubscribeTaps();
    } else if (this.character != null) {
      this.subscribeTaps();
    }
  }

  /** Returns whether click-to-move is currently active. */
  public isClickToMoveEnabled(): boolean {
    return this.clickToMoveActive;
  }

  /**
   * Not routed through `setClickToMoveEnabled(false)`: re-enabling on revive would
   * override `LocomotionSettingsComponent`.
   */
  private isCharacterDead(): boolean {
    return this.stateMachine?.isDead() ?? false;
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    this.unsubscribeTaps();
    this.destroyMarker();
    if (this.debugLogging) {
      console.log('[ClickToMoveController] onDestroy — cleaned up');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Taps
  // ═══════════════════════════════════════════════════════════════════════════

  /** A world tap from TouchTapTarget: walk to the point it hit. */
  private onTap(event: TapHitEvent): void {
    if (!this.character || !this.clickToMoveActive || this.isCharacterDead()) {
      return;
    }
    const destination = event.worldPoint;
    if (this.debugLogging) {
      console.log(
        '[ClickToMoveController] Tap at:',
        destination.x.toFixed(2),
        destination.y.toFixed(2),
        destination.z.toFixed(2),
      );
    }
    void this.spawnOrMoveMarker(destination);
    void this.requestPathTo(destination, true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NavMesh Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async snapToNavMesh(position: Vec3): Promise<Maybe<Vec3>> {
    const navMesh = this.navMeshLookup.resolveAny();
    if (!navMesh) return null;
    try {
      const snapped = await navMesh.findClosestPoint(position, {
        maxSearchDistance: this.findClosestPointSearchDistance,
      });
      return snapped ?? null;
    } catch (err) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] findClosestPoint error: ' + String(err));
      }
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pathfinding
  // ═══════════════════════════════════════════════════════════════════════════

  private async requestPathTo(destination: Vec3, isUserTap: boolean = false): Promise<void> {
    if (!this.transformComponent) {
      console.error('[ClickToMoveController] Cannot pathfind — TransformComponent missing');
      this.destroyMarker();
      return;
    }

    // No-navmesh fallback: direct beeline
    const navMesh = this.navMeshLookup.resolveAny();
    if (!navMesh) {
      this.waypoints = [destination];
      this.currentWaypointIndex = 0;
      this.currentDestination = destination;
      this.pathWasTruncated = false;
      this.isFollowingPath = true;
      this.timeSinceLastRepath = 0;
      InputActionsManager.instance?.setButtonState('ClickToMove', true);
      if (this.debugLogging) {
        console.log('[ClickToMoveController] No NavMesh — direct walk to destination');
      }
      return;
    }

    // Last-tap-wins: if a request is in flight, store as pending.
    if (this.pathRequestInFlight) {
      if (this.pendingDestination !== null && this.pendingIsUserTap && !isUserTap) {
        if (this.debugLogging) {
          console.log('[ClickToMoveController] Repath skipped — user tap already queued');
        }
        return;
      }
      this.pendingDestination = destination;
      this.pendingIsUserTap = isUserTap;
      if (this.debugLogging) {
        console.log(
          '[ClickToMoveController] Path request in flight — queuing pending destination' +
            (isUserTap ? ' (user tap)' : ' (repath)'),
        );
      }
      return;
    }

    this.pathRequestInFlight = true;
    try {
      const start = this.transformComponent.worldPosition;
      const path = await navMesh.findPath(start, destination, {
        maxPathSize: this.maxPathSize,
        maxSearchDistance: this.findPathSearchDistance,
      });

      if (path && path.length > 0) {
        this.pathWasTruncated = path.length >= this.maxPathSize;

        if (this.debugLogging) {
          console.log(
            `[ClickToMoveController] Path found with ${path.length} waypoints` +
              (this.pathWasTruncated ? ' (TRUNCATED — will request continuation)' : ''),
          );
        }

        this.waypoints = path;
        this.currentWaypointIndex = this.findNearestWaypointAhead(path, start);
        this.currentDestination = destination;
        this.isFollowingPath = true;
        this.timeSinceLastRepath = 0;
        InputActionsManager.instance?.setButtonState('ClickToMove', true);
      } else {
        if (this.debugLogging) {
          console.log(
            '[ClickToMoveController] findPath returned empty — attempting navmesh snap fallback',
          );
        }
        const snapped = await this.snapToNavMesh(destination);
        if (snapped) {
          const retryPath = await navMesh.findPath(start, snapped, {
            maxPathSize: this.maxPathSize,
            maxSearchDistance: this.findPathSearchDistance,
          });
          if (retryPath && retryPath.length > 0) {
            this.pathWasTruncated = retryPath.length >= this.maxPathSize;
            this.waypoints = retryPath;
            this.currentWaypointIndex = this.findNearestWaypointAhead(retryPath, start);
            this.currentDestination = snapped;
            this.isFollowingPath = true;
            this.timeSinceLastRepath = 0;
            InputActionsManager.instance?.setButtonState('ClickToMove', true);
            if (this.debugLogging) {
              console.log(
                `[ClickToMoveController] Fallback snap succeeded — path has ${retryPath.length} waypoints`,
              );
            }
          } else {
            this.stopFollowingOnFailedTap(isUserTap);
            if (this.debugLogging) {
              console.log(
                '[ClickToMoveController] Fallback snap: point valid but no path found — giving up',
              );
            }
          }
        } else {
          this.stopFollowingOnFailedTap(isUserTap);
          if (this.debugLogging) {
            console.log(
              '[ClickToMoveController] No valid navmesh point near destination — giving up',
            );
          }
        }
      }
    } catch (err) {
      console.warn('[ClickToMoveController] findPath error — falling back to direct walk: ' + String(err));
      this.waypoints = [destination];
      this.currentWaypointIndex = 0;
      this.currentDestination = destination;
      this.pathWasTruncated = false;
      this.isFollowingPath = true;
      this.timeSinceLastRepath = 0;
      InputActionsManager.instance?.setButtonState('ClickToMove', true);
    } finally {
      this.pathRequestInFlight = false;

      if (this.pendingDestination) {
        const pending = this.pendingDestination;
        const pendingWasUserTap = this.pendingIsUserTap;
        this.pendingDestination = null;
        this.pendingIsUserTap = false;
        void this.requestPathTo(pending, pendingWasUserTap);
      }
    }
  }

  /**
   * A tap that resolves to no reachable navmesh point must halt the character
   * rather than leave the prior path running — otherwise the periodic repath in
   * onUpdate keeps steering toward the stale destination. Only user taps stop an
   * active path; a failed repath keeps the existing (still-valid) path so a
   * transient failure doesn't strand the character mid-route.
   */
  private stopFollowingOnFailedTap(isUserTap: boolean): void {
    if (isUserTap) {
      this.clearPathAndSignal();
    }
    this.destroyMarker();
  }

  /**
   * After a repath, find the index of the nearest waypoint that is ahead of
   * the character's current position (avoids briefly steering backward).
   */
  private findNearestWaypointAhead(path: Vec3[], currentPos: Vec3): number {
    if (path.length <= 1) return 0;

    let bestIndex = 0;
    let bestDistSq = Infinity;

    for (let i = 0; i < path.length; i++) {
      const dx = path[i].x - currentPos.x;
      const dz = path[i].z - currentPos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIndex = i;
      }
    }

    if (bestIndex < path.length - 1) {
      const reachSq = this.waypointReachDistance * this.waypointReachDistance;
      if (bestDistSq < reachSq) {
        return bestIndex + 1;
      }
    }

    return bestIndex;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-Frame Steering — Publishes camera-relative Vec2 to InputActionsManager
  // ═══════════════════════════════════════════════════════════════════════════

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (!this.transformComponent) return;

    if (this.clickToMoveActive && this.tapSubscription == null) {
      this.subscribeTaps();
    }

    // The Dead state blocks MovementAbility downstream, but a live path would keep
    // republishing a non-zero 'Move' axis - drop the path and zero the bus here.
    if (this.isCharacterDead()) {
      if (this.isFollowingPath) {
        this.clearPathAndSignal();
        this.destroyMarker();
      }
      return;
    }

    // Only drive movement while isFollowingPath. When not following a path,
    // leave everything alone so joystick / PlayerActionController can drive.
    if (!this.isFollowingPath || this.waypoints.length === 0) {
      return;
    }

    const dt = payload.deltaTime;
    this.frameCount++;

    // Periodic repathing
    this.timeSinceLastRepath += dt;
    if (this.repathIntervalSec > 0 && this.timeSinceLastRepath >= this.repathIntervalSec) {
      this.timeSinceLastRepath = 0;
      void this.requestPathTo(this.currentDestination, false);
    }

    const currentPos = this.transformComponent.worldPosition;
    const targetWaypoint = this.waypoints[this.currentWaypointIndex];

    // Compute XZ distance to current waypoint
    const dx = targetWaypoint.x - currentPos.x;
    const dz = targetWaypoint.z - currentPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    // Check if this is the final waypoint in the current path
    const isLastInPath = this.currentWaypointIndex >= this.waypoints.length - 1;
    const isFinalWaypoint = isLastInPath && !this.pathWasTruncated;
    const reachDist = isFinalWaypoint ? this.destinationReachDistance : this.waypointReachDistance;

    if (distXZ < reachDist) {
      if (isFinalWaypoint) {
        // Arrived at destination
        if (this.debugLogging) {
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- fires once per completed path, and only when debugLogging is on
          console.log('[ClickToMoveController] Arrived at destination');
        }
        this.clearPathAndSignal();
        this.destroyMarker();
        return;
      } else if (isLastInPath && this.pathWasTruncated) {
        // Reached end of truncated path: request continuation
        if (this.debugLogging) {
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- fires once per truncated path segment, and only when debugLogging is on
          console.log(
            '[ClickToMoveController] Reached end of truncated path — requesting continuation',
          );
        }
        this.pathWasTruncated = false;
        void this.requestPathTo(this.currentDestination, false);
        return;
      } else {
        // Advance to next waypoint
        this.currentWaypointIndex++;
        return;
      }
    }

    // Compute world-space direction to waypoint (XZ plane only)
    const invDist = 1 / distXZ;
    const worldDirX = dx * invDist;
    const worldDirZ = dz * invDist;

    // Compute speed scale — ramp down near final destination
    let speedScale = 1.0;
    if (isFinalWaypoint && this.arrivalRampDistance > 0 && distXZ < this.arrivalRampDistance) {
      speedScale = Math.max(distXZ / this.arrivalRampDistance, 0.1);
    }

    // --- Inverse-project world direction into camera-relative Vec2 ---
    // MovementAbility expects camera-relative input; the camera basis
    // conversion happens downstream in MovementAbility.calculateMovementDirection().
    // The forward-projection cutoff must match that decoder in both directions.
    const camera = CameraService.get();
    let camFwd3 = camera.forward;
    let fwdMagSq = camFwd3.x * camFwd3.x + camFwd3.z * camFwd3.z;
    if (fwdMagSq < 0.01 && camFwd3.y < 0) {
      camFwd3 = camera.up;
      fwdMagSq = camFwd3.x * camFwd3.x + camFwd3.z * camFwd3.z;
    }
    let fwdX = camFwd3.x;
    let fwdZ = camFwd3.z;

    if (fwdMagSq >= 0.01) {
      // Valid XZ projection — normalise and cache
      const fwdInvMag = 1 / Math.sqrt(fwdMagSq);
      fwdX *= fwdInvMag;
      fwdZ *= fwdInvMag;
      this.lastValidCamFwdX = fwdX;
      this.lastValidCamFwdZ = fwdZ;
    } else {
      // Upward or invalid projection — reuse the cached horizontal heading.
      fwdX = this.lastValidCamFwdX;
      fwdZ = this.lastValidCamFwdZ;
    }

    // Camera right on XZ = forward × up = (-fwdZ, 0, fwdX)
    const rightX = -fwdZ;
    const rightZ = fwdX;

    // Dot the world direction with cam right/forward to get camera-relative input
    const inputX = worldDirX * rightX + worldDirZ * rightZ;
    const inputY = worldDirX * fwdX + worldDirZ * fwdZ;

    // Scale by arrivalRamp — magnitude controls character speed through MovementAbility
    // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- Vec2 is immutable, one per frame
    const moveInput = new Vec2(inputX * speedScale, inputY * speedScale);
    InputActionsManager.instance?.setAxis2DValue('Move', moveInput);

    // Facing is handled automatically by AutoFaceRotationAbility, which reads
    // MovementAbility.getMovementDirection() — no manual rotation slerp needed.

    // Periodic diagnostic behind debugLogging and frame counter
    if (this.debugLogging && this.frameCount % 60 === 0) {
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- throttled to every 60th frame, and only when debugLogging is on
      console.log(
        `[ClickToMoveController] Following: wpIdx=${this.currentWaypointIndex}` +
          `/${this.waypoints.length}` +
          ` dist=${distXZ.toFixed(2)}` +
          ` moveInput=(${moveInput.x.toFixed(2)}, ${moveInput.y.toFixed(2)})` +
          (this.pathWasTruncated ? ' (truncated)' : ''),
      );
    }
  }

  /**
   * Clear path state and signal the input bus that click-to-move steering
   * has ended. Zeroes the 'Move' axis so the character stops, and releases
   * the 'ClickToMove' button so other systems (e.g. PlayerActionController)
   * know the bus is free.
   */
  private clearPathAndSignal(): void {
    this.isFollowingPath = false;
    this.waypoints.length = 0;
    this.pathWasTruncated = false;
    InputActionsManager.instance?.setAxis2DValue('Move', Vec2.zero);
    InputActionsManager.instance?.setButtonState('ClickToMove', false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Destination Marker
  // ═══════════════════════════════════════════════════════════════════════════

  private async spawnOrMoveMarker(position: Vec3): Promise<void> {
    this.markerGeneration++;
    const gen = this.markerGeneration;

    this.destroyMarker();

    if (!this.destinationMarkerTemplate) return;

    try {
      const spawned = await WorldService.get().spawnTemplate({
        templateAsset: this.destinationMarkerTemplate,
        networkMode: NetworkMode.LocalOnly,
        position: position,
        rotation: null,
        scale: null,
        parent: null,
        serverOwned: false,
      });

      if (gen !== this.markerGeneration) {
        spawned.destroy();
        return;
      }

      this.destinationMarkerEntity = spawned;
    } catch (err) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] Failed to spawn destination marker: ' + String(err));
      }
    }
  }

  private destroyMarker(): void {
    if (this.destinationMarkerEntity) {
      this.destinationMarkerEntity.destroy();
      this.destinationMarkerEntity = null;
    }
  }
}
