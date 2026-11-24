/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v18

import {
  CameraService,
  Component,
  component,
  ExecuteOn,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  PlayerService,
  property,
  subscribe,
  TransformComponent,
  Vec2,
  Vec3,
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

/** A finger this close to the character on screen (design px) stops it. */
export const HOLD_STOP_RADIUS_PX = 60;
/** Distance beyond the stop radius over which speed ramps up to full (design px). */
export const HOLD_RAMP_PX = 140;
/** Height above the character's feet used as its on-screen position (metres). */
const BODY_CENTRE_HEIGHT = 0.9;
/** The short side of the screen in design px, as for the HUD and joystick. */
const DESIGN_SHORT_SIDE = 1080;
/** A press shorter and smaller than this is a tap, left to `TouchTapTarget` (tap-to-interact). */
const TAP_MAX_MS = 250;
const TAP_MAX_TRAVEL_PX = 40;

/** A point in design px, +Y down. */
export type ScreenPoint = {x: number; y: number};

/**
 * The `Move` input for a finger held at `finger` while the character is at
 * `character` on screen: towards the finger (+Y forward), zero within
 * HOLD_STOP_RADIUS_PX, ramping to full speed over HOLD_RAMP_PX beyond it.
 */
export function holdMoveInput(finger: ScreenPoint, character: ScreenPoint): {x: number; y: number} {
  const dx = finger.x - character.x;
  const dy = finger.y - character.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= HOLD_STOP_RADIUS_PX) {
    return {x: 0, y: 0};
  }
  const speed = Math.min((dist - HOLD_STOP_RADIUS_PX) / HOLD_RAMP_PX, 1);
  return {x: (dx / dist) * speed, y: (-dy / dist) * speed};
}

// ============================================================================
// Component
//
// Hold-to-move: while a finger is held anywhere on screen (outside the HUD
// buttons), the local player runs towards it. The direction is measured on
// screen from the character to the finger and published on the `Move` action,
// the same action the joystick drives, so the character code is unchanged. It is
// exact for a top-down camera and close for tilted ones; the player steers by
// moving the finger.
//
// Active only in the HoldToMove touch movement scheme (TouchMovementScheme.ts),
// set by `LocomotionSettingsComponent.locomotionMode`. In that scheme the
// joystick and the camera drag are off, so pair it with a fixed-angle camera
// (TopDown, Isometric) or turn off CameraManager auto-rotate, which otherwise
// swings the camera behind the direction of travel while the finger holds still.
//
// Touch comes from the shared TouchRouter at zPriority 45: below the HUD buttons
// (100), so a button press never moves the player (pass-through buttons claim
// their press in this scheme too), and above TouchTapTarget (40).
// It claims the touch only at release and only for a hold, so a quick tap still
// reaches TouchTapTarget and can interact with what it lands on.
// ============================================================================

@component({
  description:
    'Hold-to-move: the local player runs towards a finger held on screen. Active when LocomotionSettingsComponent.locomotionMode is HoldToMove.',
})
export class TouchHoldToMove extends Component {
  /** The InputActionsManager Axis2D action this drives. */
  @property()
  actionName: string = 'Move';

