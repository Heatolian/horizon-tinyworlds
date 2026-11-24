/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v38

import {addWeaponNoiseListener, type WeaponNoise} from '../../ItemSystem/features/Weapon';
import {NoiseService, type Noise} from './NoiseService';

/** A loud weapon moment as a noise: a round is a gunshot, a detonation an explosion. */
export function noiseOfWeapon(noise: WeaponNoise): Noise {
  return {
    kind: noise.kind === 'shot' ? 'gunshot' : 'explosion',
    position: noise.position,
    ray: noise.ray,
    instigator: noise.character,
    loudness: noise.loudness,
  };
}

let hearing = false;

/** Reports every loud round and detonation the server accepts to `NoiseService`. Idempotent. */
export function hearWeapons(): void {
  if (!hearing) {
    hearing = true;
    addWeaponNoiseListener(noise => NoiseService.get().report(noiseOfWeapon(noise)));
  }
}
