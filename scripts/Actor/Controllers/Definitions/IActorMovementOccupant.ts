/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

/**
 * Optional marker for a controller that registers under
 * `ActorMovementControllerTypeId` to share the movement arbitration axis but
 * cannot move the body: `ActorJumpController` drives only the vertical axis
 * and `ActorDodgeController` only its burst, both with a no-op
 * `moveToPosition`. A "has a mover" check counts controllers on that axis, so
 * without the marker a jump-only actor that cannot walk looks correctly
 * configured. Real movers do not implement it.
 */
export interface IActorMovementOccupant {
  readonly providesLocomotion: false;
}

/** Whether a controller registered on the movement axis can move the body: false only for an {@link IActorMovementOccupant}. */
export function movesTheBody(controller: unknown): boolean {
  return !(
    typeof controller === 'object' &&
    controller !== null &&
    'providesLocomotion' in controller &&
    controller.providesLocomotion === false
  );
}
