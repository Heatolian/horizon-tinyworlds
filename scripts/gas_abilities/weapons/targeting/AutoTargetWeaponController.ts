/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v11

import {
  Component,
  component,
  editor,
  ExecuteOn,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  property,
  subscribe,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
  type OnWorldUpdateEventPayload,
} from 'meta/worlds';
import {AutoFaceRotationAbility} from '../../../Character/Abilities/AutoFaceRotationAbility';
import {equippedWeaponOf} from '../../../ItemSystem/features/Weapon';
import type {AimProvider} from '../core/AimProvider';
import {
  allTargetsInRadius,
  hasClearShot,
  type TargetFilter,
} from './Targeting';
import {
  TargetAimProvider,
} from './TargetAimProvider';

const MIN_FIRE_RATE = 0.01;

/** What the controller reads and drives on the ItemSystem weapon in hand. */
export interface AutoTargetWeapon {
  aimProvider: AimProvider | null;
  readonly muzzleOffset: Vec3;
  readonly reach: number;
  readonly targetTag: string;
  readonly fireRate: number;
  fireOnce(): void;
}

/** Allocation-free XZ alignment used by the per-frame controller path. */
export function horizontalDirectionsAligned(
  current: Vec3,
  desiredX: number,
  desiredZ: number,
  toleranceDegrees: number,
): boolean {
  const currentMagSq = current.x * current.x + current.z * current.z;
  const desiredMagSq = desiredX * desiredX + desiredZ * desiredZ;
  if (currentMagSq <= 0.000001 || desiredMagSq <= 0.000001) {
    return false;
  }
  const dot =
    (current.x * desiredX + current.z * desiredZ) /
    Math.sqrt(currentMagSq * desiredMagSq);
  const toleranceRadians =
    (Math.max(0, toleranceDegrees) * Math.PI) / 180;
  return Math.max(-1, Math.min(1, dot)) >= Math.cos(toleranceRadians);
}

/**
 * Owner-side orchestration for automatic targeting and attacking with the
 * ItemSystem weapon in hand.
 *
 * Selection stays in the shared GAS targeting utility; aiming stays in an
 * AimProvider; body rotation stays in AutoFaceRotationAbility; the weapon still
 * owns ammo, cooldown, delivery and damage. Targeting and attacking are
 * independently enabled so games can combine aim assistance with manual fire,
 * or repeatedly fire through the weapon's normal aim without acquiring targets.
 */
@component({
  description:
    'Optionally selects, faces, and aims at a visible GAS target, and independently controls automatic firing for the ItemSystem weapon in hand.',
})
export class AutoTargetWeaponController extends Component {
  @editor({
    description:
      'Select, face, and aim at visible targets. Does not fire automatically.',
  })
  @property()
  public autoTargetEnabled: boolean = false;

  @editor({
    description:
      "Fire automatically at the configured fireRate. Uses auto-target aim when enabled, otherwise the weapon's current aim.",
  })
  @property()
  public autoAttackEnabled: boolean = false;

  @editor({description: 'Maximum target-acquisition radius in meters.'})
  @property()
  public targetRange: number = 30;

  @editor({description: 'Seconds between asynchronous target-selection queries.'})
  @property()
  public targetRefreshIntervalSec: number = 0.15;

  @editor({
    description:
      'Maximum nearest candidates given a line-of-sight check per refresh. Bounds physics work in crowded scenes.',
  })
  @property()
  public maxCandidateChecks: number = 8;

  @editor({description: 'Aim point height above the target root, in meters.'})
  @property()
  public targetHeightOffset: number = 1;

  @editor({description: 'Maximum horizontal facing error allowed before firing.'})
  @property()
  public alignmentToleranceDegrees: number = 4;

  @editor({
    description:
      'Optional GAS tag required on targets. Empty falls back to the held weapon targetTag; if both are empty, automatic targeting stays disabled.',
  })
  @property()
  public requiredTargetTag: string = '';

  @editor({description: 'Optional GAS tag that excludes a target.'})
  @property()
  public blockedTargetTag: string = 'state.dead';

