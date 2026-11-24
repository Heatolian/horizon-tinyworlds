/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {Vec3, type Entity, type Maybe, type TemplateAsset} from 'meta/worlds';
import {throwDeployable} from '../../deployables/ThrowDeployable';
import {WeaponFireAbilityBase} from '../core/WeaponFireAbilityBase';
import type {WeaponConfigProvider, WeaponFireConfigBase} from '../core/WeaponFireAbilityBase';
import type {WeaponAbilitySpec} from '../core/WeaponSetup';

/** What a throw needs on top of the shared weapon config: what to throw, how hard, and what going off means. */
export interface ThrowWeaponFireConfig extends WeaponFireConfigBase {
  /** Needs `GASDeployable` and a DynamicCollider `PhysicsBody`. */
  template: Maybe<TemplateAsset>;

  /** Launch speed in m/s. */
  throwSpeed: number;

  /** Degrees the throw is pitched above the aim, so a level aim still arcs. */
  loftDeg: number;

  fuseSeconds: number;
  resolveOnImpact: boolean;
  despawnDelaySeconds: number;

  /** Runs on the thrower's owner when it goes off, frames or seconds after the throw. */
  onResolve(at: Vec3, hit: Entity | null, self: Entity): void;
}

export type ThrowWeaponConfigProvider = WeaponConfigProvider<ThrowWeaponFireConfig>;

/**
 * Thrown delivery: grenades, molotovs. Cooldown, wind-up and recovery come from
 * {@link WeaponFireAbilityBase}; this class only launches the deployable, whose
 * own fuse takes over from there. It applies no damage itself.
 */
export class WeaponThrowFireAbility extends WeaponFireAbilityBase<ThrowWeaponFireConfig> {
  protected override async deliver(config: ThrowWeaponFireConfig, origin: Vec3, direction: Vec3): Promise<void> {
    await throwDeployable({
      template: config.template,
      instigator: this.ownerGas.entity,
      origin,
      direction: lofted(direction, config.loftDeg),
      throwSpeed: config.throwSpeed,
      fuseSeconds: config.fuseSeconds,
      resolveOnImpact: config.resolveOnImpact,
      despawnDelaySeconds: config.despawnDelaySeconds,
      onResolve: (at: Vec3, hit: Entity | null, self: Entity): void => config.onResolve(at, hit, self),
    });
  }
}

/** The steepest a loft pitches a throw, so a high aim never tips over the top and reverses its heading. */
const MAX_LOFTED_PITCH = (85 * Math.PI) / 180;

/** `direction` pitched up by `degrees`, keeping its heading, at most 85 degrees up; straight up or down is left alone. */
export function lofted(direction: Vec3, degrees: number): Vec3 {
  const horizontal = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
  if (horizontal < 0.000001 || degrees === 0) {
    return direction;
  }
  const aimPitch = Math.atan2(direction.y, horizontal);
  const pitch = Math.max(aimPitch, Math.min(MAX_LOFTED_PITCH, aimPitch + (degrees * Math.PI) / 180));
  const scale = Math.cos(pitch) / horizontal;
  return new Vec3(direction.x * scale, Math.sin(pitch), direction.z * scale);
}

/** Ability pair granted for a thrown weapon. It has no magazine, so the reload id is never granted. */
export const THROW_ABILITIES: WeaponAbilitySpec = {
  fireAbility: WeaponThrowFireAbility,
  fireAbilityName: 'weapon.throw.fire',
  reloadAbilityName: 'weapon.throw.reload',
};
