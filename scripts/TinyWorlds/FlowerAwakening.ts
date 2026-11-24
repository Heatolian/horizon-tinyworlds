import {
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
import {levelBus} from './WaterNetwork';

// Flower awakening: ~3 s cinematic that plays once per solve, then hands over to the
// "Garden Restored!" banner. The sleeping bud is the original flower model; at 0.5 s it is
// swapped for the code-built Bloom flower whose petals move one by one.

// ---- timeline (seconds) ----
const SWAP_AT = 0.5; // sleeping bud -> petal flower
const PETAL_START = 0.52;
const PETAL_STAGGER = 0.07; // between petals, outer ring first
const INNER_DELAY = 0.18;
const PETAL_DUR = 0.8;
const STEM_GROW = [0.55, 1.6];
const WORLD_START = 1.6; // plants, stones, spores
const WAVE = [1.7, 2.6];
const BRIGHT = [1.9, 3.0];
const BANNER_AT = 2.7; // banner starts its soft fade-in
const IDLE_AT = 2.9;

// ---- shape ----
const HEAD_Y = 0.5;
const HEAD_SCALE = 1.18;
const STEM_STRETCH = 1.35; // stem height multiplier when awake
const OUTER_CLOSED = 0.06; // radians (positive tips inward)
const OUTER_OPEN = -1.2;
const INNER_CLOSED = 0.02;
const INNER_OPEN = -0.72;
const GLOW_LIGHT_WARM = 1.4; // faint glow inside the bud in phase one
const GLOW_LIGHT_FULL = 5;
const AMBIENCE_LIGHT = 3;
const STONE_RISE = 0.45;
const STONE_SETTLE = 0.22;
const STONES = ['FloatStone_2', 'FloatStone_6', 'FloatStone_3'];
const PLANT_TILES: {[tile: string]: string[]} = {
  Tile_BottomRight_Flower: ['Mushrooms_1', 'GrassTuft_1'],
  Tile_MiddleRight_Land: ['Succulent_1', 'CurlPlant_1', 'Mushrooms_1', 'GrassTuft_1'],
  Tile_BottomLeft_Land: ['CurlPlant_1', 'Succulent_1', 'Mushrooms_1', 'GrassTuft_1'],
  Tile_BottomMiddle_Channel: ['GrassTuft_1', 'GrassTuft_2'],
  Tile_Center_Channel: ['GrassTuft_1', 'GrassTuft_2'],
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const easeOutBack = (x: number): number => {
  const t = clamp01(x);
  const c = 1.4;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const bump = (x: number): number => (x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x));
const span = (t: number, r: number[]): number => clamp01((t - r[0]) / (r[1] - r[0]));

interface Petal {
  tx: TransformComponent;
  yaw: number;
  closed: number;
  open: number;
  start: number;
}
interface Plant {
  tx: TransformComponent;
  pos: Vec3;
  rot: Quaternion;
  scale: Vec3;
  delay: number;
  phase: number;
}
interface Stone {
  tx: TransformComponent;
  pos: Vec3;
  delay: number;
}
interface Spore {
  tx: TransformComponent;
  mesh: MeshComponent[];
  start: number;
  angle: number;
  radius: number;
  speed: number;
}

@component()
export class FlowerAwakening extends Component {
  @property() timeScale: number = 1;

  private playing = false;
  private t = 0;
  private bannerShown = false;
  private sleepTx: Maybe<TransformComponent> = null;
  private sleepRot = Quaternion.identity;
  private sleepMeshes: MeshComponent[] = [];
  private bloomMeshes: MeshComponent[] = [];
  private headTx: Maybe<TransformComponent> = null;
  private stemTx: Maybe<TransformComponent> = null;
  private centerTx: Maybe<TransformComponent> = null;
  private petals: Petal[] = [];
  private plants: Plant[] = [];
  private stones: Stone[] = [];
  private spores: Spore[] = [];
  private waveTx: Maybe<TransformComponent> = null;
  private waveMesh: MeshComponent[] = [];
  private pulseTx: Maybe<TransformComponent> = null;
  private pulseMesh: MeshComponent[] = [];
  private stemLightTx: Maybe<TransformComponent> = null;
  private stemLightMesh: MeshComponent[] = [];
  private glowTx: Maybe<TransformComponent> = null;
  private glowMesh: MeshComponent[] = [];
  private glowLight: Maybe<PointLightComponent> = null;
  private glowLightTx: Maybe<TransformComponent> = null;
  private ambience: Maybe<PointLightComponent> = null;
  private flowerTile: Maybe<Entity> = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) return;
    const tile = this.find(this.entity, 'Tile_BottomRight_Flower');
    this.flowerTile = tile;
    if (tile == null) {
      console.log('[bloom] MISSING flower tile');
      return;
    }
    const sleep = this.find(tile, 'SleepingFlower_1');
    this.sleepTx = sleep?.getComponent(TransformComponent) ?? null;
    if (this.sleepTx != null) this.sleepRot = this.sleepTx.localRotation;
    if (sleep != null) this.meshes(sleep, this.sleepMeshes);
    const bloom = this.find(tile, 'Bloom');
    if (bloom != null) this.meshes(bloom, this.bloomMeshes);
    const head = this.find(tile, 'BloomHead');
    this.headTx = head?.getComponent(TransformComponent) ?? null;
    this.stemTx = this.tx(tile, 'BloomStem_1');
    this.centerTx = this.tx(tile, 'BloomCenter_1');
    for (let i = 1; i <= 6; i++) {
      const p = this.tx(tile, 'PetalOuter_' + i);
      if (p != null) {
        this.petals.push({tx: p, yaw: ((i - 1) * Math.PI) / 3, closed: OUTER_CLOSED, open: OUTER_OPEN, start: PETAL_START + (i - 1) * PETAL_STAGGER});
      }
    }
    for (let i = 1; i <= 5; i++) {
      const p = this.tx(tile, 'PetalInner_' + i);
      if (p != null) {
        this.petals.push({tx: p, yaw: ((i - 0.5) * 2 * Math.PI) / 5, closed: INNER_CLOSED, open: INNER_OPEN, start: PETAL_START + INNER_DELAY + (i - 1) * PETAL_STAGGER});
      }
    }
    for (let i = 1; i <= 4; i++) {
      const l = this.tx(tile, 'BloomLeaf_' + i);
      if (l != null) {
        l.localPosition = new Vec3(0, 0.02, 0);
        l.localRotation = Quaternion.fromAxisAngle(Vec3.up, Math.PI / 4 + ((i - 1) * Math.PI) / 2 + (i % 2) * 0.2);
        l.localScale = new Vec3(1.15, 1.15, 1.15);
      }
    }
    console.log('[rig] Bloom', this.petals.length + '/11 petals', this.headTx != null && this.stemTx != null && this.centerTx != null ? 'ok' : 'MISSING');

    // nearby plants respond in order of distance from the flower
    const fp = tile.getComponent(TransformComponent)!.worldPosition;
    let k = 0;
    for (const tileName of Object.keys(PLANT_TILES)) {
      const tEnt = this.find(this.entity, tileName);
      if (tEnt == null) continue;
      for (const n of PLANT_TILES[tileName]) {
        const e = tEnt.getChildren().find((c) => c.name === n);
        const ptx = e?.getComponent(TransformComponent);
        if (ptx == null) continue;
        const wp = ptx.worldPosition;
        const d = Math.hypot(wp.x - fp.x, wp.z - fp.z);
        this.plants.push({tx: ptx, pos: ptx.localPosition, rot: ptx.localRotation, scale: ptx.localScale, delay: d * 0.09, phase: k++ * 1.7});
      }
    }
    STONES.forEach((n, i) => {
      const s = this.tx(this.entity, n);
      if (s != null) this.stones.push({tx: s, pos: s.localPosition, delay: i * 0.18});
    });
    for (let i = 1; i <= 9; i++) {
      const e = this.find(tile, 'Spore_' + i);
      const stx = e?.getComponent(TransformComponent);
      if (e == null || stx == null) continue;
      const m: MeshComponent[] = [];
      this.meshes(e, m);
      this.spores.push({tx: stx, mesh: m, start: WORLD_START + i * 0.11, angle: i * 2.4, radius: 0.25 + (i % 3) * 0.17, speed: 0.55 + (i % 4) * 0.08});
    }
    this.waveTx = this.fx(tile, 'LightWave_1', this.waveMesh);
    this.pulseTx = this.fx(tile, 'PulseRing_1', this.pulseMesh);
    this.stemLightTx = this.fx(tile, 'StemLight_1', this.stemLightMesh);
    this.glowTx = this.fx(tile, 'GoldenGlow_1', this.glowMesh);
    const gl = this.find(tile, 'FlowerGlowLight');
    this.glowLight = gl?.getComponent(PointLightComponent) ?? null;
    this.glowLightTx = gl?.getComponent(TransformComponent) ?? null;
    this.ambience = this.find(this.entity, 'BloomAmbience')?.getComponent(PointLightComponent) ?? null;
    this.reset();
    levelBus.awaken = () => this.awaken();
    levelBus.resetAwaken = () => this.reset();
  }

  /** Starts the cinematic once per solve. */
  awaken(): void {
    if (this.playing) return;
    this.playing = true;
    this.t = 0;
    this.bannerShown = false;
    console.log('[bloom] awakening starts');
  }

  /** Back to the sleeping bud with every awakened effect cleared. */
  reset(): void {
    this.playing = false;
    this.t = 0;
    this.bannerShown = false;
    this.show(this.sleepMeshes, true);
    this.show(this.bloomMeshes, false);
    if (this.sleepTx != null) this.sleepTx.localRotation = this.sleepRot;
    this.poseFlower(0, 0);
    for (const p of this.plants) {
      p.tx.localPosition = p.pos;
      p.tx.localRotation = p.rot;
      p.tx.localScale = p.scale;
    }
    for (const s of this.stones) s.tx.localPosition = s.pos;
    for (const s of this.spores) this.show(s.mesh, false);
    this.show(this.waveMesh, false);
    this.show(this.pulseMesh, false);
    this.show(this.stemLightMesh, false);
    this.show(this.glowMesh, false);
    if (this.glowLight != null) this.glowLight.intensity = 0;
    if (this.ambience != null) this.ambience.intensity = 0;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(e: OnWorldUpdateEventPayload): void {
    if (!this.playing) return;
    this.t += e.deltaTime * this.timeScale;
    const t = this.t;
    this.phaseOne(t);
    if (t >= SWAP_AT) this.poseFlower(t, 1);
    this.world(t);
    if (!this.bannerShown && t >= BANNER_AT) {
      this.bannerShown = true;
      levelBus.setSolved?.(true);
      console.log('[bloom] Garden Restored banner at', t.toFixed(2));
    }
  }

  // 0-0.5 s: cyan pulse at the base, light climbs the stem, bud trembles, warm glow inside
  private phaseOne(t: number): void {
    const base = this.flowerBase();
    if (this.pulseTx != null) {
      const k = clamp01(t / 0.32);
      this.show(this.pulseMesh, t < 0.34);
      const r = 1.1 - 0.95 * smooth(k);
      this.pulseTx.worldPosition = new Vec3(base.x, base.y + 0.03, base.z);
      this.pulseTx.localScale = new Vec3(r, 1 + 2 * bump(k), r);
    }
    if (this.stemLightTx != null) {
      const k = clamp01((t - 0.15) / 0.38);
      this.show(this.stemLightMesh, t > 0.15 && t < 0.56);
      const s = 1.6 - 0.7 * k;
      this.stemLightTx.worldPosition = new Vec3(base.x, base.y + 0.05 + 1.0 * smooth(k), base.z);
      this.stemLightTx.localScale = new Vec3(s, s, s);
    }
    if (t < SWAP_AT && this.sleepTx != null) {
      const env = smooth(t / 0.25) * (0.6 + 0.4 * (t / SWAP_AT));
      const w = Quaternion.fromAxisAngle(new Vec3(1, 0, 0), 0.045 * env * Math.sin(t * 38)).mul(Quaternion.fromAxisAngle(new Vec3(0, 0, 1), 0.035 * env * Math.sin(t * 29 + 1)));
      this.sleepTx.localRotation = w.mul(this.sleepRot);
    }
    if (this.glowLight != null && t < SWAP_AT) this.glowLight.intensity = GLOW_LIGHT_WARM * smooth((t - 0.2) / 0.3);
    if (t >= SWAP_AT && this.sleepMeshes.length > 0 && this.sleepMeshes[0].isVisibleSelf) {
      this.show(this.sleepMeshes, false);
      this.show(this.bloomMeshes, true);
      this.show(this.glowMesh, true);
    }
  }

  // 0.5 s on: petals unfold one by one with a settling bounce; stem grows; center glows; idle sway
  private poseFlower(t: number, on: number): void {
    const grow = on * smooth(span(t, STEM_GROW));
    if (this.stemTx != null) this.stemTx.localScale = new Vec3(1, 1 + (STEM_STRETCH - 1) * grow, 1);
    const idle = on * smooth((t - IDLE_AT) / 0.6);
    if (this.headTx != null) {
      this.headTx.localPosition = new Vec3(0, HEAD_Y * (1 + (STEM_STRETCH - 1) * grow), 0);
      const sway = Quaternion.fromAxisAngle(new Vec3(0, 0, 1), idle * 0.045 * Math.sin(t * 1.4)).mul(
        Quaternion.fromAxisAngle(new Vec3(1, 0, 0), idle * 0.03 * Math.sin(t * 1.1 + 0.8)),
      );
      this.headTx.localRotation = sway;
      this.headTx.localScale = new Vec3(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE);
    }
    for (const p of this.petals) {
      const k = on * easeOutBack((t - p.start) / PETAL_DUR);
      const breathe = idle * 0.04 * Math.sin(t * 1.8 + p.yaw * 2);
      const a = p.closed + (p.open - p.closed) * k + breathe;
      p.tx.localPosition = Vec3.zero;
      p.tx.localRotation = Quaternion.fromAxisAngle(Vec3.up, p.yaw).mul(Quaternion.fromAxisAngle(new Vec3(1, 0, 0), a));
    }
    const glow = on * smooth((t - 0.75) / 0.8);
    if (this.centerTx != null) {
      const s = 0.45 + 0.55 * easeOutBack((t - 0.7) / 0.7) * on;
      this.centerTx.localPosition = new Vec3(0, 0.04, 0);
      this.centerTx.localScale = new Vec3(s, s, s);
    }
    if (on > 0 && this.centerTx != null) {
      const c = this.centerTx.worldPosition;
      const pulse = idle * 0.05 * Math.sin(t * 2.2);
      if (this.glowTx != null) {
        const gs = Math.max(0.01, 0.42 * glow * (1 + 0.2 * bump((t - 0.75) / 0.8)) + pulse);
        this.glowTx.worldPosition = new Vec3(c.x, c.y + 0.06, c.z);
        this.glowTx.localScale = new Vec3(gs, gs * 0.7, gs);
      }
      if (this.glowLightTx != null) this.glowLightTx.worldPosition = new Vec3(c.x, c.y + 0.5, c.z);
      if (this.glowLight != null) this.glowLight.intensity = GLOW_LIGHT_WARM + (GLOW_LIGHT_FULL - GLOW_LIGHT_WARM) * glow * (1 + pulse * 2);
    }
  }

  // 1.6 s on: plants stretch and sway, stones rise and settle, spores drift, light wave, brightness
  private world(t: number): void {
    const idle = smooth((t - IDLE_AT) / 0.8);
    for (const p of this.plants) {
      const k = (t - WORLD_START - p.delay) / 0.9;
      const st = 0.16 * bump(k) * (1 - 0.3 * clamp01(k));
      const swayAmp = 0.14 * Math.exp(-3 * Math.max(0, k)) * (k > 0 ? 1 : 0) + 0.03 * idle;
      const sway = swayAmp * Math.sin((t - WORLD_START - p.delay) * 6 * (1 - 0.6 * idle) + p.phase);
      p.tx.localScale = new Vec3(p.scale.x * (1 - st * 0.3), p.scale.y * (1 + st), p.scale.z * (1 - st * 0.3));
      p.tx.localRotation = Quaternion.fromAxisAngle(new Vec3(0, 0, 1), sway).mul(p.rot);
    }
    for (const s of this.stones) {
      const k = (t - WORLD_START - s.delay) / 0.9;
      const rise = STONE_RISE * smooth(k) - (STONE_RISE - STONE_SETTLE) * smooth((k - 0.75) / 0.6);
      const bob = 0.05 * idle * Math.sin(t * 1.3 + s.delay * 9);
      s.tx.localPosition = new Vec3(s.pos.x, s.pos.y + Math.max(0, rise) + bob, s.pos.z);
    }
    const head = this.centerTx?.worldPosition ?? this.flowerBase();
    for (const s of this.spores) {
      if (t < s.start) continue;
      const period = 3.4;
      const life = ((t - s.start) % period) / period;
      const h = life * 1.7 * s.speed * 2;
      const a = s.angle + life * 2.2;
      const r = s.radius * (0.5 + life);
      this.show(s.mesh, true);
      s.tx.worldPosition = new Vec3(head.x + Math.cos(a) * r, head.y + 0.1 + h, head.z + Math.sin(a) * r);
      const sc = Math.max(0.01, 1.0 * Math.sin(Math.PI * Math.min(1, life * 1.15)) * (0.8 + 0.4 * Math.sin(t * 7 + s.angle)));
      s.tx.localScale = new Vec3(sc, sc, sc);
    }
    if (this.waveTx != null) {
      const k = span(t, WAVE);
      const vis = t > WAVE[0] && t < WAVE[1];
      this.show(this.waveMesh, vis);
      if (vis) {
        const base = this.flowerBase();
        const r = 0.4 + 3.0 * (1 - Math.pow(1 - k, 2));
        const fade = 1 - smooth((k - 0.6) / 0.4);
        this.waveTx.worldPosition = new Vec3(base.x, base.y + 0.02 - 0.06 * (1 - fade), base.z);
        this.waveTx.localScale = new Vec3(r, Math.max(0.05, fade), r);
      }
    }
    if (this.ambience != null) this.ambience.intensity = AMBIENCE_LIGHT * smooth(span(t, BRIGHT));
  }

  private flowerBase(): Vec3 {
    const b = this.sleepTx?.worldPosition;
    return b ?? Vec3.zero;
  }

  private fx(root: Entity, name: string, out: MeshComponent[]): Maybe<TransformComponent> {
    const e = this.find(root, name);
    if (e == null) {
      console.log('[bloom] MISSING', name);
      return null;
    }
    this.meshes(e, out);
    return e.getComponent(TransformComponent);
  }

  private tx(root: Entity, name: string): Maybe<TransformComponent> {
    const e = this.find(root, name);
    if (e == null) console.log('[bloom] MISSING', name);
    return e?.getComponent(TransformComponent) ?? null;
  }

  private show(list: MeshComponent[], on: boolean): void {
    for (const m of list) if (m.isVisibleSelf !== on) m.isVisibleSelf = on;
  }

  private meshes(e: Entity, out: MeshComponent[]): void {
    const m = e.getComponent(MeshComponent);
    if (m != null) out.push(m);
    for (const c of e.getChildren()) this.meshes(c, out);
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
