/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v15

import {
  component,
  Component,
  property,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  CustomUiComponent,
  ExecuteOn,
  NetworkingService,
  Vec2,
  uiViewModel,
  UiViewModel,
  CameraService,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';
import {InputActionsManager} from './InputActionsManager';
import {
  getTouchMovementScheme,
  onTouchMovementSchemeChanged,
  TouchMovementScheme,
} from './TouchMovementScheme';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// ============================================================================
// Tuning constants (see "Tuning" in scripts/Input/README.md)
// ============================================================================

// Finger travel from the stick centre for full deflection, as a fraction of the
// screen WIDTH, applied to both axes so the stick is round on any screen shape
// (as the engine's own joystick does). 0.12 of a 1080-wide portrait screen is
// 130 design px.
const TOUCH_RADIUS = 0.12;
// Ignore tiny jitter around the centre (fraction of full deflection).
const TOUCH_DEADZONE = 0.08;

// Design resolution (matches the XAML authoring resolution).
const DESIGN_WIDTH_PORTRAIT = 1080;
const DESIGN_HEIGHT_PORTRAIT = 2340;
const DESIGN_WIDTH_LANDSCAPE = 2340;
const DESIGN_HEIGHT_LANDSCAPE = 1080;

// Ring container size (px, design space), matching the Figma default design
// (Horizon Mobile In-World 2025, portrait: 172pt outer ring on a 393pt frame ->
// 172 * 1080/393 = 475). The container is centred on the touch-down point, so its
// top-left offset is origin - RING_HALF.
const RING_SIZE = 475;
const RING_HALF = RING_SIZE / 2;
// Max distance (px) the knob CENTRE travels from the ring centre (visual clamp
// only; the gameplay output is computed separately). Set so at the limit the knob
// EDGE sits half a handle-radius past the OUTER ring: outer radius RING_HALF
// (237.5) + half the 90px handle radius (22.5) = 260px knob edge, so the centre
// travels 260 - 45 = 215. The knob tracks the finger 1:1 until it reaches this limit.
const KNOB_TRAVEL_PX = 215;
// Fixed mode: a touch must start within this distance (design px) of the fixed
// centre to grab the stick, a little beyond the drawn ring.
const FIXED_GRAB_RADIUS_PX = RING_HALF * 1.25;

/** How the stick is placed. Values for the `mode` property. */
export enum JoystickMode {
  /** Appears where the thumb lands in the movement zone and stays there (default). */
  Floating = 0,
  /** Always drawn at a fixed home; the thumb must start on it. */
  Fixed = 1,
  /** Appears where the thumb lands and is dragged along when the thumb leaves the ring. */
  Follow = 2,
}

/** Size and response of a stick, for {@link stickOutput}. */
export type StickShape = {
  /** Finger travel for full deflection, design px. */
  radiusPx: number;
  /** Ignored centre, as a fraction of full deflection. */
  deadzone: number;
  /** 0 or absent = analog; 4 or 8 = D-pad. */
  directions?: number;
};

/** A point in design px. */
export type Point = {x: number; y: number};

/**
 * Stick output for a finger offset from the stick centre. The offset is in
 * design px with +Y down (screen space); the output is +Y up (world forward),
 * zero inside the deadzone, then ramps from 0 at the deadzone edge to 1 at
 * `radiusPx` and stays at 1 beyond it.
 */
export function stickOutput(
  offsetX: number,
  offsetY: number,
  stick: StickShape,
): {x: number; y: number} {
  const {radiusPx, deadzone} = stick;
  const directions = stick.directions ?? 0;
  const dx = offsetX / radiusPx;
  const dy = -offsetY / radiusPx;
  const mag = Math.hypot(dx, dy);
  if (mag < deadzone || mag === 0) {
    return {x: 0, y: 0};
  }
  if (directions === 4 || directions === 8) {
    // D-pad: snap to the nearest heading at full speed.
    return snapDirection(dx, dy, directions);
  }
  const scaled = Math.min(Math.max((Math.min(mag, 1) - deadzone) / (1 - deadzone), 0), 1);
  return {x: (dx / mag) * scaled, y: (dy / mag) * scaled};
}

/** The unit vector of the nearest of `sectors` evenly spaced headings, starting at +X. */
export function snapDirection(x: number, y: number, sectors: number): {x: number; y: number} {
  const step = (2 * Math.PI) / sectors;
  const angle = Math.round(Math.atan2(y, x) / step) * step;
  // Round away floating-point dust so a snapped axis reads exactly 0 or 1.
  return {x: Math.round(Math.cos(angle) * 1e9) / 1e9, y: Math.round(Math.sin(angle) * 1e9) / 1e9};
}

/**
 * Follow mode: the stick centre after the finger moves to `finger`. If
 * the finger is further than `maxDistance` from the centre, the centre is dragged
 * towards it until it is exactly `maxDistance` away; otherwise it stays put.
 */
export function followOrigin(origin: Point, finger: Point, maxDistance: number): Point {
  const dx = finger.x - origin.x;
  const dy = finger.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxDistance) {
    return {x: origin.x, y: origin.y};
  }
  const pull = (dist - maxDistance) / dist;
  return {x: origin.x + dx * pull, y: origin.y + dy * pull};
}

