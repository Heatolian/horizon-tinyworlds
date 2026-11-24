/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v18

import {
  component,
  Component,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  CameraService,
  PhysicsService,
  PlayerService,
  NetworkingService,
  CastMode,
  CollisionLayerMask,
  Vec2,
  Vec3,
} from 'meta/worlds';
import type {
  Entity,
  Maybe,
  EventSubscription,
  RayCastInput,
  SceneCastOutput,
  SceneHitData,
} from 'meta/worlds';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// ============================================================================
// Tuning constants
// ============================================================================

// A press whose finger travels more than this normalized screen distance
// between down and up is a DRAG, not a tap, and is ignored. Keeping this small
// lets a drag reach the camera-look drag beneath (which turns the camera) while
// only a clean tap raycasts and consumes.
const TAP_MAX_TRAVEL = 0.03;

// Far-point distance (world units) used to build the pick ray from the camera.
// The ray direction is (screenToWorldPoint(x, y, RAY_FAR) - cameraPos); the
// actual pick length is `maxRayDistance` below.
const RAY_FAR = 1000;

// Over-fetch count for the pick ray. A third-person ray passes through several
// avatar colliders before the ground/target, so fetch enough unsorted hits that
// the intended one survives the player filter.
// WHY 32: CastMode.UnsortedHits returns an ARBITRARY subset once the cap is hit
// (not the nearest), so it must exceed worst-case colliders-per-ray (rig + scene
// geometry) or the nearest non-player hit is not guaranteed; 32 covers that.
const MAX_PICK_HITS = 32;

// Bounded ancestor-walk depth for the player-hit filter. Avatar colliders sit a
// few levels under the player root; a small cap guards a malformed hierarchy.
const PLAYER_WALK_MAX_DEPTH = 16;

// True when `node` is `ancestor` or a descendant of it: a bounded walk up from
// `node`. isSameOrDescendant is WSDK-internal (not on the durable surface), so
// this control inlines its own (mirrors scripts/Interaction/InteractionController.ts).
function isSameOrDescendant(node: Entity, ancestor: Entity): boolean {
  let cursor: Maybe<Entity> = node;
  let depth = 0;
  while (cursor != null && depth < PLAYER_WALK_MAX_DEPTH) {
    if (cursor === ancestor) {
      return true;
    }
    cursor = cursor.parent;
    depth += 1;
  }
  return false;
}

// ============================================================================
// Public hit payload
// ============================================================================

/**
 * Delivered to {@link TouchTapTarget.subscribeTap} consumers when a tap
 * resolves to a world-space hit. This is the rich channel the scalar/vector
 * {@link InputActionsManager} bus cannot carry (an entity + a Vec3 point +
 * a normal), so tap-target has its own subscription rather than a bus action.
 */
export class TapHitEvent {
  /** Router finger index that produced the tap. */
  readonly interactionIndex: number;
  /** Normalized tap position (0..1, +Y down). */
  readonly screenPosition: Vec2;
  /** World-space point where the pick ray hit. */
  readonly worldPoint: Vec3;
  /** Normalized surface normal at the hit. */
  readonly normal: Vec3;
  /** Physics body hit. May be null even on a hit — check {@link shapeEntity}. */
  readonly actorEntity: Maybe<Entity>;
  /** Collider shape hit. Avatar parts often appear here with a null actor. */
  readonly shapeEntity: Maybe<Entity>;
  /** Distance from the camera to the hit, world units. */
  readonly distance: number;

  constructor(
    interactionIndex: number,
    screenPosition: Vec2,
    worldPoint: Vec3,
    normal: Vec3,
    actorEntity: Maybe<Entity>,
    shapeEntity: Maybe<Entity>,
    distance: number,
  ) {
    this.interactionIndex = interactionIndex;
    this.screenPosition = screenPosition;
    this.worldPoint = worldPoint;
    this.normal = normal;
    this.actorEntity = actorEntity;
    this.shapeEntity = shapeEntity;
    this.distance = distance;
  }
}

/** Callback signature for {@link TouchTapTarget.subscribeTap}. */
export type TapHitCallback = (event: TapHitEvent) => void;

// ============================================================================
// Component
//
// A screen-tap -> world-raycast control. It has no XAML (a world tap has no
// on-screen widget). Touch is delivered by the shared TouchRouter; this control
// registers a descriptor instead of subscribing to the raw OnTouchInput* events
// itself. On a clean TAP (not a drag) it builds a pick ray from the active
// camera via CameraService.screenToWorldPoint + position, runs
// PhysicsService.rayCast, and delivers the closest hit (entity/point/normal)
// that is NOT the local player's own rig to subscribeTap consumers -- so the
// avatar a third-person ray passes through does not mask the ground or target
// behind it. This is the project-owned replacement for
// FocusedInteractionService's "tap the world" use on mobile/character_template;
// it deliberately ships NO tap/trail VFX.
//
// SHIPS WITH THE STACK, INERT UNTIL SUBSCRIBED: this control is installed
// alongside the rest of the touch stack so consumers (tap-to-move, or the
// interaction bridge) can import and subscribe to it, but with zero subscribers
// it skips the raycast entirely and costs nothing. A consumer subscribing is what
// "turns it on".
//
// LAYERING: registers at zPriority 40 (below HUD buttons 100 and the joystick
// 50, above camera-look 0). It never consumes at start, so a drag still reaches
// the camera-look drag beneath; on a clean tap it raycasts and consumes. hitTest
// is the whole screen; a HUD button that consumes its press tells this layer
// alreadyConsumed, so a tap on a button never raycasts the world. A pass-through
// button claims the touch at release instead, with the same result. The joystick
// no longer consumes, so a tap in the movement zone DOES reach this layer.
//
// CLIENT-ONLY: CameraService and PhysicsService are client-only. Touches only
// originate client-side, but the raycast path still requires a player context.
// ============================================================================

