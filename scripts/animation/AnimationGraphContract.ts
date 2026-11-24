/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */

// Animation Scripts v5

// Values are authored graph names, so they keep the assets' capitalisation.
/* eslint-disable @typescript-eslint/naming-convention */

/** Base-graph bools and triggers replicated through character state replication. */
export class AnimKey {
  static readonly IS_GROUNDED = 'IsGrounded';
  static readonly IS_JUMPING = 'IsJumping';
  static readonly IS_RECENTLY_GROUNDED = 'IsRecentlyGrounded';
  static readonly JUMP_TRIGGER = 'JumpTrigger';
}

/** Base-graph values derived locally from movement on every client. */
export class AnimVar {
  static readonly SPEED = 'Speed';
  static readonly MOVEMENT_DIRECTION_YAW = 'MovementDirectionYaw';
  static readonly SHOULD_STRAFE = 'ShouldStrafe';
}

/* eslint-enable @typescript-eslint/naming-convention */
