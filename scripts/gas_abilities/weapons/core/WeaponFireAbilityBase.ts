/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v13

import {TransformComponent, type Vec3} from 'meta/worlds';
import {GASAbility} from '../../../gas/abilities/GASAbility';
import {GASComponent} from '../../../gas/core/GASComponent';
import {DEAD_TAG} from '../../../Character/gas/CharacterTags';
import {applyConeSpread} from './Spread';
import type {Aim} from './AimProvider';

/**
 * What every weapon shot has in common, whatever finally delivers it. A
 * delivery-specific config extends this with its own payload — a trace range,
 * a projectile template, a beam width.
 */
export interface WeaponFireConfigBase {
  /** Muzzle position. Defaults to the owner's world position. */
  origin?: Vec3;

  /** Aim direction, need not be normalized. Defaults to the owner's forward. */
  direction?: Vec3;

  /** Deliveries per round. >1 = shotgun cone. */
  pelletCount?: number;

  /** Cone half-angle (degrees); 0 = perfectly accurate. */
  spreadDeg?: number;

  /**
   * Rounds per activation. 1 = semi/auto; N = burst. The cooldown is committed
   * once per activation, so set it to at least
   * `(burstCount - 1) * burstIntervalSec` or bursts overlap.
   */
  burstCount?: number;

  /** Seconds between burst rounds, in game time. 0 = one frame. */
  burstIntervalSec?: number;

  /**
   * Re-resolve aim for a round that leaves the muzzle on a later frame: a burst
   * round, or round 0 after a wind-up. Omit to fire along the direction
   * captured at activation (after a wind-up, an omitted `origin` / `direction`
   * is re-read from the owner's transform instead).
   */
  refreshAim?(): Aim | null;

  /**
   * Game seconds between activation and the first round: the wind-up before
   * contact. Ending the ability inside it cancels the shot.
   */
  windupSec?: number;

  /**
   * Animation event that ends the wind-up early: the first round leaves when the
   * holder's animation fires it ({@link WeaponFireAbilityBase.handleAnimationEvent}),
   * and `windupSec` is then only the latest it may leave. Set from the delivery's
   * own name for that moment, e.g. a throw's `releaseEvent`. Animation events
   * reach clients only, so a shot fired on the server always waits out `windupSec`.
   */
  windupEndEvent?: string;

  /**
   * Game seconds the ability stays active after the last round, so `isActive`
   * refuses re-entry while the swing or throw recovers.
   */
  recoverySec?: number;
}

/** Supplies the per-shot config. Implemented by the weapon component. */
export interface WeaponConfigProvider<TConfig extends WeaponFireConfigBase> {
  /**
   * `firing` is true when the shot is being fired (the activation), false or
   * absent for a readiness check, which must not change any state.
   */
  buildFireConfig(firing?: boolean): TConfig | null;

  /** Presentation edge emitted once per round, before any pellets are delivered. */
  onRoundFired?(origin: Vec3, direction: Vec3): void;

  /**
   * The shot built by `buildFireConfig(true)` ended before any round left
   * (cancelled in its wind-up, or the holder died), so whatever building it
   * claimed can be given back.
   */
  onShotCancelled?(): void;
}

interface PendingDelay {
  remaining: number;
  resolve: () => void;
  /** The wind-up's delay, which this animation event can end early. */
  endedBy?: string;
}

/**
 * Everything a weapon shot does EXCEPT deliver it: cooldown gating, burst
 * rounds, one delivery per pellet inside a spread cone, muzzle resolution, and
 * ending the ability exactly once when the whole burst finishes.
 *
 * Subclasses implement {@link deliver} — trace a ray, launch a projectile, open
 * a beam. That single method is the entire difference between weapon families;
 * everything above it is identical, which is why it lives here rather than
 * being written once per family.
 *
 * Burst spacing runs on GAME time via {@link tick}, not wall clock, so a stalled
 * or slowed update loop cannot desynchronise it from the ability cooldown.
 */
export abstract class WeaponFireAbilityBase<
  TConfig extends WeaponFireConfigBase,
