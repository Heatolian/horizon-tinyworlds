/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v13

import {TransformComponent, Vec3, WorldService, type Entity, type Maybe} from 'meta/worlds';
import {
  DEFAULT_MUZZLE_OFFSET,
  type Aim,
  type AimProvider,
} from '../core/AimProvider';
import {applyConeSpread} from '../core/Spread';
import {nonNegative, ShootingTickets} from './ShootingTickets';

const MIN_DIRECTION_MAGNITUDE_SQUARED = 0.000001;
/** A near miss goes this much farther out than `nearMissMeters` at most, so misses do not all trace one line. */
const NEAR_MISS_SPREAD = 0.5;
/** A near miss rises or dips at most this fraction of `nearMissMeters`. */
const NEAR_MISS_VERTICAL = 0.25;
/** Spread wider than this (degrees) is not cleared: no near miss could clear a cone that wide. */
const MAX_MISS_SPREAD_DEG = 30;

/**
 * Converts a locked target into the ray consumed by every weapon delivery.
 * Target acquisition, body rotation and trigger timing remain controller jobs.
 */
export class TargetAimProvider implements AimProvider {
  private target: Maybe<Entity> = null;
  private targetVelocity: Vec3 | null = null;
  private aimErrorDeg: number = 0;
  private rationHits: boolean = false;
  /** The latest shot's decision ({@link claimShot}), for the target it was made for. */
  private claimed: {target: Maybe<Entity>; mayHit: boolean} | null = null;
  /** Meters a near miss also clears for the latest shot: its splash (a blast, an area). */
  private missClearance: number = 0;
  /** Half-angle (degrees) of the latest shot's spread cone, which a near miss also clears. */
  private missSpreadDeg: number = 0;
  /** Picks the side and size of each near miss; replaceable for tests. */
  public random: () => number = Math.random;

  /**
   * `leadSpeed` is the shot's travel speed in m/s. Positive aims where a target
   * moving at {@link setTargetVelocity} will be when the shot arrives; 0 aims
   * at where it is now, for instant deliveries.
   */
  constructor(
    private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET,
    private readonly targetHeightOffset: number = 1,
    public readonly fallbackProvider: AimProvider | null = null,
    private readonly leadSpeed: number = 0,
  ) {}

  /** A new target drops the previous one's velocity, so set it after this. */
  public setTarget(target: Maybe<Entity>): void {
    if (target !== this.target) {
      this.targetVelocity = null;
    }
    this.target = target;
  }

  /** The target's world velocity in m/s, or null when unknown (no lead). */
  public setTargetVelocity(velocity: Vec3 | null): void {
    this.targetVelocity = velocity;
  }

  public getTarget(): Maybe<Entity> {
    return this.target;
  }

  /**
   * Cone half-angle (degrees) each aim is perturbed within, for an autonomous
   * shooter that should miss sometimes. 0 aims true.
   */
  public setAimErrorDeg(halfAngleDeg: number): void {
    this.aimErrorDeg = Number.isFinite(halfAngleDeg) && halfAngleDeg > 0 ? halfAngleDeg : 0;
  }

  public getAimErrorDeg(): number {
    return this.aimErrorDeg;
  }

  /**
   * Ration hits with shooting tickets ({@link ShootingTickets}), for an NPC
   * shooter: each shot at a player claims that player's ticket
   * ({@link claimShot}), and a shot without one is aimed just beside the
   * target so it flies past. Player aims leave this off.
   */
  public setRationHits(on: boolean): void {
    this.rationHits = on;
  }

  /**
   * A shot is being fired at the target: claims its shooting ticket and fixes
   * whether this shot may hit the target, so every later aim for it (a
   * wind-up's or a burst's later rounds) aims the same way, even across a
   * target switch and back. The shot's `windupSec` times its ticket from
   * when it leaves, and its `burstSec` keeps the ticket until its last round
   * leaves. A near miss also clears its `splashRadius` (a blast or
   * area) and its `spreadDeg` cone, so no pellet or splash catches the
   * target. Call once per shot fired, never for a readiness check. True when
   * the shot may hit; always true without rationing.
   */
  public claimShot(
    owner: Entity,
    shot: {splashRadius?: number; spreadDeg?: number; windupSec?: number; burstSec?: number} = {},
  ): boolean {
    const mayHit =
      !this.rationHits ||
      ShootingTickets.get().claimShot(owner, this.target, WorldService.get().getWorldTime(), {
        releaseDelay: shot.windupSec,
        burstSeconds: shot.burstSec,
      });
    this.claimed = {target: this.target, mayHit};
    this.missClearance = nonNegative(shot.splashRadius);
    this.missSpreadDeg = Math.min(nonNegative(shot.spreadDeg), MAX_MISS_SPREAD_DEG);
    return mayHit;
  }

