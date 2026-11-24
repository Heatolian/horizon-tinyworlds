import {
  CameraComponent,
  CameraService,
  Component,
  ExecuteOn,
  MeshComponent,
  NetworkingService,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  Quaternion,
  TransformComponent,
  Vec3,
  WorldService,
  component,
  property,
  subscribe,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';

// Fixed elevated board camera for Tiny Worlds. Values are described in Docs/CAMERA.md.
const PITCH_DEG = 45; // looking down at the board
const FOCUS = new Vec3(0, -0.45, 0.1); // board centre (slightly below the top to frame the rocky undersides)
const BOARD_HALF_WIDTH = 4.0; // half the width (m) that must fit across the screen, incl. rocks and margin
const BOARD_HALF_DEPTH = 4.2; // half the depth (m) that must fit top-to-bottom
const MAX_HFOV_DEG = 46;
const VFOV_DEG = 34; // default vertical field of view in portrait
const FAR_CLIP = 2500;

@component()
export class BoardCamera extends Component {
  @property() timeScale: number = 1;

  private cam: Maybe<CameraComponent> = null;
  private lastAspect = -1;
  private shadowsDone = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) return;
    this.cam = this.entity.getComponent(CameraComponent);
    if (this.cam == null) {
      console.log('[camera] no CameraComponent on', this.entity.name);
      return;
    }
    this.cam.farClippingPlane = FAR_CLIP;
    this.place();
    CameraService.get().setActiveCamera({camera: this.cam} as any);
    console.log('[camera] fixed board camera active');
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(_e: OnWorldUpdateEventPayload): void {
    if (NetworkingService.get().isServerContext() || this.cam == null) return;
    const aspect = CameraService.get().aspectRatio;
    if (Math.abs(aspect - this.lastAspect) > 0.01) this.place();
    if (!this.shadowsDone) this.enableShadows();
  }

  /** Places the camera rigidly so the whole board fits, whatever the phone's aspect. */
  private place(): void {
    if (this.cam == null) return;
    const aspect = Math.max(0.3, CameraService.get().aspectRatio || 0.46);
    this.lastAspect = aspect;
    const rad = Math.PI / 180;
    // keep horizontal fov bounded: narrow phones widen the vertical fov a little
    let vfov = VFOV_DEG;
    const hfov = 2 * Math.atan(Math.tan((vfov * rad) / 2) * aspect) / rad;
    if (hfov > MAX_HFOV_DEG) vfov = 2 * Math.atan(Math.tan((MAX_HFOV_DEG * rad) / 2) / aspect) / rad;
    const tanH = Math.tan((vfov * rad) / 2) * aspect;
    const tanV = Math.tan((vfov * rad) / 2);
    const dist = Math.max(BOARD_HALF_WIDTH / tanH, BOARD_HALF_DEPTH / tanV);
    this.cam.fieldOfView = vfov;
    const p = PITCH_DEG * rad;
    const pos = new Vec3(FOCUS.x, FOCUS.y + Math.sin(p) * dist, FOCUS.z + Math.cos(p) * dist);
    const tx = this.entity.getComponent(TransformComponent);
    if (tx == null) return;
    tx.worldPosition = pos;
    const fwd = FOCUS.sub(pos).normalize();
    tx.worldRotation = Quaternion.lookRotation(fwd, Vec3.up);
  }

  /** Soft shadows from the tiles, plants and flower onto the board. */
  private enableShadows(): void {
    let board: Maybe<Entity> = this.entity;
    while (board != null && board.parent != null) board = board.parent;
    if (board == null) return;
    let n = 0;
    const visit = (e: Entity) => {
      const m = e.getComponent(MeshComponent);
      if (m != null) {
        const sp = m.shadowParams as any;
        m.shadowParams = {...sp, castsShadows: true};
        n++;
      }
      for (const c of e.getChildren()) visit(c);
    };
    visit(board);
    this.shadowsDone = n > 0;
    if (this.shadowsDone) console.log('[camera] shadows on', n, 'meshes');
  }
}
