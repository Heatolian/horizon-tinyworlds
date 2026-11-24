import {
  Component,
  ExecuteOn,
  NetworkingService,
  OnEntityStartEvent,
  OnTouchInputEndedEvent,
  OnTouchInputStartedEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  Quaternion,
  TouchInputEventPayload,
  TransformComponent,
  Vec2,
  Vec3,
  component,
  property,
  subscribe,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';

// Tap-to-rotate for the three movable channel tiles of the Tiny Worlds board.
// A clean tap (or desktop click) on a movable tile's top surface turns only that tile
// 90 degrees clockwise (seen from above) about its own vertical centre axis.

const MOVABLE_TILES = ['Tile_TopMiddle_Channel', 'Tile_Center_Channel', 'Tile_BottomMiddle_Channel'];
const TURN_SECONDS = 0.25; // length of one eased quarter turn
const TOP_Y = 0.17; // height of the tiles' grassy top surface (tile-local)
const HIT_HALF = 1.05; // half-size of a tile's top surface, the touch target
const TAP_MAX_TRAVEL = 0.04; // normalized screen travel above which a press is a drag, not a tap
const MAX_QUEUED = 2; // extra turns buffered while a tile is already turning
const QUARTER = Math.PI / 2;

interface TileState {
  entity: Entity;
  tx: TransformComponent;
  center: Vec3; // world position of the tile's centre (never changes)
  steps: number; // clockwise quarter turns from the authored "solved" heading, integer
  baseYaw: number; // yaw (radians) at steps = 0
  fromYaw: number;
  toYaw: number;
  t: number; // 0..1 progress of the current turn, 1 when idle
  queued: number;
}

@component()
export class TileRotator extends Component {
  @property() timeScale: number = 1;

  /** When true, taps no longer turn tiles (the level is solved). */
  locked: boolean = false;
  /** Called after every completed quarter turn, with each movable tile's turns from solved. */
  onTurnDone: Maybe<() => void> = null;

  private tiles: TileState[] = [];
  private startSteps: Map<string, number> = new Map();
  private downs: Map<number, Vec2> = new Map();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) return;
    for (const name of MOVABLE_TILES) {
      const e = this.findChild(this.entity, name);
      const tx = e?.getComponent(TransformComponent);
      if (e == null || tx == null) {
        console.log('[tiles] MISSING', name);
        continue;
      }
      const yaw = this.yawOf(tx.localRotation);
      // Authored start heading is a whole number of clockwise quarter turns off the solved one.
      const startSteps = ((Math.round(-yaw / QUARTER) % 4) + 4) % 4;
      const snapped = -startSteps * QUARTER;
      tx.localRotation = Quaternion.fromAxisAngle(Vec3.up, snapped);
      this.startSteps.set(name, startSteps);
      this.tiles.push({
        entity: e,
        tx,
        center: tx.worldPosition,
        steps: startSteps,
        baseYaw: 0,
        fromYaw: snapped,
        toYaw: snapped,
        t: 1,
        queued: 0,
      });
      console.log('[tiles] ready', name, 'start turns', startSteps);
    }
  }

  @subscribe(OnTouchInputStartedEvent, {execution: ExecuteOn.Everywhere})
  onTouchStart(p: TouchInputEventPayload): void {
    if (NetworkingService.get().isServerContext()) return;
    this.downs.set(p.interactionIndex, new Vec2(p.screenPosition.x, p.screenPosition.y));
  }

  @subscribe(OnTouchInputEndedEvent, {execution: ExecuteOn.Everywhere})
  onTouchEnd(p: TouchInputEventPayload): void {
    if (NetworkingService.get().isServerContext()) return;
    const down = this.downs.get(p.interactionIndex);
    this.downs.delete(p.interactionIndex);
    if (down != null) {
      const dx = p.screenPosition.x - down.x;
      const dy = p.screenPosition.y - down.y;
      if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_TRAVEL) return; // a drag, not a tap
    }
    if (this.locked) return; // the solved board stays still
    const tile = this.pick(p.worldRayOrigin, p.worldRayDirection);
    if (tile == null) return; // spring, flower, decorative tiles and empty sky ignore taps
    this.requestTurn(tile);
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(e: OnWorldUpdateEventPayload): void {
    if (NetworkingService.get().isServerContext()) return;
    const dt = e.deltaTime * this.timeScale;
    for (const s of this.tiles) {
      if (s.t >= 1) continue;
      s.t = Math.min(1, s.t + dt / TURN_SECONDS);
      const k = this.ease(s.t);
      const yaw = s.fromYaw + (s.toYaw - s.fromYaw) * k;
      s.tx.localRotation = Quaternion.fromAxisAngle(Vec3.up, yaw);
      if (s.t >= 1) {
        // land exactly on the grid heading, keeping angles bounded
        const exact = -(((s.steps % 4) + 4) % 4) * QUARTER;
        s.fromYaw = s.toYaw = exact;
        s.tx.localRotation = Quaternion.fromAxisAngle(Vec3.up, exact);
        console.log('[tiles] turned', s.entity.name, 'turns from solved', (4 - s.steps % 4) % 4);
        if (s.queued > 0 && !this.locked) {
          s.queued--;
          this.startTurn(s);
        } else {
          s.queued = 0;
        }
        this.onTurnDone?.();
      }
    }
  }

  /** Clockwise quarter turns from the solved heading of the named movable tile, or -1. */
  turnsOf(name: string): number {
    for (const s of this.tiles) if (s.entity.name === name) return ((s.steps % 4) + 4) % 4;
    return -1;
  }

  /** True while the named movable tile is mid-turn (its channel is not yet seated). */
  isTurning(name: string): boolean {
    for (const s of this.tiles) if (s.entity.name === name) return s.t < 1;
    return false;
  }

  /** True while any movable tile is still turning. */
  isBusy(): boolean {
    return this.tiles.some((s) => s.t < 1);
  }

  /** Snaps every movable tile back to its authored broken start heading and unlocks taps. */
  resetTiles(): void {
    for (const s of this.tiles) {
      const steps = this.startSteps.get(s.entity.name) ?? 0;
      s.steps = steps;
      s.queued = 0;
      s.t = 1;
      s.fromYaw = s.toYaw = -steps * QUARTER;
      s.tx.localRotation = Quaternion.fromAxisAngle(Vec3.up, s.fromYaw);
    }
    this.locked = false;
  }

  /** Turns a tile one quarter clockwise; a tap during a turn is queued, never overlapped. */
  requestTurn(s: TileState): void {
    if (this.locked) return;
    if (s.t < 1) {
      if (s.queued < MAX_QUEUED) s.queued++;
      return;
    }
    this.startTurn(s);
  }

  private startTurn(s: TileState): void {
    s.steps = (s.steps + 1) % 4;
    s.toYaw = s.fromYaw - QUARTER; // negative yaw about +Y is clockwise seen from above
    s.t = 0;
  }

  /** Intersects the tap ray with the tiles' top plane and returns the movable tile under it. */
  private pick(origin: Vec3, dir: Vec3): Maybe<TileState> {
    if (Math.abs(dir.y) < 1e-4) return null;
    for (const s of this.tiles) {
      const planeY = s.center.y + TOP_Y;
      const d = (planeY - origin.y) / dir.y;
      if (d <= 0) continue;
      const hx = origin.x + dir.x * d - s.center.x;
      const hz = origin.z + dir.z * d - s.center.z;
      if (Math.abs(hx) <= HIT_HALF && Math.abs(hz) <= HIT_HALF) return s;
    }
    return null;
  }

  private ease(t: number): number {
    // gentle ease-in-out with a soft settle
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  private yawOf(q: Quaternion): number {
    // tiles only ever turn about +Y, so the yaw is twice the half-angle of the quaternion
    return 2 * Math.atan2(q.y, q.w);
  }

  private findChild(root: Entity, name: string): Maybe<Entity> {
    for (const c of root.getChildren()) {
      if (c.name === name) return c;
      const deep = this.findChild(c, name);
      if (deep != null) return deep;
    }
    return null;
  }
}
