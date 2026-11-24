/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v18

import {
  component,
  Component,
  subscribe,
  ExecuteOn,
  NetworkingService,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  OnTouchInputStartedEvent,
  OnTouchInputMovedEvent,
  OnTouchInputEndedEvent,
  Vec2,
} from 'meta/worlds';
import type {Maybe, TouchInputEventPayload} from 'meta/worlds';

// ============================================================================
// Public routing types (see "How a touch is routed" in scripts/Input/README.md)
// ============================================================================

/** How a control behaves when the finger driving it moves. */
export enum TouchHoldMode {
  /**
   * Deactivate the moment the finger leaves the control's hit region. Its
   * `onEnd` fires on drag-off and it stops receiving moves. Use for buttons.
   */
  DeactivateOnDragOff = 0,
  /**
   * Keep the finger until it is released, even if it drags outside the hit
   * region. Use for a joystick or a camera-look drag.
   */
  HoldUntilRelease = 1,
}

/**
 * Per-control touch callbacks, keyed by finger index. Each handler is told
 * `alreadyConsumed`: true when a HIGHER-zPriority control already consumed this
 * touch. A handler RETURNS true if it consumes the touch itself, so every lower
 * control then sees `alreadyConsumed=true` and can stand down; returning
 * void/false does not consume. This mirrors the native TouchInputLayerManager
 * consume chain: every layer still sees the touch and only claims it on genuine
 * handling.
 */
export type TouchControlHandlers = {
  onStart?(index: number, pos: Vec2, alreadyConsumed: boolean): boolean | void;
  onMove?(index: number, pos: Vec2, alreadyConsumed: boolean): boolean | void;
  onEnd?(index: number, pos: Vec2, alreadyConsumed: boolean): boolean | void;
  /**
   * Called instead of `onEnd` when the router ABANDONS a finger whose `Ended`
   * never arrived (an OS interruption, then the same index reused by a new
   * touch). This is a cancellation, not a release: a control MUST only drop its
   * per-finger state and MUST NOT produce a gesture effect (no action trigger, no
   * raycast). A control with no `onCancel` falls back to `onEnd`, which is
   * correct for controls whose `onEnd` is pure cleanup (joystick, camera-look,
   * buttons); a control that FIRES on `onEnd` (the tap-to-world layer) must
   * implement `onCancel` to avoid a phantom gesture.
   */
  onCancel?(index: number): void;
};

/** A layered touch control registered with the {@link TouchRouter}. */
export interface TouchControlDescriptor {
  /** Unique id; re-registering the same id replaces the descriptor. */
  id: string;
  /** Higher is offered the touch first, and its consume is seen by lower ones. */
  zPriority: number;
  /** Drag-off vs hold-until-release semantics. */
  holdMode: TouchHoldMode;
  /** Normalized-screen-space hit test for the touch-down point. */
  hitTest: (pos: Vec2) => boolean;
  /** Touch callbacks. */
  handlers: TouchControlHandlers;
}

// ============================================================================
// TouchRouter — the single OnTouchInput* owner and layered dispatcher
//
// Every touch control (joystick, camera-look, HUD buttons, tap-target) registers
// a descriptor here instead of subscribing to the raw OnTouchInput* events. The
// router owns the one subscription and OFFERS each finger to every control under
// it in zPriority order (highest first), threading a `consumed` flag: a control
// that genuinely handles the touch returns true, and every LOWER control is then
// told alreadyConsumed=true so it can stand down. Unlike a hard consume, the
// router never stops dispatching -- a lower control still receives the event and
// decides for itself. This is the native TouchInputLayerManager model: the
// movement joystick never consumes, a button consumes its own press (a
// pass-through button, such as Use in landscape, its release instead), and the
// tap-to-world layer consumes only when a subscriber handles the hit.
//
// STATIC REGISTRATION BEFORE THE INSTANCE EXISTS: controls register in their
// OnEntityStartEvent, which can run before the router entity's create. So
// register()/unregister() operate on the live instance if present, else on a
// static pending list the instance adopts when it initializes. Control start
// ordering therefore does not matter.
// ============================================================================

@component()
export class TouchRouter extends Component {
  /** Global access point to the single router instance. */
  public static instance: Maybe<TouchRouter> = null;

  // Descriptors registered before the instance exists (or after it is torn
  // down). Adopted into `registry` on create.
  private static pending: Map<string, TouchControlDescriptor> = new Map();

  private registry: Map<string, TouchControlDescriptor> = new Map();
  // interactionIndex -> owning control ids, in zPriority (highest-first) order.
  private owners: Map<number, string[]> = new Map();

  // --------------------------------------------------------------------------
  // Registration (static so controls can register before the instance exists)
  // --------------------------------------------------------------------------

  /** Register (or replace) a control by its `id`. */
  public static register(desc: TouchControlDescriptor): void {
    if (TouchRouter.instance != null) {
      TouchRouter.instance.registry.set(desc.id, desc);
    } else {
      TouchRouter.pending.set(desc.id, desc);
    }
  }

