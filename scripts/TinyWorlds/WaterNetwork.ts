import {
  Color,
  ColorComponent,
  Component,
  ExecuteOn,
  MeshComponent,
  NetworkingService,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  PointLightComponent,
  Quaternion,
  TransformComponent,
  Vec3,
  component,
  property,
  subscribe,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';
import {TileRotator} from './TileRotator';

// Magical water connectivity for Level 01: the spring always flows; water passes from a tile
// to its neighbour only where both channel openings face each other. Re-checked after every
// completed quarter turn. Reaching the flower solves the level.

// Directions: 0 north (-Z), 1 east (+X), 2 south (+Z), 3 west (-X). A clockwise quarter turn adds 1.
const DX = [0, 1, 0, -1];
const DZ = [-1, 0, 1, 0];

interface CellDef {
  name: string;
  col: number;
  row: number;
  openings: number[]; // openings at the solved heading
  movable: boolean;
}

const CELLS: CellDef[] = [
  {name: 'Tile_TopLeft_Spring', col: 0, row: 0, openings: [1], movable: false},
  {name: 'Tile_TopMiddle_Channel', col: 1, row: 0, openings: [3, 2], movable: true},
  {name: 'Tile_Center_Channel', col: 1, row: 1, openings: [0, 2], movable: true},
  {name: 'Tile_BottomMiddle_Channel', col: 1, row: 2, openings: [0, 1], movable: true},
  {name: 'Tile_BottomRight_Flower', col: 2, row: 2, openings: [3], movable: false},
  // the four decorative tiles carry no channel, so water never passes through them
];
const SPRING = 'Tile_TopLeft_Spring';
const FLOWER = 'Tile_BottomRight_Flower';

// Water presentation: each connected channel shows one calm continuous water surface (its pieces are
// always shown together, one tint) and small glowing droplets that glide along the channel's real
// centreline, round bends, from the edge water entered through toward the flower.
// Arrival: the water surface starts below the channel bed and rises behind a soft front that runs from
// the entry edge along the channel's real path; each surface piece tilts to the local slope of the
// water, so the shoreline where water meets the dry bed glides continuously (no pieces popping on).
const FILL_SECONDS = 0.65; // seconds for a main channel to fill (stubs scale with their length)
const DRAIN_SECONDS = 0.6; // seconds for a main channel to drain back toward its entry edge
const REF_LEN = 1.9; // metres of travel that take FILL_SECONDS / DRAIN_SECONDS
const RAMP = 0.38; // metres behind the front over which the water rises to its full level
const SINK = 0.034; // metres below its rest level the surface starts (rest 0.034, bed 0.012)
const HIDE_BELOW = -0.026; // a surface piece wholly lower than this is under the bed and hidden
const DROP_LAG = 0.2; // metres behind the front where droplets begin
const DROP_SPEED = 0.55; // metres per second droplets glide downstream
const FRONT_SOFT = 0.22; // metres over which droplets fade in at the wave front
const WAVE_LEN = 0.45; // metres behind the front where arriving droplets swell and glow
const SURF_RATE = 3.5; // 1/s easing of the surface tint toward its target
const DROP_Y = 0.055; // droplet height above the flow model origin (water surface 0.034)
const DROP_SCALE = 0.62; // base droplet scale
const DROP_COUNTS: Record<string, number> = {
  Tile_TopLeft_Spring: 3,
  Tile_TopMiddle_Channel: 8,
  Tile_Center_Channel: 10,
  Tile_BottomMiddle_Channel: 8,
  Tile_BottomRight_Flower: 3,
};
const GLOW_SECONDS = 0.8; // golden glow swell on solve
const GLOW_LIGHT = 5; // point light intensity at full glow

const E = 0.985;
function arcPath(): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI / 2 - (Math.PI / 2) * (i / 24);
    pts.push([-1 + Math.cos(a), 1 - Math.sin(a)]);
  }
  pts[0] = [-E, 0];
  pts[pts.length - 1] = [0, E];
  return pts;
}
// Channel centrelines in each flow model's local x,z (the same paths the channel meshes were built on).
const PATHS: Record<string, [number, number][]> = {
  Tile_TopLeft_Spring: [[0.38, 0], [E, 0]],
  Tile_TopMiddle_Channel: arcPath(),
  Tile_Center_Channel: [[0, -E], [0, E]],
  Tile_BottomMiddle_Channel: arcPath(),
  Tile_BottomRight_Flower: [[-E, 0], [-0.5, 0]],
};

