/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v9

import type {Entity, RemapPageAsset} from 'meta/worlds';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';

/** A feature module may control zero, one, or several Animator layers. */
export interface AnimationModule {
  readonly netKeys?: readonly string[];
  readonly actions?: readonly string[];

  attach(context: AnimationContext): void;
  onCharacterStart?(characterRootEntity: Entity): void;
  onCharacterReady?(characterRootEntity: Entity, characterSimulatedEntity: Entity): void;
  onOwnerUpdate?(frame: AnimationFrame): void;
  onUpdate?(frame: AnimationFrame): void;
  onTagsChanged?(): void;
  onNetValue?(key: string, value: ReplicatedValue, replayed: boolean): void;
  onNetTrigger?(key: string): void;

  request?(action: string): void;
  interrupt?(action: string): void;
  setActive?(action: string, active: boolean): void;
  isActive?(action: string): boolean;
  tune?(action: string, key: string, value: number): void;
}

export interface MountLayerOptions {
  readonly optional?: boolean;
  readonly initialWeight?: number;
  readonly initialMaskWeight?: number;
}

export interface PlayOptions {
  readonly startPhase?: number;
  readonly transitionTimeSec?: number;
}

/** Shared Animator and replication operations supplied by the character host. */
export interface AnimationContext {
  mountLayer(layerName: string, options?: MountLayerOptions): boolean;
  playState(layerName: string, stateName: string, options?: PlayOptions): void;
  /** The layer's current state, or null when the Animator cannot report it. */
  currentState(layerName: string): string | null;
  setLayerWeight(layerName: string, weight: number, fadeTimeSec?: number): void;
  setLayerMaskWeight(layerName: string, weight: number, fadeTimeSec?: number): void;
  setGraphVariable(name: string, value: number | boolean): void;
  /** Adds a remap page at `priority` (0 to 255, highest checked first). A page whose name is already added is ignored. */
  addRemapper(page: RemapPageAsset, priority: number): void;
  removeRemapper(page: RemapPageAsset): void;

  fireNet(key: string): void;
  setNet(key: string, value: ReplicatedValue): void;
  setTag(tag: string, raised: boolean): void;
  hasTag(tag: string): boolean;
}

export interface AnimationFrame {
  readonly deltaTime: number;
  readonly speed: number;
  readonly maskRamp: number;
}

/** Stable gameplay intents used by callers that do not own an animation module. */
/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class AnimationAction {
  static readonly MELEE = 'melee';
  static readonly RANGED = 'ranged';
  static readonly FLINCH = 'flinch';
  static readonly DEATH = 'death';
}

/** Cross-module state used for synchronous visual arbitration. */
export class AnimationTag {
  static readonly DEAD = 'anim.dead';
}
/* eslint-enable @typescript-eslint/naming-convention */