  /**
   * Remove a control by its `id`. Safe if it was never registered. Also scrubs
   * the id from any in-flight finger's owner list so a control unregistered
   * mid-touch does not linger there until the finger lifts. The control releases
   * its own held state in its onDestroy; the router does not call `onEnd` on an
   * unregistering control (it is tearing down).
   */
  public static unregister(id: string): void {
    if (TouchRouter.instance != null) {
      TouchRouter.instance.registry.delete(id);
      TouchRouter.instance.scrubOwner(id);
    } else {
      TouchRouter.pending.delete(id);
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
  onCreate(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    TouchRouter.instance = this;
    // Adopt anything registered before this instance existed.
    for (const [id, desc] of TouchRouter.pending) {
      this.registry.set(id, desc);
    }
    TouchRouter.pending.clear();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    // Move the live registry back to pending so a later instance re-adopts it.
    // Controls must unregister in their own onDestroy first, or a stale descriptor lingers.
    for (const [id, desc] of this.registry) {
      TouchRouter.pending.set(id, desc);
    }
    this.registry.clear();
    this.owners.clear();
    TouchRouter.instance = null;
  }

  // --------------------------------------------------------------------------
  // Touch dispatch
  // --------------------------------------------------------------------------

  @subscribe(OnTouchInputStartedEvent, {execution: ExecuteOn.Everywhere})
  onStart(payload: TouchInputEventPayload): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;

    // Interruption guard: a prior finger reusing this index never ended (there
    // is no touch-cancel event, and Ended is not guaranteed on OS
    // interruptions). CANCEL its owners first so nothing is left stuck active.
    // This is a cancellation, not a release: prefer onCancel so a control drops
    // its finger state WITHOUT producing a gesture effect. Reusing onEnd here
    // (with the NEW touch's position) would let the tap-to-world layer classify a
    // phantom tap and raycast. Controls with no onCancel fall back to onEnd,
    // whose cleanup is position-independent for them.
    const stale = this.owners.get(idx);
    if (stale != null) {
      let staleConsumed = false;
      for (const id of stale) {
        const handlers = this.registry.get(id)?.handlers;
        if (handlers?.onCancel != null) {
          handlers.onCancel(idx);
        } else {
          const r: boolean | void = handlers?.onEnd?.(idx, pos, staleConsumed);
          staleConsumed = staleConsumed || r === true;
        }
      }
      this.owners.delete(idx);
    }

    // Every control under the finger, highest zPriority first. Array.sort is
    // stable, so equal-priority controls stay in registration order. Offer the
    // touch down the stack, threading `consumed`: a control that handles it
    // returns true and every lower control is told alreadyConsumed. All hit
    // controls become owners and see the touch; a lower one stands down itself.
    const hits: TouchControlDescriptor[] = [];
    for (const desc of this.registry.values()) {
      if (desc.hitTest(pos)) {
        hits.push(desc);
      }
    }
    hits.sort((a, b) => b.zPriority - a.zPriority);

    const ownerIds: string[] = [];
    let consumed = false;
    for (const desc of hits) {
      const r: boolean | void = desc.handlers.onStart?.(idx, pos, consumed);
      consumed = consumed || r === true;
      ownerIds.push(desc.id);
    }
    this.owners.set(idx, ownerIds);
  }

  @subscribe(OnTouchInputMovedEvent, {execution: ExecuteOn.Everywhere})
  onMove(payload: TouchInputEventPayload): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;
    const ids = this.owners.get(idx);
    if (ids == null) {
      return;
    }
    // Copy first: a DeactivateOnDragOff control may drop itself mid-iteration.
    // Owners are fixed at touch-down (minus drag-off drops), in zPriority order;
    // a move never re-acquires a control the finger newly dragged over. Thread
    // `consumed` down the same order so a lower control sees whether a higher
    // one owns this finger.
    let consumed = false;
    for (const id of ids.slice()) {
      const desc = this.registry.get(id);
      if (desc == null) {
        continue;
      }
      if (
        desc.holdMode === TouchHoldMode.HoldUntilRelease ||
        desc.hitTest(pos)
      ) {
        const r: boolean | void = desc.handlers.onMove?.(idx, pos, consumed);
        consumed = consumed || r === true;
      } else {
        // DeactivateOnDragOff dragged off: deactivate this control for this finger.
        // Its onEnd may consume, so thread the result on to lower controls.
        const r: boolean | void = desc.handlers.onEnd?.(idx, pos, consumed);
        consumed = consumed || r === true;
        this.removeOwner(idx, id);
      }
    }
  }

  @subscribe(OnTouchInputEndedEvent, {execution: ExecuteOn.Everywhere})
  onEnd(payload: TouchInputEventPayload): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;
    const ids = this.owners.get(idx);
    if (ids != null) {
      let consumed = false;
      for (const id of ids) {
        const r: boolean | void = this.registry.get(id)?.handlers.onEnd?.(idx, pos, consumed);
        consumed = consumed || r === true;
      }
    }
    this.owners.delete(idx);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  // Remove an id from every finger's owner list, used when a control
  // unregisters mid-touch so no stale id lingers until the finger lifts.
  private scrubOwner(id: string): void {
    for (const idx of [...this.owners.keys()]) {
      this.removeOwner(idx, id);
    }
  }

  private removeOwner(idx: number, id: string): void {
    const ids = this.owners.get(idx);
    if (ids == null) {
      return;
    }
    const at = ids.indexOf(id);
    if (at >= 0) {
      ids.splice(at, 1);
    }
    if (ids.length === 0) {
      this.owners.delete(idx);
    }
  }
}