  private facing: Maybe<AutoFaceRotationAbility> = null;
  private transform: Maybe<TransformComponent> = null;
  private weapon: Maybe<AutoTargetWeapon> = null;
  private priorAimProvider: AimProvider | null = null;
  private targetAimProvider: TargetAimProvider | null = null;
  private target: Maybe<Entity> = null;
  private refreshElapsed: number = 0;
  private fireElapsed: number = 0;
  private queryInFlight: boolean = false;
  private fireCheckInFlight: boolean = false;
  private queryGeneration: number = 0;
  private destroyed: boolean = false;
  private targetingOperational: boolean = false;
  private warnedMissingTargetTag: boolean = false;
  private warnedMissingTargetDependencies: boolean = false;
  private facingDirectionX: number = 0;
  private facingDirectionZ: number = 0;
  private hasFacingDirection: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  public onStart(): void {
    this.facing = this.entity.getComponent(AutoFaceRotationAbility);
    this.transform = this.entity.getComponent(TransformComponent);
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  public onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.destroyed) {
      return;
    }
    if (!this.autoTargetEnabled && !this.autoAttackEnabled) {
      this.setTargetingOperational(false);
      this.switchWeapon(null);
      return;
    }

    const heldWeapon: Maybe<AutoTargetWeapon> = equippedWeaponOf(this.entity);
    if (!heldWeapon) {
      this.setTargetingOperational(false);
      this.switchWeapon(null);
      return;
    }
    if (heldWeapon !== this.weapon) {
      this.switchWeapon(heldWeapon);
    }

    const canTarget =
      this.autoTargetEnabled && this.transform != null && this.facing != null;
    this.setTargetingOperational(canTarget);
    if (this.autoTargetEnabled && !canTarget) {
      this.warnMissingTargetDependencies();
      this.fireElapsed = 0;
      return;
    }
    this.warnedMissingTargetDependencies = false;

    if (canTarget) {
      this.refreshElapsed += payload.deltaTime;
      const refreshInterval = Math.max(0.02, this.targetRefreshIntervalSec);
      if (!this.queryInFlight && this.refreshElapsed >= refreshInterval) {
        this.refreshElapsed = 0;
        void this.refreshTarget(heldWeapon).catch((error: unknown): void => {
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- only runs when the asynchronous physics query rejects, not on successful frames.
          console.warn(
            `[AutoTargetWeaponController] target refresh failed: ${String(error)}`,
          );
        });
      }
      this.driveTargetingAndAttack(payload.deltaTime, heldWeapon);
      return;
    }