  private activeIndex: Maybe<number> = null;
  private fingerNormX = 0;
  private fingerNormY = 0;
  private downNormX = 0;
  private downNormY = 0;
  private downAtMs = 0;
  private travelled = false;
  private unsubscribeScheme: Maybe<() => void> = null;
  // Reused each frame by onUpdate.
  private readonly fingerPx: ScreenPoint = {x: 0, y: 0};
  private readonly characterPx: ScreenPoint = {x: 0, y: 0};

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }
    this.unsubscribeScheme = onTouchMovementSchemeChanged(() => this.release());
    TouchRouter.register({
      id: 'holdToMove',
      zPriority: 45,
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (_pos: Vec2) => getTouchMovementScheme() === TouchMovementScheme.HoldToMove,
      handlers: {
        onStart: (index: number, pos: Vec2, alreadyConsumed: boolean) =>
          this.handleStart(index, pos, alreadyConsumed),
        onMove: (index: number, pos: Vec2) => this.handleMove(index, pos),
        onEnd: (index: number) => this.handleEnd(index),
      },
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }
    TouchRouter.unregister('holdToMove');
    this.unsubscribeScheme?.();
    this.unsubscribeScheme = null;
    this.release();
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(): void {
    if (this.activeIndex === null) {
      return;
    }
    const character = this.characterScreenNorm();
    if (character == null) {
      this.setOutput(0, 0);
      return;
    }
    const dims = this.screenDims();
    this.fingerPx.x = this.fingerNormX * dims.w;
    this.fingerPx.y = this.fingerNormY * dims.h;
    this.characterPx.x = character.x * dims.w;
    this.characterPx.y = character.y * dims.h;
    const out = holdMoveInput(this.fingerPx, this.characterPx);
    this.setOutput(out.x, out.y);
  }

  private handleStart(index: number, pos: Vec2, alreadyConsumed: boolean): void {
    if (alreadyConsumed || this.activeIndex !== null) {
      return; // A HUD button took this touch, or another finger is steering.
    }
    this.activeIndex = index;
    this.fingerNormX = pos.x;
    this.fingerNormY = pos.y;
    this.downNormX = pos.x;
    this.downNormY = pos.y;
    this.downAtMs = Date.now();
    this.travelled = false;
  }

  private handleMove(index: number, pos: Vec2): void {
    if (index !== this.activeIndex) {
      return;
    }
    this.fingerNormX = pos.x;
    this.fingerNormY = pos.y;
    if (!this.travelled) {
      const dims = this.screenDims();
      this.travelled =
        Math.hypot((pos.x - this.downNormX) * dims.w, (pos.y - this.downNormY) * dims.h) >
        TAP_MAX_TRAVEL_PX;
    }
  }

  private handleEnd(index: number): boolean {
    if (index !== this.activeIndex) {
      return false;
    }
    const wasHold = this.travelled || Date.now() - this.downAtMs > TAP_MAX_MS;
    this.release();
    // Claim a hold so TouchTapTarget does not also treat it as a tap.
    return wasHold;
  }

  private release(): void {
    if (this.activeIndex === null) {
      return;
    }
    this.activeIndex = null;
    this.setOutput(0, 0);
  }

  /** The local character's body centre on screen (0..1, +Y down), or null when off camera. */
  private characterScreenNorm(): Maybe<{x: number; y: number}> {
    const player = PlayerService.get().getLocalPlayer();
    const transform = player?.getComponent(TransformComponent) ?? null;
    if (transform == null) {
      return null;
    }
    const camera = CameraService.get();
    const body = transform.worldPosition.add(new Vec3(0, BODY_CENTRE_HEIGHT, 0));
    // worldToScreenPoint is meaningless for a point behind the camera.
    if (body.sub(camera.position).dot(camera.forward) <= 0) {
      return null;
    }
    const screen = camera.worldToScreenPoint(body);
    return {x: screen.x, y: screen.y};
  }

  /** Screen size in design px: the short side is DESIGN_SHORT_SIDE. */
  private screenDims(): {w: number; h: number} {
    const aspect = CameraService.get().aspectRatio;
    if (!(aspect > 0) || !Number.isFinite(aspect)) {
      return {w: DESIGN_SHORT_SIDE, h: DESIGN_SHORT_SIDE};
    }
    return aspect < 1
      ? {w: DESIGN_SHORT_SIDE, h: DESIGN_SHORT_SIDE / aspect}
      : {w: DESIGN_SHORT_SIDE * aspect, h: DESIGN_SHORT_SIDE};
  }

  private setOutput(x: number, y: number): void {
    InputActionsManager.instance?.setAxis2DValue(this.actionName, new Vec2(x, y));
  }
}
