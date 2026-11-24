/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v38

import {Service, service, type Entity, type Vec3} from 'meta/worlds';

/** A loud event an NPC can hear. */
export type NoiseKind = 'gunshot' | 'explosion';

/** A shot's path: where the round left and which way it went. */
export interface NoiseRay {
  /** The muzzle, or a player's camera when the weapon aims through it. */
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** One reported noise. */
export interface Noise {
  readonly kind: NoiseKind;
  /** Where the noise is, and is heard around: the shooter, or where the charge went off. */
  readonly position: Vec3;
  /** A shot's path, for the near-miss test; null for a noise with none. */
  readonly ray: NoiseRay | null;
  /** Who made it: the character that fired or threw. */
  readonly instigator: Entity;
  /** Scales how far it carries: 1 is an ordinary gunshot or explosion. Default 1. */
  readonly loudness?: number;
}

export type NoiseListener = (noise: Noise) => void;

/**
 * Where gameplay reports noise for NPC hearing (the role Unreal's
 * `UAISense_Hearing::ReportNoiseEvent` plays). Hearing runs on the server, so
 * noise is reported there; on a client nothing listens. A player's weapon
 * fires on their client and reaches the server through the item system, the
 * way its other reports do; `hearWeapons` passes what arrives on to here.
 */
@service()
export class NoiseService extends Service {
  private readonly listeners: Set<NoiseListener> = new Set<NoiseListener>();

  /** Reports a noise to every listener on this machine; one that throws is logged and skipped. */
  report(noise: Noise): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(noise);
      } catch (error: unknown) {
        console.warn(`[NoiseService] a listener failed on a ${noise.kind}: ${String(error)}`);
      }
    }
  }

  /** Hears every noise reported on this machine; returns its unsubscribe. */
  onNoise(listener: NoiseListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
}
