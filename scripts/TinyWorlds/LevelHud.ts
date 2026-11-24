import {
  Component,
  CustomUiComponent,
  ExecuteOn,
  NetworkingService,
  OnEntityStartEvent,
  OnTouchInputEndedEvent,
  OnTouchInputStartedEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  TouchInputEventPayload,
  UiViewModel,
  Vec2,
  component,
  property,
  subscribe,
  uiViewModel,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';
import {levelBus} from './WaterNetwork';

// Level HUD: the "Garden Restored!" banner and the Restart pill below the board.
// The pill is display-only; its tap is hit-tested here in normalized screen space.

const DESIGN_W = 1080;
const DESIGN_H = 2340;
// Restart pill in design px (bottom-centre anchored), padded a little for fingers
const BTN_W = 400 + 40;
const BTN_H = 150 + 40;
const BTN_BOTTOM = 330 - 20;
const TAP_MAX_TRAVEL = 0.04;
const POP_SECONDS = 0.6; // soft fade-in after the flower awakens

@uiViewModel()
export class LevelHudViewModel extends UiViewModel {
  override readonly events = {};
  messageOpacity: number = 0;
  messageScale: number = 0.01;
  restartScale: number = 1;
}

@component()
export class LevelHud extends Component {
  @property() timeScale: number = 1;
  /** True when touch screenPosition.y grows downward from the top edge. */
  @property() screenYFromTop: boolean = true;

  private vm = new LevelHudViewModel();
  private ui: Maybe<CustomUiComponent> = null;
  private solved = false;
  private popT = 1;
  private pressT = 1;
  private downs: Map<number, Vec2> = new Map();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) return;
    this.ui = this.entity.getComponent(CustomUiComponent);
    if (this.ui != null) this.ui.dataContext = this.vm;
    levelBus.setSolved = (s: boolean) => this.setSolved(s);
  }

  setSolved(s: boolean): void {
    this.solved = s;
    this.popT = s ? 0 : 1;
    if (!s) {
      this.vm.messageOpacity = 0;
      this.vm.messageScale = 0.01;
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
      if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_TRAVEL) return;
    }
    if (this.onRestartButton(p.screenPosition.x, p.screenPosition.y)) {
      this.pressT = 0;
      console.log('[hud] restart tapped');
      levelBus.restart?.();
    }
  }

  private onRestartButton(nx: number, ny: number): boolean {
    // LayoutScaler fits the 1080x2340 canvas by height on tall phones; map design px to fractions
    const yUp = this.screenYFromTop ? 1 - ny : ny; // fraction from the bottom edge
    const halfW = BTN_W / 2 / DESIGN_W;
    const inX = Math.abs(nx - 0.5) <= halfW;
    const y0 = BTN_BOTTOM / DESIGN_H;
    const y1 = (BTN_BOTTOM + BTN_H) / DESIGN_H;
    return inX && yUp >= y0 && yUp <= y1;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(e: OnWorldUpdateEventPayload): void {
    if (NetworkingService.get().isServerContext()) return;
    const dt = e.deltaTime * this.timeScale;
    if (this.solved && this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt / POP_SECONDS);
      const k = this.popT;
      // soft fade-in with a slight drift up to full size
      const e = k * k * (3 - 2 * k);
      this.vm.messageScale = 0.9 + 0.1 * (1 - Math.pow(1 - k, 3));
      this.vm.messageOpacity = e;
    }
    if (this.pressT < 1) {
      this.pressT = Math.min(1, this.pressT + dt / 0.2);
      this.vm.restartScale = 1 - 0.1 * Math.sin(Math.PI * this.pressT);
    }
  }
}