class PathLine {
  pts: [number, number][];
  cum: number[] = [0];
  len = 0;
  constructor(pts: [number, number][]) {
    this.pts = pts;
    for (let i = 1; i < pts.length; i++) {
      this.len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      this.cum.push(this.len);
    }
  }
  /** Point and unit tangent at distance d from the path start. */
  sample(d: number): {x: number; z: number; tx: number; tz: number} {
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    const seg = this.cum[i] - this.cum[i - 1];
    const t = seg > 0 ? Math.min(1, Math.max(0, (d - this.cum[i - 1]) / seg)) : 0;
    return {x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / seg, tz: (b[1] - a[1]) / seg};
  }
}

interface Drop {
  tx: Maybe<TransformComponent>;
  mesh: Maybe<MeshComponent>;
  phase: number; // 0..1 starting spot along the channel
  size: number;
  lateral: number;
  twinkle: number;
  speed: number;
  shown: boolean;
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Shared hooks between the board and the level HUD (same client). */
export const levelBus = {
  setSolved: null as Maybe<(solved: boolean) => void>,
  restart: null as Maybe<() => void>,
  /** Flower awakening cinematic; when present it owns the glow and shows the banner itself. */
  awaken: null as Maybe<() => void>,
  resetAwaken: null as Maybe<() => void>,
};

interface Seg {
  mesh: Maybe<MeshComponent>;
  color: Maybe<ColorComponent>;
  tx: Maybe<TransformComponent>;
  shown: boolean;
  restPos: Vec3; // rest placement in the flow model's frame
  restRot: Quaternion;
  s0: number; // start and end of this piece along the path (from the path start)
  s1: number;
}

/** Water level offset (m, <= 0) at distance u behind the front, and its slope d/du. */
function level(u: number): {h: number; dh: number} {
  if (u <= 0) return {h: -SINK, dh: 0};
  if (u >= RAMP) return {h: 0, dh: 0};
  const t = u / RAMP;
  return {h: -SINK * (1 - t * t * (3 - 2 * t)), dh: (SINK * 6 * t * (1 - t)) / RAMP};
}

interface FlowState {
  def: CellDef;
  flow: Maybe<Entity>;
  tx: Maybe<TransformComponent>;
  segs: Seg[];
  path: PathLine;
  drops: Drop[];
  active: boolean;
  front: number; // metres along the flow the water front has reached, 0..path.len + RAMP
  wantForward: boolean; // direction the connection asks for; applied once the channel has drained
  settled: boolean; // surface pieces already at rest (full) or hidden (dry)
  surf: number; // surface tint 0 dry .. 1 full magical water
  surfShown: boolean;
  forward: boolean; // water runs from the path start toward its end
  parent: Maybe<FlowState>; // the channel feeding this one
  offset: number; // metres upstream, so the shimmer runs continuously down the route
}

@component()
export class WaterNetwork extends Component {
  @property() timeScale: number = 1;

