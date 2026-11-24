/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v18

import {
  component,
  Component,
  property,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
  NetworkingService,
  Vec2,
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

// Scales the raw per-move normalized delta into the value published on 'Look'.
// The camera consumer decides the final radians-per-unit; this is a coarse gain
// so a full-screen swipe yields a comfortable turn.
const LOOK_SENSITIVITY = 3.0;

// ============================================================================
// Component
//
// An invisible camera-look drag that drives an ActionType.Delta 'Look' action on
// the InputActionsManager. It has no XAML because a look drag has no on-screen
// widget. Touch is delivered by the shared TouchRouter (which owns the single
// OnTouchInput* subscription); the drag registers a descriptor instead of
// subscribing to the raw touch events itself.
//
// LOWEST LAYER: it registers at zPriority 0 and never consumes, so it is the
// background of the camera zone. A higher control (a button) that consumes a
// touch tells this drag alreadyConsumed so it stands down; otherwise this drag
// observes it. There is no corner exclusion: buttons are simply higher-z
// controls that own their own hit region. A pass-through button (Use in
// landscape) does not claim its press, so a drag that starts on it turns the
// camera while the button fires; that needs the button inside this zone.
//
// ORIENTATION-AWARE, PORTRAIT-FIRST zones (set `landscape` in the inspector):
//   Portrait (default): camera zone = TOP half   (screenPosition.y < 0.5).
//   Landscape:          camera zone = RIGHT half  (screenPosition.x >= 0.5).
// The zone follows the touch movement scheme (TouchMovementScheme.ts): the
// whole screen for TapToMove, where there is no joystick, and nothing for
// HoldToMove, where every drag steers the player.
//
// DELTA MODEL: 'Look' is an ActionType.Delta action. Each move adds its
// per-move delta (the change in touch position since the last move) via
// addActionDelta; the manager accumulates the adds within a frame and auto-zeros
// the action each frame. The camera consumer polls getActionDelta('Look') in its
// OnWorldUpdate and integrates the delta into yaw/pitch, reading (0,0) when the
// finger is idle.
// ============================================================================

@component()
export class TouchCameraLook extends Component {
  /** false = portrait split (default), true = landscape split. */
  @property()
  landscape: boolean = false;

  /** The InputActionsManager Delta action this drag drives. */
  @property()
  actionName: string = 'Look';

  // Last touch position (normalized) per router finger index, used to compute
  // the per-move delta. HoldUntilRelease means a finger keeps driving the look
  // even after it leaves the camera zone, so track by index.
  private lastByIndex: Map<number, Vec2> = new Map();
  private unsubscribeScheme: Maybe<() => void> = null;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    // Register as the background of the camera zone at zPriority 0 (below
    // everything). Camera-look NEVER consumes the touch; it just observes the
    // drag. If a HIGHER control (a HUD button) already consumed this touch,
    // handleStart does not engage the finger. HoldUntilRelease keeps the finger
    // for the whole drag.
    // A drag in progress stops turning the camera when the scheme changes.
    this.unsubscribeScheme = onTouchMovementSchemeChanged(() => this.lastByIndex.clear());

    TouchRouter.register({
      id: 'cameraLook',
      zPriority: 0,
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (pos: Vec2) => this.isInCameraZone(pos),
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

    TouchRouter.unregister('cameraLook');
    this.unsubscribeScheme?.();
    this.unsubscribeScheme = null;
    this.lastByIndex.clear();
  }

  // --------------------------------------------------------------------------
  // Router handlers
  // --------------------------------------------------------------------------

  private handleStart(index: number, pos: Vec2, alreadyConsumed: boolean): void {
    if (alreadyConsumed) {
      return; // A higher control claimed this touch; do not engage the drag.
    }
    this.lastByIndex.set(index, new Vec2(pos.x, pos.y));
  }

  private handleMove(index: number, pos: Vec2): void {
    const last = this.lastByIndex.get(index);
    if (last == null) {
      // Not engaged for this finger (a higher control consumed it at start, or
      // no start was recorded); ignore its moves.
      return;
    }
    // Per-move delta (screen space). +X = drag right, +Y = drag down. The
    // camera consumer decides how to map these to yaw/pitch.
    const dx = (pos.x - last.x) * LOOK_SENSITIVITY;
    const dy = (pos.y - last.y) * LOOK_SENSITIVITY;
    this.lastByIndex.set(index, new Vec2(pos.x, pos.y));
    // Accumulate the delta for this frame. The manager sums the adds and
    // auto-zeros the action each frame, so the camera consumer polls the total
    // in its OnWorldUpdate and reads (0,0) once the finger stops moving.
    InputActionsManager.instance?.addActionDelta(
      this.actionName,
      new Vec2(dx, dy),
    );
  }

  private handleEnd(index: number): void {
    // No reset needed for a delta stream: with the finger up there are no more
    // moves, so the last published delta simply stops arriving.
    this.lastByIndex.delete(index);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Joystick scheme: portrait top half (y < 0.5), landscape right half (x >= 0.5).
   * TapToMove: the whole screen. HoldToMove: nowhere.
   */
  private isInCameraZone(pos: Vec2): boolean {
    switch (getTouchMovementScheme()) {
      case TouchMovementScheme.TapToMove:
        return true;
      case TouchMovementScheme.HoldToMove:
        return false;
      default:
        return this.landscape ? pos.x >= 0.5 : pos.y < 0.5;
    }
  }
}