// ============================================================================
// ViewModel
// ============================================================================

@uiViewModel()
export class TouchJoystickViewModel extends UiViewModel {
  override readonly events = {};

  // The ring only shows while a finger is driving the stick (floating stick).
  active: boolean = false;

  // Ring container top-left in design pixels (bound to a TranslateTransform).
  // Set so the ring is centred on the touch-down point.
  originX: number = 0;
  originY: number = 0;

  // Analog knob offset from the ring centre, in design pixels (bound to a
  // TranslateTransform). +Y is down (screen space).
  knobX: number = 0;
  knobY: number = 0;
}

// ============================================================================
// Component
//
// A floating, orientation-aware virtual movement joystick that drives an Axis2D
// action on the InputActionsManager. Touch is delivered by the shared
// TouchRouter (which owns the single OnTouchInput* subscription); the joystick
// registers a descriptor instead of subscribing to the raw touch events itself,
// because a joystick needs continuous finger tracking that a Noesis <Button>
// Command tap cannot supply.
//
// MODES (`mode`): Floating, the default, has no fixed home: its origin is the
// touch-down point inside the movement zone, and the ring is drawn once the
// finger drags past the deadzone (a tap shows no ring and falls through to the
// tap-to-world layer). Fixed draws the ring at a home position all the time and
// measures from it. Follow starts like Floating and drags the ring along when the
// finger leaves it. `directions` 4 or 8 turns any mode into a D-pad.
//
// ORIENTATION-AWARE, PORTRAIT-FIRST zones (set `landscape` in the inspector):
//   Portrait (default): movement zone = BOTTOM half (screenPosition.y >= 0.5).
//   Landscape:          movement zone = LEFT half  (screenPosition.x < 0.5).
// The camera-look zone is the complementary half, owned by TouchCameraLook, so
// movement and camera can be driven by two fingers at once.
// ============================================================================

@component()
export class TouchJoystick extends Component {
  /** false = portrait split (default), true = landscape split. */
  @property()
  landscape: boolean = false;

  /** The InputActionsManager Axis2D action this joystick drives. */
  @property()
  actionName: string = 'Move';

  /**
   * How the stick is placed: 0 Floating (appears under the thumb, the default),
   * 1 Fixed (always drawn at its home, set below), 2 Follow (appears under the
   * thumb and is dragged along when the thumb leaves the ring). A number rather
   * than `JoystickMode` so live property edits apply (see `CameraManager.cameraMode`).
   */
  @property()
  mode: number = JoystickMode.Floating;

  /**
   * 0 = analog (the default). 8 = eight-way D-pad, 4 = four-way D-pad: the output
   * snaps to the nearest direction at full speed once the thumb leaves the deadzone.
   */
  @property()
  directions: number = 0;

  /** Fixed mode, portrait: stick centre in design px from the left edge. */
  @property()
  fixedLeft: number = 300;