  private rotator: Maybe<TileRotator> = null;
  private cells: FlowState[] = [];
  private solved = false;
  private time = 0;
  private glowT = 0;
  private glowMesh: Maybe<MeshComponent> = null;
  private glowTx: Maybe<TransformComponent> = null;
  private glowColor: Maybe<ColorComponent> = null;
  private light: Maybe<PointLightComponent> = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) return;
    this.rotator = this.entity.getComponent(TileRotator);
    const pool = this.collectDrops();
    let next = 0;
    let rnd = 7;
    const rand = (): number => {
      rnd = (rnd * 16807) % 2147483647;
      return rnd / 2147483647;
    };
    CELLS.forEach((def) => {
      const tile = this.find(this.entity, def.name);
      const flow = tile != null ? this.find(tile, 'Flow_1') : null;
      if (flow == null) console.log('[water] MISSING flow on', def.name);
      const segs: Seg[] = [];
      if (flow != null) this.collectSegs(flow, segs, new PathLine(PATHS[def.name]).len);
      const drops: Drop[] = [];
      const k = DROP_COUNTS[def.name];
      for (let i = 0; i < k && next < pool.length; i++, next++) {
        const e = pool[next];
        drops.push({
          tx: e.getComponent(TransformComponent),
          mesh: e.getComponent(MeshComponent),
          phase: (i + 0.15 + rand() * 0.6) / k, // uneven spacing
          size: 0.7 + rand() * 0.6,
          lateral: (rand() - 0.5) * 0.16,
          twinkle: rand() * Math.PI * 2,
          speed: DROP_SPEED * (0.92 + rand() * 0.16),
          shown: true,
        });
      }
      console.log('[water] channel', def.name, 'segments', segs.length, 'droplets', drops.length);
      this.cells.push({
        def,
        flow,
        tx: flow?.getComponent(TransformComponent) ?? null,
        segs,
        path: new PathLine(PATHS[def.name]),
        drops,
        active: false,
        front: 0,
        wantForward: true,
        settled: false,
        surf: 0,
        surfShown: true,
        forward: true,
        parent: null,
        offset: 0,
      });
    });
    const glow = this.find(this.entity, 'GoldenGlow_1');
    this.glowMesh = glow?.getComponent(MeshComponent) ?? null;
    this.glowTx = glow?.getComponent(TransformComponent) ?? null;
    this.glowColor = glow?.getComponent(ColorComponent) ?? null;
    this.light = this.find(this.entity, 'FlowerGlowLight')?.getComponent(PointLightComponent) ?? null;
    this.applyGlow(0);
    for (const c of this.cells) this.dryAll(c);
    if (this.rotator != null) this.rotator.onTurnDone = () => this.evaluate();
    levelBus.restart = () => this.restart();
    this.evaluate();
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(e: OnWorldUpdateEventPayload): void {
    if (NetworkingService.get().isServerContext()) return;
    const dt = e.deltaTime * this.timeScale;
    this.time += dt;
    for (const c of this.cells) this.animate(c, dt);
    if (this.solved && levelBus.awaken != null) return;
    if (this.solved && this.glowT < 1) this.glowT = Math.min(1, this.glowT + dt / GLOW_SECONDS);
    if (this.solved) this.applyGlow(this.glowT);
  }