  /**
   * The latest claimed shot never left (cancelled in its wind-up): gives back
   * what its claim took, whether or not rationing has been turned off since.
   */
  public cancelShot(owner: Entity): void {
    const claimed = this.claimed;
    this.claimed = null;
    if (claimed) {
      ShootingTickets.get().releaseShot(owner);
    }
  }

  /**
   * Whether an aim now may go to the target. A ticketless shot stays a near
   * miss whatever it is switched to mid-shot, as it damages nothing. A shot
   * that may hit keeps aiming true at the target it was claimed for, and at
   * another target only if no ticket protects it or the shooter holds its
   * ticket.
   */
  private mayHitTarget(owner: Entity): boolean {
    if (!this.rationHits) {
      return true;
    }
    if (this.claimed && (!this.claimed.mayHit || this.claimed.target === this.target)) {
      return this.claimed.mayHit;
    }
    return ShootingTickets.get().holds(owner, this.target);
  }

  public get rationsHits(): boolean {
    return this.rationHits;
  }

  public getAim(owner: Entity): Aim | null {
    const ownerTransform = owner.getComponent(TransformComponent);
    const target = this.target;
    const targetTransform = target?.getComponent(TransformComponent) ?? null;
    if (!ownerTransform || !target || target.isDestroyed() || !targetTransform) {
      return this.fallbackProvider?.getAim(owner) ?? null;
    }

    const origin = ownerTransform.worldPosition
      .add(ownerTransform.worldRight.mul(this.muzzleOffset.x))
      .add(ownerTransform.worldUp.mul(this.muzzleOffset.y))
      .add(ownerTransform.worldForward.mul(this.muzzleOffset.z));
    let targetPoint = this.lead(
      origin,
      targetTransform.worldPosition.add(Vec3.up.mul(this.targetHeightOffset)),
    );
    const ticketless = !this.mayHitTarget(owner);
    if (ticketless) {
      const spread = targetPoint.sub(origin).magnitude() * Math.tan((this.missSpreadDeg * Math.PI) / 180);
      targetPoint = this.nearMiss(origin, targetPoint, ShootingTickets.get().settings.nearMissMeters + this.missClearance + spread);
    }
    const direction = targetPoint.sub(origin);
    if (direction.magnitudeSquared() <= MIN_DIRECTION_MAGNITUDE_SQUARED) {
      return this.fallbackProvider?.getAim(owner) ?? null;
    }
    const aimed = direction.normalize();
    // A near miss is the miss: aim error on top could swing it back onto the target.
    return {
      origin,
      direction: this.aimErrorDeg > 0 && !ticketless ? applyConeSpread(aimed, this.aimErrorDeg) : aimed,
    };
  }

  /**
   * A point beside `point`, square to the shot, `meters` to `meters` x 1.5
   * out on a random side and a little up or down, so the round visibly passes
   * the target instead of striking it.
   */
  private nearMiss(origin: Vec3, point: Vec3, meters: number): Vec3 {
    const toward = point.sub(origin);
    let side = toward.cross(Vec3.up);
    if (side.magnitudeSquared() <= MIN_DIRECTION_MAGNITUDE_SQUARED) {
      side = Vec3.right;
    }
    const out = meters * (1 + NEAR_MISS_SPREAD * this.random());
    const sign = this.random() < 0.5 ? -1 : 1;
    const rise = meters * NEAR_MISS_VERTICAL * (2 * this.random() - 1);
    return point.add(side.normalize().mul(sign * out)).add(Vec3.up.mul(rise));
  }

  /**
   * Two-step intercept: estimate the flight time from the straight-line
   * distance, then refine once against the predicted intercept.
   */
  private lead(origin: Vec3, aimPoint: Vec3): Vec3 {
    const velocity = this.targetVelocity;
    if (!velocity || this.leadSpeed <= 0) {
      return aimPoint;
    }
    const firstTime = aimPoint.sub(origin).magnitude() / this.leadSpeed;
    const firstGuess = aimPoint.add(velocity.mul(firstTime));
    const refinedTime = firstGuess.sub(origin).magnitude() / this.leadSpeed;
    return aimPoint.add(velocity.mul(refinedTime));
  }
}