    if (this.autoAttackEnabled) {
      this.driveCurrentAimAttack(payload.deltaTime, heldWeapon);
    } else {
      this.fireElapsed = 0;
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  public onDestroy(): void {
    this.destroyed = true;
    this.setTargetingOperational(false);
    this.switchWeapon(null);
  }

  private warnMissingTargetDependencies(): void {
    if (this.warnedMissingTargetDependencies) {
      return;
    }
    this.warnedMissingTargetDependencies = true;
    console.warn(
      '[AutoTargetWeaponController] autoTargetEnabled requires AutoFaceRotationAbility and TransformComponent on the same player root.',
    );
  }

  private setTargetingOperational(operational: boolean): void {
    if (operational === this.targetingOperational) {
      return;
    }
    this.targetingOperational = operational;
    if (!operational) {
      this.clearTargetingState();
    }
  }

  private clearTargetingState(): void {
    if (
      this.weapon &&
      this.targetAimProvider != null &&
      this.weapon.aimProvider === this.targetAimProvider
    ) {
      this.weapon.aimProvider = this.priorAimProvider;
    }
    this.facing?.setFacingOverride(null);
    this.target = null;
    this.targetAimProvider = null;
    this.refreshElapsed = 0;
    this.hasFacingDirection = false;
    this.queryGeneration++;
  }

  private switchWeapon(next: Maybe<AutoTargetWeapon>): void {
    if (next === this.weapon) {
      return;
    }
    this.clearTargetingState();
    this.weapon = next;
    const nextAimProvider = next?.aimProvider ?? null;
    this.priorAimProvider =
      nextAimProvider instanceof TargetAimProvider
        ? nextAimProvider.fallbackProvider
        : nextAimProvider;
    this.fireElapsed = 0;
  }

  private targetFilter(weapon: AutoTargetWeapon): TargetFilter | null {
    const required = this.requiredTargetTag.trim() || weapon.targetTag.trim();
    if (!required) {
      if (!this.warnedMissingTargetTag) {
        this.warnedMissingTargetTag = true;
        console.warn(
          '[AutoTargetWeaponController] no requiredTargetTag or weapon targetTag; automatic targeting is disabled to prevent friendly fire.',
        );
      }
      return null;
    }
    this.warnedMissingTargetTag = false;
    const blocked = this.blockedTargetTag.trim();
    return {
      required: [required],
      blocked: blocked ? [blocked] : undefined,
    };
  }

  private async refreshTarget(weaponSnapshot: AutoTargetWeapon): Promise<void> {
    const transform = this.transform;
    if (!transform || this.destroyed || weaponSnapshot !== this.weapon) {
      return;
    }
    this.queryInFlight = true;
    const generation = this.queryGeneration;
    const origin = transform.worldPosition;
    const range = Math.max(0, Math.min(this.targetRange, weaponSnapshot.reach));
    try {
      const filter = this.targetFilter(weaponSnapshot);
      if (!filter) {
        this.setTarget(null, weaponSnapshot);
        return;
      }
      const candidates = await allTargetsInRadius(
        origin,
        range,
        filter,
        {exclude: this.entity},
      );
      if (
        this.destroyed ||
        generation !== this.queryGeneration ||
        weaponSnapshot !== this.weapon
      ) {
        return;
      }
      let selected: Maybe<Entity> = null;
      const candidateLimit = Math.min(
        candidates.length,
        Math.max(1, Math.floor(this.maxCandidateChecks)),
      );
      for (let index = 0; index < candidateLimit; index++) {
        const candidate = candidates[index];
        const probe = new TargetAimProvider(
          weaponSnapshot.muzzleOffset,
          this.targetHeightOffset,
        );
        probe.setTarget(candidate);
        const aim = probe.getAim(this.entity);
        if (!aim) {
          continue;
        }
        try {
          const clear = await hasClearShot({
            origin: aim.origin,
            direction: aim.direction,
            distance: range,
            shooter: this.entity,
            target: candidate,
            clearIfNothingHit: false,
          });
          if (clear) {
            selected = candidate;
            break;
          }
        } catch (error) {
          console.warn(
            `[AutoTargetWeaponController] visibility check failed for '${String(candidate.name)}': ${String(error)}`,
          );
        }
      }
      if (
        !this.destroyed &&
        generation === this.queryGeneration &&
        weaponSnapshot === this.weapon
      ) {
        this.setTarget(selected, weaponSnapshot);
      }
    } finally {
      this.queryInFlight = false;
    }
  }

  private setTarget(
    next: Maybe<Entity>,
    weapon: AutoTargetWeapon,
  ): void {
    if (next === this.target) {
      this.updateFacingOverride(next);
      return;
    }
    this.target = next;
    if (!next) {
      if (
        this.targetAimProvider != null &&
        weapon.aimProvider === this.targetAimProvider
      ) {
        weapon.aimProvider = this.priorAimProvider;
      }
      this.targetAimProvider = null;
      this.hasFacingDirection = false;
      this.facing?.setFacingOverride(null);
      return;
    }
    const provider = new TargetAimProvider(
      weapon.muzzleOffset,
      this.targetHeightOffset,
      this.priorAimProvider,
    );
    provider.setTarget(next);
    this.targetAimProvider = provider;
    weapon.aimProvider = provider;
    this.fireElapsed = 1 / Math.max(MIN_FIRE_RATE, weapon.fireRate);
    this.updateFacingOverride(next);
  }

  private updateFacingOverride(target: Maybe<Entity>): void {
    const sourceTransform = this.transform;
    const targetTransform = target?.getComponent(TransformComponent) ?? null;
    if (!sourceTransform || !targetTransform) {
      this.hasFacingDirection = false;
      this.facing?.setFacingOverride(null);
      return;
    }
    const dx = targetTransform.worldPosition.x - sourceTransform.worldPosition.x;
    const dz = targetTransform.worldPosition.z - sourceTransform.worldPosition.z;
    const magSq = dx * dx + dz * dz;
    if (magSq <= 0.000001) {
      this.hasFacingDirection = false;
      this.facing?.setFacingOverride(null);
      return;
    }
    const invMag = 1 / Math.sqrt(magSq);
    this.facingDirectionX = dx * invMag;
    this.facingDirectionZ = dz * invMag;
    this.hasFacingDirection = true;
    this.facing?.setFacingOverride(
      new Vec3(this.facingDirectionX, 0, this.facingDirectionZ),
    );
  }

  private driveTargetingAndAttack(
    deltaTime: number,
    weapon: AutoTargetWeapon,
  ): void {
    const target = this.target;
    const sourceTransform = this.transform;
    const targetTransform = target?.getComponent(TransformComponent) ?? null;
    if (!target || target.isDestroyed() || !sourceTransform || !targetTransform) {
      this.setTarget(null, weapon);
      return;
    }
    if (!this.hasFacingDirection) {
      this.facing?.setFacingOverride(null);
      return;
    }
    if (!this.autoAttackEnabled) {
      this.fireElapsed = 0;
      return;
    }

    const interval = 1 / Math.max(MIN_FIRE_RATE, weapon.fireRate);
    this.fireElapsed = Math.min(interval, this.fireElapsed + deltaTime);
    if (
      this.fireElapsed < interval ||
      this.fireCheckInFlight ||
      !horizontalDirectionsAligned(
        sourceTransform.worldForward,
        this.facingDirectionX,
        this.facingDirectionZ,
        this.alignmentToleranceDegrees,
      )
    ) {
      return;
    }
    this.fireElapsed = 0;
    void this.verifyAndFire(weapon, target).catch((error: unknown): void => {
      console.warn(
        `[AutoTargetWeaponController] fire preflight failed: ${String(error)}`,
      );
    });
  }

  private driveCurrentAimAttack(
    deltaTime: number,
    weapon: AutoTargetWeapon,
  ): void {
    const interval = 1 / Math.max(MIN_FIRE_RATE, weapon.fireRate);
    this.fireElapsed = Math.min(interval, this.fireElapsed + deltaTime);
    if (this.fireElapsed < interval) {
      return;
    }
    this.fireElapsed = 0;
    weapon.fireOnce();
  }

  private async verifyAndFire(
    weaponSnapshot: AutoTargetWeapon,
    targetSnapshot: Entity,
  ): Promise<void> {
    const provider = this.targetAimProvider;
    const transform = this.transform;
    const targetTransform = targetSnapshot.getComponent(TransformComponent);
    if (!provider || !transform || !targetTransform) {
      return;
    }
    const aim = provider.getAim(this.entity);
    if (!aim) {
      return;
    }
    this.fireCheckInFlight = true;
    try {
      const visible = await hasClearShot({
        origin: aim.origin,
        direction: aim.direction,
        distance: Math.min(this.targetRange, weaponSnapshot.reach),
        shooter: this.entity,
        target: targetSnapshot,
        clearIfNothingHit: false,
      });
      if (
        !visible ||
        !this.autoTargetEnabled ||
        !this.autoAttackEnabled ||
        !this.targetingOperational ||
        !this.hasFacingDirection ||
        this.destroyed ||
        weaponSnapshot !== this.weapon ||
        targetSnapshot !== this.target ||
        !horizontalDirectionsAligned(
          transform.worldForward,
          this.facingDirectionX,
          this.facingDirectionZ,
          this.alignmentToleranceDegrees,
        )
      ) {
        if (
          !visible &&
          weaponSnapshot === this.weapon &&
          targetSnapshot === this.target
        ) {
          this.setTarget(null, weaponSnapshot);
        }
        return;
      }
      weaponSnapshot.fireOnce();
    } finally {
      this.fireCheckInFlight = false;
    }
  }
}