  /** Recomputes which channels the spring reaches; turning tiles count as closed until seated. */
  evaluate(): void {
    const byPos = new Map<string, {cell: FlowState; open: number[]}>();
    for (const c of this.cells) {
      let open = c.def.openings;
      if (c.def.movable && this.rotator != null) {
        if (this.rotator.isTurning(c.def.name)) open = [];
        else {
          const turns = this.rotator.turnsOf(c.def.name);
          open = c.def.openings.map((d) => (d + Math.max(0, turns)) % 4);
        }
      }
      byPos.set(c.def.col + ',' + c.def.row, {cell: c, open});
    }
    const reached = new Set<string>([SPRING]);
    const entry = new Map<string, {side: number; parent: FlowState}>();
    const queue = [byPos.get('0,0')!];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const d of cur.open) {
        const next = byPos.get(cur.cell.def.col + DX[d] + ',' + (cur.cell.def.row + DZ[d]));
        if (next == null || reached.has(next.cell.def.name)) continue;
        if (!next.open.includes((d + 2) % 4)) continue; // openings must face each other
        reached.add(next.cell.def.name);
        entry.set(next.cell.def.name, {side: (d + 2) % 4, parent: cur.cell});
        queue.push(next);
      }
    }
    for (const c of this.cells) {
      const e = entry.get(c.def.name);
      this.setActive(c, reached.has(c.def.name), e?.side ?? -1, e?.parent ?? null);
    }
    console.log('[water] wet:', [...reached].join(' '));
    if (!this.solved && reached.has(FLOWER)) this.solve();
  }

  private solve(): void {
    this.solved = true;
    this.glowT = 0;
    if (this.rotator != null) this.rotator.locked = true;
    if (levelBus.awaken != null) {
      levelBus.awaken(); // the flower wakes first; it shows the banner when done
      console.log('[water] Garden Restored! (awakening)');
      return;
    }
    if (this.glowMesh != null) this.glowMesh.isVisibleSelf = true;
    levelBus.setSolved?.(true);
    console.log('[water] Garden Restored!');
  }

  /** Back to the broken start: tiles, water, glow and message. */
  restart(): void {
    this.solved = false;
    this.glowT = 0;
    this.applyGlow(0);
    this.rotator?.resetTiles();
    for (const c of this.cells) {
      c.active = false;
      this.dryAll(c);
    }
    levelBus.resetAwaken?.();
    levelBus.setSolved?.(false);
    console.log('[water] restart');
    this.evaluate();
  }

  private setActive(c: FlowState, on: boolean, side: number, parent: Maybe<FlowState>): void {
    if (on) {
      // the spring flows outward from its pool; others flow from the edge water entered through
      const s0 = PATHS[c.def.name][0];
      const fwd = c.def.name === SPRING || this.sideOf(c, new Vec3(s0[0], 0, s0[1])) === side;
      if (c.active && fwd === c.wantForward) return;
      c.wantForward = fwd;
      if (c.front <= 0) c.forward = fwd; // otherwise it drains first, then refills the new way
      c.parent = parent;
      c.offset = parent != null ? parent.offset + parent.path.len : 0;
    }
    c.active = on;
  }

  /** World grid side (0 N, 1 E, 2 S, 3 W) that a point of the channel model lies toward. */
  private sideOf(c: FlowState, local: Vec3): number {
    if (c.tx == null) return -1;
    const v = c.tx.worldRotation.mulVec3(local);
    if (Math.abs(v.x) > Math.abs(v.z)) return v.x > 0 ? 1 : 3;
    return v.z < 0 ? 0 : 2;
  }

  private animate(c: FlowState, dt: number): void {
    const len = c.path.len;
    const full = len + RAMP;
    const flowing = c.active && c.forward === c.wantForward;
    const before = c.front;
    if (flowing) {
      // water enters a channel only once the front feeding it has reached its far edge;
      // it runs in briskly and slows gently as the channel finishes filling
      const fed = c.parent == null || c.parent.front >= c.parent.path.len;
      if (fed && c.front < full) {
        const v = (REF_LEN / FILL_SECONDS) * (1.45 - 0.9 * (c.front / full));
        c.front = Math.min(full, c.front + dt * v);
      }
    } else if (c.front > 0) {
      // drains back toward its entry edge, easing out as the last water leaves
      const v = (REF_LEN / DRAIN_SECONDS) * (0.55 + 0.9 * (c.front / full));
      c.front = Math.max(0, c.front - dt * v);
      if (c.front <= 0) c.forward = c.wantForward;
    }
    if (c.front !== before) c.settled = false;
    this.placeSurface(c);
    // tint eases from a softer blue at first arrival to full magical turquoise
    const target = c.front > 0 ? 0.55 + 0.45 * smooth01(c.front / full) : 0;
    c.surf += (target - c.surf) * (1 - Math.exp(-SURF_RATE * dt));
    const wantSurf = c.front > 0;
    c.surfShown = wantSurf;
    if (wantSurf) {
      const k = c.surf;
      const sh = 0.05 * Math.sin(this.time * 1.7 - c.offset * 2.2);
      const col = new Color(0.32 + (0.95 - 0.32) * k + sh, 0.42 + (0.98 - 0.42) * k + sh, 0.55 + (1.0 - 0.55) * k + sh, 1);
      for (const seg of c.segs) if (seg.color != null) seg.color.color = col;
    }
    if (c.tx == null) return;
    const pos = c.tx.worldPosition;
    const rot = c.tx.worldRotation;
    const filling = flowing && c.front < full;
    for (const d of c.drops) {
      // distance travelled along the flow, wrapping so the stream is endless
      let dist = (d.phase * len + this.time * d.speed) % len;
      if (dist < 0) dist += len;
      let w = smooth01((c.front - DROP_LAG - dist) / FRONT_SOFT);
      if (w <= 0.01) {
        if (d.shown) {
          d.shown = false;
          if (d.mesh != null) d.mesh.isVisibleSelf = false;
        }
        continue;
      }
      if (!d.shown) {
        d.shown = true;
        if (d.mesh != null) d.mesh.isVisibleSelf = true;
      }
      const pd = c.forward ? dist : len - dist;
      const p = c.path.sample(pd);
      const dir = c.forward ? 1 : -1;
      const tx = p.tx * dir;
      const tz = p.tz * dir;
      const lx = p.x - tz * d.lateral;
      const lz = p.z + tx * d.lateral;
      // swell and brighten just behind the arriving wave front
      const behind = c.front - DROP_LAG - dist;
      const wave = filling && behind < WAVE_LEN ? 1 - behind / WAVE_LEN : 0;
      const lv = level(c.front - dist).h; // droplets ride the rising or lowering water
      const tw = 0.85 + 0.15 * Math.sin(this.time * 5.3 + d.twinkle);
      const s = DROP_SCALE * d.size * tw * w * (1 + 0.7 * wave);
      const bob = 0.006 * Math.sin(this.time * 4 + d.twinkle);
      const world = rot.mulVec3(new Vec3(lx, DROP_Y + lv + bob, lz));
      if (d.tx != null) {
        d.tx.worldPosition = new Vec3(pos.x + world.x, pos.y + world.y, pos.z + world.z);
        d.tx.worldRotation = rot.mul(Quaternion.lookRotation(new Vec3(tx, 0, tz), Vec3.up));
        d.tx.localScale = new Vec3(s, s, s * (1 + 0.25 * wave));
      }
    }
  }

  /** Dry at once: surface hidden, droplets hidden, wave front back at the entry edge. */
  private dryAll(c: FlowState): void {
    c.front = 0;
    c.surf = 0;
    c.surfShown = false;
    c.forward = c.wantForward;
    c.settled = false;
    this.placeSurface(c);
    for (const d of c.drops) {
      d.shown = false;
      if (d.mesh != null) d.mesh.isVisibleSelf = false;
    }
  }

  private collectDrops(): Entity[] {
    const group = this.find(this.entity, 'Droplets');
    const out: {idx: number; e: Entity}[] = [];
    if (group != null) {
      for (const ch of group.getChildren()) {
        const m = /Drop_(\d+)/.exec(ch.name);
        if (m != null) out.push({idx: parseInt(m[1], 10), e: ch});
      }
    }
    out.sort((p, q) => p.idx - q.idx);
    console.log('[water] droplet pool', out.length);
    return out.map((o) => o.e);
  }

  private collectSegs(root: Entity, out: Seg[], len: number): void {
    const flowTx = root.getComponent(TransformComponent);
    const inv = flowTx != null ? flowTx.worldRotation.inverse() : Quaternion.identity;
    const org = flowTx != null ? flowTx.worldPosition : Vec3.zero;
    const found: {idx: number; seg: Seg}[] = [];
    const walk = (e: Entity): void => {
      for (const ch of e.getChildren()) {
        const m = /Seg_(\d+)/.exec(ch.name);
        const mesh = ch.getComponent(MeshComponent);
        if (m != null && mesh != null) {
          const tx = ch.getComponent(TransformComponent);
          const wp = tx != null ? tx.worldPosition : org;
          const wr = tx != null ? tx.worldRotation : Quaternion.identity;
          found.push({
            idx: parseInt(m[1], 10),
            seg: {
              mesh,
              color: ch.getComponent(ColorComponent),
              tx,
              shown: true,
              restPos: inv.mulVec3(new Vec3(wp.x - org.x, wp.y - org.y, wp.z - org.z)),
              restRot: inv.mul(wr),
              s0: 0,
              s1: 0,
            },
          });
        }
        walk(ch);
      }
    };
    walk(root);
    found.sort((p, q) => p.idx - q.idx);
    const n = found.length;
    found.forEach((f, i) => {
      f.seg.s0 = (i / n) * len;
      f.seg.s1 = ((i + 1) / n) * len;
      out.push(f.seg);
    });
  }

  /**
   * Places each surface piece on the water profile: lifted to the level the water has reached there
   * and tilted to its slope along the flow, so neighbouring pieces meet in one smooth sheet whose
   * shoreline with the dry bed moves continuously. Pieces wholly under the bed are hidden.
   */
  private placeSurface(c: FlowState): void {
    if (c.settled || c.tx == null) return;
    const full = c.path.len + RAMP;
    const atRest = c.front >= full;
    const dry = c.front <= 0;
    const fp = c.tx.worldPosition;
    const fr = c.tx.worldRotation;
    for (const seg of c.segs) {
      let show = !dry;
      let pos = seg.restPos;
      let rot = seg.restRot;
      if (!dry && !atRest) {
        const sm = (seg.s0 + seg.s1) / 2;
        const half = (seg.s1 - seg.s0) / 2;
        // distance along the flow from the entry edge, and the flow-direction tangent
        const along = c.forward ? sm : c.path.len - sm;
        const p = c.path.sample(sm);
        const dir = c.forward ? 1 : -1;
        const tx = p.tx * dir;
        const tz = p.tz * dir;
        const lv = level(c.front - along);
        const slope = -lv.dh; // the water dips toward the front, downstream
        show = lv.h + Math.abs(slope) * half > HIDE_BELOW;
        if (show) {
          const pivot = new Vec3(p.x, 0.034, p.z);
          const r = Quaternion.fromAxisAngle(new Vec3(-tz, 0, tx), Math.atan(slope));
          const rel = r.mulVec3(new Vec3(seg.restPos.x - pivot.x, seg.restPos.y - pivot.y, seg.restPos.z - pivot.z));
          pos = new Vec3(pivot.x + rel.x, pivot.y + rel.y + lv.h, pivot.z + rel.z);
          rot = r.mul(seg.restRot);
        }
      }
      if (show !== seg.shown) {
        seg.shown = show;
        if (seg.mesh != null) seg.mesh.isVisibleSelf = show;
      }
      if (show && seg.tx != null) {
        const w = fr.mulVec3(pos);
        seg.tx.worldPosition = new Vec3(fp.x + w.x, fp.y + w.y, fp.z + w.z);
        seg.tx.worldRotation = fr.mul(rot);
      }
    }
    if (atRest || dry) c.settled = true;
  }

  private applyGlow(k: number): void {
    const e = 1 - Math.pow(1 - k, 3);
    const pulse = k >= 1 ? 0.06 * Math.sin(this.time * 2.2) : 0;
    if (this.glowMesh != null) this.glowMesh.isVisibleSelf = k > 0;
    if (this.glowTx != null) {
      const s = Math.max(0.01, 0.75 * (e * (1 + 0.25 * Math.sin(Math.PI * k)) + pulse));
      this.glowTx.localScale = new Vec3(s, s, s);
    }
    if (this.glowColor != null) this.glowColor.color = new Color(1, 0.9 + pulse, 0.75 + pulse, 1);
    if (this.light != null) this.light.intensity = GLOW_LIGHT * e * (1 + pulse * 2);
  }

  private find(root: Entity, name: string): Maybe<Entity> {
    for (const c of root.getChildren()) {
      if (c.name === name) return c;
      const deep = this.find(c, name);
      if (deep != null) return deep;
    }
    return null;
  }
}
