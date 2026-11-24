/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v4

import {Vec3, type Entity, type Maybe} from 'meta/worlds';
import type {EffectActor} from '../core/EffectContext';

/**
 * Presentation data passed to a cue handler when a cue fires. Target / source
 * carry GAS identity, while sourceObject identifies the gameplay object whose
 * presentation should consume the cue. Spatial fields are copied by value.
 */

export interface GameplayCueContextInit {
  target?: EffectActor | null;
  source?: EffectActor | null;
  sourceObject?: Maybe<Entity>;
  location?: Vec3;
  normal?: Vec3;
  magnitude?: number;
}

export class GameplayCueContext {
  public target: EffectActor | null;
  public source: EffectActor | null;
  public sourceObject: Maybe<Entity>;
  public location: Vec3;
  public normal: Vec3;
  public magnitude: number;
  /** False when no location was given, so `location` is only the zero default. */
  public readonly hasLocation: boolean;

  constructor(init: GameplayCueContextInit = {}) {
    this.target = init.target ?? null;
    this.source = init.source ?? null;
    this.sourceObject = init.sourceObject ?? null;
    this.hasLocation = init.location != null;
    this.location = init.location ?? Vec3.zero;
    this.normal = init.normal ?? new Vec3(0, 1, 0);
    this.magnitude = init.magnitude ?? 0;
  }
}