> extends GASAbility {
  public configProvider: WeaponConfigProvider<TConfig> | null = null;
  private pendingDelay: PendingDelay | null = null;
  private activation: number = 0;
  private delivered: boolean = false;
  /** A shot was built for the current activation and has not ended yet. */
  private shotPending: boolean = false;
  private warnedNoWindupEnd: boolean = false;

  /**
   * Send one pellet on its way. Called `pelletCount` times per round, each with
   * its own spread-perturbed direction. Applies no damage — the game does that
   * from the config's own hit callback. An implementation that awaits before
   * reporting a hit takes {@link activationToken} first and reports nothing
   * once {@link isCurrentActivation} turns false.
   */
  protected abstract deliver(config: TConfig, origin: Vec3, direction: Vec3): Promise<void>;

  /**
   * True while active and no round has been sent yet. A round counts as sent
   * when its delivery starts, before a sweep or raycast resolves or a
   * projectile spawns, so this is the window in which ending the ability is
   * guaranteed to land nothing.
   */
  public get isPreDelivery(): boolean {
    return this.isActive && !this.delivered;
  }

  /**
   * Whether the current or most recent activation sent a round, which is not
   * whether it hit: a sweep or raycast ended while its query is in flight
   * reports no hit yet still counts as sent. Still readable from an
   * `onAbilityEnded` listener, which runs before `onEnd`.
   */
  public get hasDelivered(): boolean {
    return this.delivered;
  }

  /** Identifies the activation delivering now. */
  protected get activationToken(): number {
    return this.activation;
  }

  /** False once the activation that issued `token` has ended or been replaced. */
  protected isCurrentActivation(token: number): boolean {
    return this.activation === token;
  }

  /** The GASComponent this ability was granted on. */
  protected get ownerGas(): GASComponent {
    return this.owner as unknown as GASComponent;
  }

  /**
   * Reject before the cost is paid and the cooldown starts, so a rejected frame
   * costs nothing. Guards on `isActive` rather than a state tag: a burst spans
   * frames, and a tag write per shot would republish the owner's whole
   * replicated tag set — every frame, on an automatic weapon.
   *
   * The config is deliberately rebuilt in {@link onActivate}: reusing the one
   * probed here would fire a stale aim after a speculative `canActivateAbility`.
   */
  public override canActivate(): boolean {
    if (this.isActive) {
      return false;
    }
    return this.configProvider?.buildFireConfig() != null;
  }

  public override onActivate(_userData: unknown): void {
    // An onAbilityEnded listener can re-activate before the ending activation's
    // onEnd runs, so the previous activation is retired here as well, its
    // unfired shot giving back its claim before this shot claims.
    this.endShot();
    this.retireActivation();
    const config = this.configProvider?.buildFireConfig(true);
    if (!config) {
      this.owner.endAbility(this.data.abilityId);
      return;
    }
    this.delivered = false;
    this.shotPending = true;
    // Nothing awaits this promise, so a rejection would otherwise surface as an
    // unhandled rejection with no attribution.
    void this.fire(config, this.activation).catch((error: unknown): void => {
      console.error('[Weapon] shot failed to resolve:', error);
    });
  }

  /**
   * Lets a wind-up waiting on `name` (its config's `windupEndEvent`) go now. Any
   * other event, or one outside a wind-up, is ignored.
   */
  public handleAnimationEvent(name: string): void {
    const delay = this.pendingDelay;
    if (delay?.endedBy == null || delay.endedBy !== name) {
      return;
    }
    this.pendingDelay = null;
    delay.resolve();
  }

  /** Advances a wind-up, a burst waiting between rounds, or a recovery. */
  public override tick(delta: number): void {
    const delay = this.pendingDelay;
    if (!delay) {
      return;
    }
    delay.remaining -= delta;
    if (delay.remaining <= 0) {
      this.pendingDelay = null;
      if (delay.endedBy != null && !this.warnedNoWindupEnd) {
        this.warnedNoWindupEnd = true;
        console.warn(
          `[Weapon] '${this.data.abilityId}' waited out its wind-up: no '${delay.endedBy}' animation event arrived. Either its animation did not play, or this is the server, which receives none.`,
        );
      }
      delay.resolve();
    }
  }

  /**
   * Release a pending delay and retire this activation. Without the release, an
   * ability ended from outside (death, stagger, weapon swap) leaves `fire`
   * parked on a promise that never settles. Bumping `activation` makes the
   * released `fire` stop instead of delivering the rest of the shot.
   */
  public override onEnd(): void {
    // Re-activated from an onAbilityEnded listener: that activation already
    // retired this one, and the pending delay now belongs to it.
    if (this.isActive) {
      return;
    }
    this.endShot();
    this.retireActivation();
  }

  /** Ends the current activation's shot, telling the provider when no round of it left. */
  private endShot(): void {
    if (this.shotPending && !this.delivered) {
      this.configProvider?.onShotCancelled?.();
    }
    this.shotPending = false;
  }

  private retireActivation(): void {
    this.activation++;
    const delay = this.pendingDelay;
    this.pendingDelay = null;
    delay?.resolve();
  }

  private async fire(config: TConfig, activation: number): Promise<void> {
    const owner = this.ownerGas;
    const ended = (): boolean => this.activation !== activation;
    try {
      const configuredAim = (): Aim | null => {
        if (config.origin && config.direction) {
          return {origin: config.origin, direction: config.direction};
        }
        const transform = owner.entity.getComponent(TransformComponent);
        if (!transform) {
          return null;
        }
        return {
          origin: config.origin ?? transform.worldPosition,
          direction: config.direction ?? transform.worldForward,
        };
      };
      const initialAim = configuredAim();
      if (!initialAim) {
        return;
      }
      let origin = initialAim.origin;
      let direction = initialAim.direction.normalize();
      const rounds = Math.max(1, Math.floor(config.burstCount ?? 1));
      const interval = Math.max(0, config.burstIntervalSec ?? 0);
      const windup = Math.max(0, config.windupSec ?? 0);
      const recovery = Math.max(0, config.recoverySec ?? 0);

      if (windup > 0) {
        await this.delayGameSeconds(windup, config.windupEndEvent);
        if (ended()) {
          return;
        }
        // Round 0 now leaves on a later frame, so it is aimed then.
        const aim = config.refreshAim?.() ?? configuredAim();
        if (aim) {
          origin = aim.origin;
          direction = aim.direction.normalize();
        }
      }

      for (let round = 0; round < rounds; round++) {
        // Rounds land on later frames; the shooter can despawn mid-burst, or die
        // during the wind-up or a burst, which `blockedByTags` (read only at
        // activation) cannot catch.
        if (owner.entity.isDestroyed() || owner.hasTag(DEAD_TAG)) {
          return;
        }

        if (round > 0 && config.refreshAim) {
          const aim = config.refreshAim();
          if (aim) {
            origin = aim.origin;
            direction = aim.direction.normalize();
          }
        }
        this.delivered = true;
        this.configProvider?.onRoundFired?.(origin, direction);
        await this.fireRound(config, origin, direction);
        // Checked before parking again: a delay set after the end is never
        // ticked, and would overwrite the next activation's pending delay.
        if (ended()) {
          return;
        }
        if (round < rounds - 1 && interval > 0) {
          await this.delayGameSeconds(interval);
          if (ended()) {
            return;
          }
        }
      }

      if (recovery > 0 && !owner.entity.isDestroyed()) {
        await this.delayGameSeconds(recovery);
      }
    } finally {
      // In `finally` so every exit path — normal finish, no-transform bail,
      // mid-burst despawn — ends the ability exactly once. An activation ended
      // from outside is skipped: the ability may already be active again.
      if (!ended()) {
        this.owner.endAbility(this.data.abilityId);
      }
    }
  }

  /**
   * One round: a single delivery, or `pelletCount` of them across a cone.
   * Spread applies to a single-pellet weapon too — that is per-shot inaccuracy,
   * the only thing `spreadDeg` can mean with one pellet.
   */
  private async fireRound(config: TConfig, origin: Vec3, direction: Vec3): Promise<void> {
    const pellets = Math.max(1, Math.floor(config.pelletCount ?? 1));
    const spreadDeg = config.spreadDeg ?? 0;
    const sent: Array<Promise<void>> = [];
    for (let i = 0; i < pellets; i++) {
      const dir = spreadDeg > 0 ? applyConeSpread(direction, spreadDeg) : direction;
      sent.push(this.deliver(config, origin, dir));
    }
    await Promise.all(sent);
  }

  private delayGameSeconds(seconds: number, endedBy?: string): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      this.pendingDelay = {remaining: seconds, resolve, endedBy};
    });
  }
}
