/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v17

/**
 * MovingPlatformMoverBase
 *
 * Abstract marker base for moving-platform mover components. Movers
 * (spinning, oscillating, orbital, physics-drift) extend this instead of
 * `Component` directly, so `MovingPlatformRideComponent` can detect any mover
 * with `entity.getComponent(MovingPlatformMoverBase)` without importing the
 * concrete mover modules.
 *
 * Why a base class: the ride importing the movers would tie it to movers a
 * world may not carry, and form a manifest-level import cycle (movers import
 * the ride for registration), which the asset processor rejects as a circular
 * target dependency. The base lives beside the ride,
 * so both import directions stay acyclic (movers -> base, ride -> base) and
 * the lazy presence check keeps working on endpoints where a mover's own
 * `onStart` never fires.
 */

import {Component} from 'meta/worlds';

export abstract class MovingPlatformMoverBase extends Component {}