@component()
export class TouchTapTarget extends Component {
  /** Global access point so consumers can subscribe: `TouchTapTarget.instance?.subscribeTap(...)`. */
  public static instance: Maybe<TouchTapTarget> = null;

  /** Router layer. Below buttons (100) and joystick (50); above camera-look (0). */
  @property()
  zPriority: number = 40;

  /** Max pick-ray length in world units. */
  @property()
  maxRayDistance: number = 10000;

  private subscribers: {id: number; cb: TapHitCallback}[] = [];
  private nextSubId: number = 0;
  // Touch-down position per finger index, to classify tap vs drag at release.
  private downByIndex: Map<number, Vec2> = new Map();
  // Fingers whose travel crossed TAP_MAX_TRAVEL at any point during the gesture.
  // Release classification checks this so an out-and-back drag (which ends near
  // its down point, so its net displacement is small) is not misread as a tap.
  private draggedByIndex: Set<number> = new Set();
  // Set in onDestroy so an in-flight async rayCast that resolves after teardown
  // does not dispatch to torn-down subscribers.
  private destroyed: boolean = false;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    TouchTapTarget.instance = this;
    TouchRouter.register({
      id: 'tapTarget',
      zPriority: this.zPriority,
      // Never consumes at start (a drag still reaches camera-look beneath); it
      // acts only on a clean tap at release, and consumes then. Keep the finger
      // so onEnd always fires with the release position for drag classification.
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (_pos: Vec2) => true,
      handlers: {
        // Skip the tap if a HIGHER control (a HUD button) already consumed the
        // touch: recording no down-point makes handleEnd bail, so a button tap
        // never raycasts the world beneath it.
        onStart: (index: number, pos: Vec2, alreadyConsumed: boolean) => {
          // Clear any stale per-finger state for this index first. The OS can
          // reuse an index after a gesture the router dropped without an onEnd or
          // onCancel (e.g. a router teardown mid-touch); a leaked down point or
          // dragged flag would otherwise corrupt the next gesture on this index.
          this.downByIndex.delete(index);
          this.draggedByIndex.delete(index);
          if (!alreadyConsumed) {
            this.downByIndex.set(index, new Vec2(pos.x, pos.y));
          }
        },
        // Track travel: if the finger ever moves past TAP_MAX_TRAVEL from its
        // down point, mark it a drag so handleEnd will not fire even if it
        // returns near the origin (an out-and-back camera drag). Never consumes.
        onMove: (index: number, pos: Vec2) => this.handleMove(index, pos),
        onEnd: (index: number, pos: Vec2, alreadyConsumed: boolean) =>
          this.handleEnd(index, pos, alreadyConsumed),
        // On an interrupted finger the router calls onCancel, not onEnd: drop the
        // recorded down WITHOUT classifying a tap or raycasting, so a dropped
        // Ended followed by a new touch cannot deliver a phantom world tap.
        onCancel: (index: number) => {
          this.downByIndex.delete(index);
          this.draggedByIndex.delete(index);
        },
      },
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    this.destroyed = true;
    TouchRouter.unregister('tapTarget');
    this.downByIndex.clear();
    this.draggedByIndex.clear();
    this.subscribers = [];
    if (TouchTapTarget.instance === this) {
      TouchTapTarget.instance = null;
    }
  }

  // --------------------------------------------------------------------------
  // Subscribe
  // --------------------------------------------------------------------------

  /**
   * Register a callback fired whenever a tap resolves to a world hit.
   * @returns A handle with a `disconnect()` method — call it in `onDestroy()`.
   */
  public subscribeTap(cb: TapHitCallback): EventSubscription {
    const id = this.nextSubId;
    this.nextSubId += 1;
    this.subscribers.push({id, cb});
    return {
      disconnect: () => {
        const at = this.subscribers.findIndex(s => s.id === id);
        if (at >= 0) {
          this.subscribers.splice(at, 1);
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Router handler
  // --------------------------------------------------------------------------

  private handleMove(index: number, pos: Vec2): void {
    const down = this.downByIndex.get(index);
    if (down == null) {
      return; // no down recorded (consumed at start); not our finger to track.
    }
    const dx = pos.x - down.x;
    const dy = pos.y - down.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_TRAVEL) {
      this.draggedByIndex.add(index);
    }
  }

  private handleEnd(index: number, pos: Vec2, alreadyConsumed: boolean): boolean {
    const down = this.downByIndex.get(index);
    const dragged = this.draggedByIndex.has(index);
    this.downByIndex.delete(index);
    this.draggedByIndex.delete(index);
    if (down == null) {
      return false; // no down recorded (consumed at start); nothing to do.
    }
    if (alreadyConsumed) {
      // A higher control claimed this finger at release (e.g. the joystick drove
      // movement), so do not also fire a world tap for the same finger.
      return false;
    }
    if (dragged) {
      // The finger crossed the tap threshold mid-gesture and returned near its
      // origin (an out-and-back drag): classify as a drag, not a tap.
      return false;
    }
    const dx = pos.x - down.x;
    const dy = pos.y - down.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_TRAVEL) {
      return false; // a drag, not a tap — leave it to the camera-look drag beneath.
    }
    if (!NetworkingService.get().isPlayerContext()) {
      return false; // CameraService / PhysicsService are client-only.
    }
    if (this.subscribers.length === 0) {
      // Inert until a consumer subscribes. This control ships with the stack so
      // the interaction glue's import always resolves, but with no subscriber
      // there is no tap-to-world use, so skip the raycast entirely (zero cost).
      return false;
    }

    const cam = CameraService.get();
    const origin = cam.position;
    const far = cam.screenToWorldPoint(new Vec3(pos.x, pos.y, RAY_FAR));
    const dir = far.sub(origin).normalize();

    // rayCast is asynchronous: the hit arrives a beat after the tap. Snapshot the
    // tap position so the resolved event reports where the finger lifted, and the
    // local player so a respawn during the in-flight cast cannot change the filter.
    // Optional-chain the service so an unregistered PlayerService drops the tap
    // gracefully (same as a null player) instead of throwing out of the handler.
    const tapPos = new Vec2(pos.x, pos.y);
    const playerRoot = PlayerService.get()?.getLocalPlayer() ?? null;

    // Over-fetch UNSORTED hits, pick the closest that is NOT the local player:
    // a third-person ray passes through the avatar, so ClosestHit returns the
    // player's own collider and hides the ground behind it. excludeEntities drops
    // player ROOT so it takes no MAX_PICK_HITS slot; the ancestor-walk filter
    // below still catches the rig's descendant colliders, which excludeEntities
    // (a few ids) cannot cover.
    const input: RayCastInput = {
      mode: CastMode.UnsortedHits,
      origin,
      dir,
      distance: this.maxRayDistance,
      collisionLayerMask: CollisionLayerMask.AllLayers,
      includeTriggers: false,
      maxUnsortedHits: MAX_PICK_HITS,
      excludeEntities: playerRoot != null ? [playerRoot] : undefined,
    };
    PhysicsService.get()
      .rayCast(input)
      .then((out: SceneCastOutput) => {
        if (this.destroyed) {
          return; // component torn down while the raycast was in flight.
        }
        if (!out.hasHitSomething || out.hits == null || out.hits.length === 0) {
          return; // tapped empty space (e.g. the sky): no hit to deliver.
        }
        if (playerRoot == null) {
          // No resolved local player to exclude (early load / respawn): delivering
          // the nearest hit would hand back the avatar, so drop this tap.
          return;
        }
        // UnsortedHits has no distance order: sort, then take the closest hit
        // that is not part of the local player's own rig.
        const sorted = out.hits.slice().sort((a, b) => a.distance - b.distance);
        let hit: Maybe<SceneHitData> = null;
        for (const candidate of sorted) {
          if (this.isPlayerHit(candidate, playerRoot)) {
            continue;
          }
          hit = candidate;
          break;
        }
        if (hit == null) {
          return; // only the player was under the tap: nothing to deliver.
        }
        const event = new TapHitEvent(
          index,
          tapPos,
          hit.position,
          hit.normal,
          hit.actorEntity,
          hit.shapeEntity,
          hit.distance,
        );
        // Snapshot the subscriber list so a callback that disconnects
        // mid-dispatch cannot shift indices out from under the loop.
        for (const s of this.subscribers.slice()) {
          s.cb(event);
        }
      })
      .catch((err: unknown) => {
        console.error('[TouchTapTarget] rayCast failed', err);
      });
    // A clean tap that we raycast is genuine handling: consume it so any lower
    // layer stands down. The raycast + delivery is async and fire-and-forget.
    return true;
  }

  // True when a hit belongs to the local player's own rig (root or a descendant
  // collider), so tap-to-world skips the avatar the camera ray passes through.
  private isPlayerHit(hit: SceneHitData, playerRoot: Entity): boolean {
    const actor = hit.actorEntity;
    const shape = hit.shapeEntity;
    return (
      (actor != null && isSameOrDescendant(actor, playerRoot)) ||
      (shape != null && isSameOrDescendant(shape, playerRoot))
    );
  }
}
