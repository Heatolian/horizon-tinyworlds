/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {
  Component,
  component,
  subscribe,
  NetworkMode,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  Quaternion,
  TransformComponent,
  WorldService,
  type Entity,
  type Maybe,
  type TemplateAsset,
  Vec3,
} from 'meta/worlds';
import {applyBlast} from './DeployableBlast';
import type {BlastFilter, BlastHit} from './DeployableBlast';

/** A patch of ground that keeps acting on whoever stands in it. */
export interface AreaConfig {
  /** Metres. Everything inside is considered on every pulse. */
  radius: number;

  /** Seconds before the area despawns. 0 leaves it to the caller to destroy. */
  durationSeconds: number;

  /** Seconds between pulses. The first pulse fires one interval after spawning. */
  intervalSeconds: number;

  /** Whoever placed it, when it should not affect them. */
  instigator?: Entity;

  /** Omit to affect anything with a GASComponent. */
  targetFilter?: BlastFilter;

  /** Fire keeps burning through smoke; leave off unless the area needs cover rules. */
  requireLineOfSight?: boolean;

  /** Invoked once per distinct target, per pulse. */
  onPulse(hit: BlastHit): void;
}

/**
 * A lingering area — burning ground, a healing pool, a gas cloud.
 *
 * Each pulse is a fresh {@link applyBlast}, which is what makes eligibility
 * re-checked for free: a target that changed sides, or whose GAS was not ready
 * when the area landed, is simply re-evaluated on the next pulse rather than
 * being frozen into a list at spawn time.
 *
 * Deliberately pulse-only. An aura that grants on entry and revokes on exit
 * needs a handle on the applied effect, and `applyEffectToTarget` returns null
 * for a target owned by another client — so revocation cannot be implemented
 * honestly until GAS state lives somewhere the placer's authority also owns.
 */
@component({
  description: 'A lingering area that pulses an effect onto whoever is inside it.',
})
export class DeployableArea extends Component {
  private config: AreaConfig | null = null;
  private transform: TransformComponent | null = null;
  private ageSec: number = 0;
  private nextPulseAtSec: number = 0;
  private pulsing: boolean = false;

  /** Called by whatever placed it, right after spawning. */
  public configure(config: AreaConfig): void {
    this.config = config;
    this.nextPulseAtSec = this.ageSec + Math.max(config.intervalSeconds, 0);
  }

  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(payload: OnWorldUpdateEventPayload): void {
    const config = this.config;
    if (!config || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.ageSec += payload.deltaTime;

    if (config.durationSeconds > 0 && this.ageSec >= config.durationSeconds) {
      this.entity.destroy();
      return;
    }
    if (config.intervalSeconds <= 0 || this.ageSec < this.nextPulseAtSec) {
      return;
    }
    this.nextPulseAtSec = this.ageSec + config.intervalSeconds;
    this.pulse(config);
  }

  /**
   * One pulse. Skipped while a previous one is still resolving: the query is
   * asynchronous, and a short interval over a crowded area would otherwise
   * stack overlapping pulses and apply the effect several times per tick.
   */
  private pulse(config: AreaConfig): void {
    if (this.pulsing) {
      return;
    }
    if (!this.transform) {
      this.transform = this.entity.getComponent(TransformComponent);
    }
    const at = this.transform?.worldPosition;
    if (!at) {
      return;
    }
    this.pulsing = true;
    void applyBlast(
      {
        radius: config.radius,
        source: this.entity,
        instigator: config.instigator,
        targetFilter: config.targetFilter,
        requireLineOfSight: config.requireLineOfSight,
        onTarget: (hit: BlastHit): void => config.onPulse(hit),
      },
      at,
    )
      .catch((error: unknown): void => {
        console.error('[DeployableArea] pulse failed to resolve:', error);
      })
      .finally((): void => {
        this.pulsing = false;
      });
  }
}

/**
 * Spawn a lingering area at a resolve point and start it pulsing.
 *
 * A free function for the same reason the throw is: a barrel that catches fire
 * or a scripted hazard should be able to leave an area behind without going
 * through a throwable.
 */
export async function spawnArea(
  template: Maybe<TemplateAsset>,
  at: Vec3,
  config: AreaConfig,
): Promise<void> {
  if (!template) {
    return;
  }
  const entity = await WorldService.get().spawnTemplate({
    templateAsset: template,
    networkMode: NetworkMode.Networked,
    position: at,
    rotation: Quaternion.identity,
  });
  const area = entity.getComponent(DeployableArea) ??
    entity.getChildrenWithComponent(DeployableArea, true)[0]?.getComponent(DeployableArea);
  if (!area) {
    console.error('[DeployableArea] template is missing the DeployableArea component; not placed.');
    entity.destroy();
    return;
  }
  area.configure(config);
}
