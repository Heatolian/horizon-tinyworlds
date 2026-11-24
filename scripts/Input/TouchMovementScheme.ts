/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v15

/**
 * Which touch control moves the player, shared by the touch controls so one
 * setting switches the whole scheme. `LocomotionSettingsComponent.locomotionMode`
 * sets it at start; each control reads it, and listens for changes, so their
 * start order does not matter.
 *
 * | Scheme | Moves the player | Turns the camera |
 * |---|---|---|
 * | Joystick | `TouchJoystick` in the movement zone | `TouchCameraLook` in the other half |
 * | TapToMove | A tap on the world (`ClickToMoveController` via `TouchTapTarget`) | `TouchCameraLook` anywhere on screen |
 * | HoldToMove | `TouchHoldToMove`: run towards the held finger | Nothing; pair with a fixed-angle camera |
 */
export enum TouchMovementScheme {
  Joystick = 0,
  TapToMove = 1,
  HoldToMove = 2,
}

type SchemeListener = (scheme: TouchMovementScheme) => void;

let current: TouchMovementScheme = TouchMovementScheme.Joystick;
const listeners: SchemeListener[] = [];

export function getTouchMovementScheme(): TouchMovementScheme {
  return current;
}

/** Switch scheme and tell every listener. Setting the current scheme again does nothing. */
export function setTouchMovementScheme(scheme: TouchMovementScheme): void {
  if (scheme === current) {
    return;
  }
  current = scheme;
  for (const listener of listeners.slice()) {
    listener(scheme);
  }
}

/** Call `listener` whenever the scheme changes. Returns an unsubscribe function. */
export function onTouchMovementSchemeChanged(listener: SchemeListener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) {
      listeners.splice(at, 1);
    }
  };
}
