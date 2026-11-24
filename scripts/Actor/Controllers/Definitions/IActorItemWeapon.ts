/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import type {Vec3} from 'meta/worlds';
import type {AimProvider} from '../../../gas_abilities/weapons/core/AimProvider';

/**
 * A weapon in an actor's hand, as the attack controller drives it: aim it,
 * ask its fire ability whether a shot would be accepted, fire once. GAS
 * decides every refusal (cooldown, ammo, reload, dead, staggered); the
 * controller only forwards.
 *
 * Satisfied structurally by the ItemSystem's equipped weapon (`ItemWeapon`,
 * from `equippedWeaponOf`).
 */
export interface IActorItemWeapon {
    /** Where each shot starts and points. The controller swaps in a `TargetAimProvider` and puts the previous one back. */
    aimProvider: AimProvider | null;
    /** Shot origin relative to the holder. */
    readonly muzzleOffset: Vec3;
    /** Meters a shot can reach; unbounded is `Infinity`. */
    readonly reach: number;
    /** A melee hit lands on any collider surface within reach, so reach is not measured root to root. */
    readonly isMelee: boolean;
    /** Whether GAS would accept a fire activation now, with the current aim. */
    canFire(): boolean;
    /** Every gate `canFire` checks except the aim. */
    isReadyToFire(): boolean;
    /** One fire activation; GAS decides whether it happens. */
    fireOnce(): void;
    /** Ends a shot still before its contact or release; true when one was cut off. */
    interrupt(): boolean;
    /** Ends the fire ability in any phase. */
    cancel(): void;
}