  /** Fixed mode, portrait: stick centre in design px from the bottom edge. */
  @property()
  fixedBottom: number = 734;

  /** Fixed mode, landscape: stick centre in design px from the left edge. */
  @property()
  fixedLeftLandscape: number = 390;

  /** Fixed mode, landscape: stick centre in design px from the bottom edge. */
  @property()
  fixedBottomLandscape: number = 463;

  private viewModel = new TouchJoystickViewModel();
  private customUi: Maybe<CustomUiComponent> = null;

  // interactionIndex of the finger currently driving the joystick, or null.
  private activeIndex: Maybe<number> = null;
  // Touch-down anchor (the floating centre), in normalized screen units.
  private originNormX = 0;
  private originNormY = 0;

  // True once this finger crossed the deadzone into a drag (drove the stick).
  // Consumed at release so the tap layer beneath does not also fire a world tap
  // for a movement drag whose travel fell inside the tap window.
  private droveMovement = false;

  private designWidth = DESIGN_WIDTH_PORTRAIT;
  private designHeight = DESIGN_HEIGHT_PORTRAIT;
  private unsubscribeScheme: Maybe<() => void> = null;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    this.designWidth = this.landscape
      ? DESIGN_WIDTH_LANDSCAPE
      : DESIGN_WIDTH_PORTRAIT;
    this.designHeight = this.landscape
      ? DESIGN_HEIGHT_LANDSCAPE
      : DESIGN_HEIGHT_PORTRAIT;

    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi != null) {
      this.customUi.dataContext = this.viewModel;
    }
    this.resetVisuals();
    // Only the Joystick scheme moves with the stick (see TouchMovementScheme.ts).
    this.unsubscribeScheme = onTouchMovementSchemeChanged(() => this.release());

    // Route touch through the shared TouchRouter at zPriority 50 (above
    // camera-look at 0). The joystick never consumes at start or move (mirroring
    // the native movement zone), so a tap in the movement zone still reaches the
    // tap-to-world layer beneath and is not swallowed; it consumes ONLY at release
    // when the finger drove the stick (see handleEnd). If a HIGHER control (a HUD
    // button) already consumed the touch, handleStart stands down. HoldUntilRelease
    // keeps the finger even if it drags outside the ring.
    TouchRouter.register({
      id: 'joystick',
      zPriority: 50,
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (pos: Vec2) => this.isInMovementZone(pos),
      handlers: {
        onStart: (index: number, pos: Vec2, alreadyConsumed: boolean) =>
          this.handleStart(index, pos, alreadyConsumed),
        onMove: (index: number, pos: Vec2) => this.handleMove(index, pos),
        onEnd: (index: number) => this.handleEnd(index),
      },
    });
  }

  // Fixed mode keeps the idle ring at its home; the viewport aspect (and so the
  // logical height) can arrive after start, and `mode` can be edited live.
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(): void {
    if (this.activeIndex !== null || this.customUi == null) {
      return;
    }
    if (!this.inUse()) {
      if (this.viewModel.active) {
        this.viewModel.active = false;
      }
    } else if (this.mode === JoystickMode.Fixed) {
      this.showAtHome();
    } else if (this.viewModel.active) {
      this.resetVisuals();
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    TouchRouter.unregister('joystick');
    this.unsubscribeScheme?.();
    this.unsubscribeScheme = null;
    this.activeIndex = null;
    // Safety: never leave an override active — it would keep the avatar walking.
    this.setOutput(0, 0);
    this.customUi = null;
  }

  // --------------------------------------------------------------------------
  // Router handlers
  //
  // The router only delivers touches whose down-point is inside the movement
  // zone. An internal activeIndex still gates a SECOND finger: once a finger
  // owns the stick, another finger's start in the zone is ignored.
  // --------------------------------------------------------------------------

  // The ring lives in a fill Canvas inside the LayoutScaler, which pins the
  // limiting axis to the design reference and OVERSCANS the other. The router's
  // pos is physical-normalized (0..1 of the screen), so map it through the panel's
  // ACTUAL logical size, derived from the runtime viewport aspect (width/height),
  // not the fixed design constants. Mirrors the engine's built-in joystick
  // (TouchInputControlsUIPanel); without it the ring is offset on any device whose
  // aspect differs from the design (x correct, y wrong on a taller phone).
  private logicalDims(): {w: number; h: number} {
    const refW = this.designWidth;
    const refH = this.designHeight;
    const aspect = CameraService.get().aspectRatio;
    if (!(aspect > 0) || !Number.isFinite(aspect)) {
      return {w: refW, h: refH};
    }
    if (aspect < refW / refH) {
      // Viewport taller than the design: width pins, height overscans.
      return {w: refW, h: refW / aspect};
    }
    // Viewport wider than the design: height pins, width overscans.
    return {w: refH * aspect, h: refH};
  }

  private handleStart(index: number, pos: Vec2, alreadyConsumed: boolean): void {
    if (alreadyConsumed) {
      return; // A higher control (a HUD button) claimed this touch; stand down.
    }
    if (this.activeIndex !== null && this.activeIndex !== index) {
      return; // Already driving another finger — do not hijack.
    }
    this.activeIndex = index;
    this.droveMovement = false;
    if (this.mode === JoystickMode.Fixed) {
      const home = this.homeNorm();
      this.originNormX = home.x;
      this.originNormY = home.y;
    } else {
      this.originNormX = pos.x;
      this.originNormY = pos.y;
    }

    // Anchor the floating origin but do NOT reveal the ring yet. The joystick is
    // non-consuming, so a tap in the movement zone also reaches TouchTapTarget;
    // showing the ring on touch-down would flash it on every tap. handleMove
    // reveals it on the first move past the deadzone, once the gesture is a drag.
    this.setOutput(0, 0);
  }

  private handleMove(index: number, pos: Vec2): void {
    if (index !== this.activeIndex) {
      return;
    }

    // Offset from the stick centre in design px, mapped through the panel's
    // actual logical size (see logicalDims) so both axes use the same unit.
    const dims = this.logicalDims();
    if (this.mode === JoystickMode.Follow && this.viewModel.active) {
      // Drag the centre along once the thumb leaves the ring.
      const moved = followOrigin(
        {x: this.originNormX * dims.w, y: this.originNormY * dims.h},
        {x: pos.x * dims.w, y: pos.y * dims.h},
        KNOB_TRAVEL_PX,
      );
      this.originNormX = moved.x / dims.w;
      this.originNormY = moved.y / dims.h;
      this.viewModel.originX = moved.x - RING_HALF;
      this.viewModel.originY = moved.y - RING_HALF;
    }
    const offsetX = (pos.x - this.originNormX) * dims.w;
    const offsetY = (pos.y - this.originNormY) * dims.h;
    const radiusPx = TOUCH_RADIUS * dims.w;
    const crossedDeadzone = Math.hypot(offsetX, offsetY) >= TOUCH_DEADZONE * radiusPx;
    const out = stickOutput(offsetX, offsetY, {
      radiusPx,
      deadzone: TOUCH_DEADZONE,
      directions: this.directions,
    });

    // Reveal the floating ring only once the finger crosses the deadzone, i.e. the
    // gesture is a drag not a tap (a tap falls through to TouchTapTarget). Centre
    // it on the touch-down origin.
    if (!this.viewModel.active && crossedDeadzone) {
      this.viewModel.active = true;
      this.viewModel.originX = this.originNormX * dims.w - RING_HALF;
      this.viewModel.originY = this.originNormY * dims.h - RING_HALF;
    }

    // Visual knob: sit directly under the finger while the ring is shown, clamped
    // to KNOB_TRAVEL_PX so the handle stays inside the ring. DECOUPLED from the
    // gameplay output: the knob tracks the finger 1:1 until the travel limit, while
    // the output keeps its deadzone + TOUCH_RADIUS ramp, so deriving one from the
    // other makes the knob lag.
    if (this.viewModel.active && (this.directions === 4 || this.directions === 8)) {
      // D-pad: show the chosen direction rather than the raw thumb position.
      this.viewModel.knobX = out.x * KNOB_TRAVEL_PX;
      this.viewModel.knobY = -out.y * KNOB_TRAVEL_PX;
    } else if (this.viewModel.active) {
      let knobX = offsetX;
      let knobY = offsetY;
      const knobMag = Math.hypot(knobX, knobY);
      if (knobMag > KNOB_TRAVEL_PX) {
        const clampScale = KNOB_TRAVEL_PX / knobMag;
        knobX *= clampScale;
        knobY *= clampScale;
      }
      this.viewModel.knobX = knobX;
      this.viewModel.knobY = knobY;
    }

    if (!crossedDeadzone) {
      this.setOutput(0, 0);
      return;
    }
    // Movement produced: this finger is a drag, so mark it for handleEnd to
    // consume the release (the tap layer beneath must not also fire).
    this.droveMovement = true;
    this.setOutput(out.x, out.y);
  }

  private handleEnd(index: number): boolean {
    if (index !== this.activeIndex) {
      return false;
    }
    const drove = this.droveMovement;
    this.activeIndex = null;
    this.droveMovement = false;
    this.setOutput(0, 0);
    this.resetVisuals();
    // Consume the release only if this finger drove the stick, so a movement drag
    // does not also fire a world tap; a pure tap in the zone (never crossed the
    // deadzone) returns false and still reaches the tap layer beneath.
    return drove;
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Portrait: bottom half (y >= 0.5). Landscape: left half (x < 0.5). Fixed mode
   * also requires the touch to start on or near the drawn stick.
   */
  private isInMovementZone(pos: Vec2): boolean {
    if (!this.inUse()) {
      return false;
    }
    const inZone = this.landscape ? pos.x < 0.5 : pos.y >= 0.5;
    if (!inZone || this.mode !== JoystickMode.Fixed) {
      return inZone;
    }
    const dims = this.logicalDims();
    const home = this.homeNorm();
    return (
      Math.hypot((pos.x - home.x) * dims.w, (pos.y - home.y) * dims.h) <=
      FIXED_GRAB_RADIUS_PX
    );
  }

  /** True when the stick moves the player: the Joystick touch movement scheme. */
  private inUse(): boolean {
    return getTouchMovementScheme() === TouchMovementScheme.Joystick;
  }

  /** Let go of the current finger, stop moving, and hide or re-home the ring. */
  private release(): void {
    this.activeIndex = null;
    this.droveMovement = false;
    this.setOutput(0, 0);
    this.resetVisuals();
  }

  /** Fixed mode home, in normalized screen units (0..1, +Y down). */
  private homeNorm(): {x: number; y: number} {
    const dims = this.logicalDims();
    const left = this.landscape ? this.fixedLeftLandscape : this.fixedLeft;
    const bottom = this.landscape ? this.fixedBottomLandscape : this.fixedBottom;
    return {x: left / dims.w, y: (dims.h - bottom) / dims.h};
  }

  /** Fixed mode: draw the idle ring at its home with the knob centred. */
  private showAtHome(): void {
    const dims = this.logicalDims();
    const home = this.homeNorm();
    const x = home.x * dims.w - RING_HALF;
    const y = home.y * dims.h - RING_HALF;
    if (!this.viewModel.active) {
      this.viewModel.active = true;
    }
    if (this.viewModel.originX !== x) {
      this.viewModel.originX = x;
    }
    if (this.viewModel.originY !== y) {
      this.viewModel.originY = y;
    }
  }

  private setOutput(x: number, y: number): void {
    InputActionsManager.instance?.setAxis2DValue(
      this.actionName,
      new Vec2(x, y),
    );
  }

  private resetVisuals(): void {
    this.viewModel.knobX = 0;
    this.viewModel.knobY = 0;
    if (this.mode === JoystickMode.Fixed && this.inUse()) {
      this.showAtHome();
    } else {
      this.viewModel.active = false;
    }
  }
}
