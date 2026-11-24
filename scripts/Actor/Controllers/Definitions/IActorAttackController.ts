/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import type { Entity, Vec3 } from "meta/worlds";
import type { ActorController } from "meta/worlds";

export interface IActorAttackPayload {
    target: Entity;
    /** Damage for a controller that deals its own. `ActorAnimatedAttackComponent` ignores it: the weapon in hand applies its own damage. */
    damage: number | undefined;
    attackRange: number | undefined;
    /**
     * Smoothed world-space velocity of the target (meters/second) sampled when
     * the attack is issued, or `null`/`undefined` when unknown.
     *
     * A ranged controller may use this to lead a moving target, aiming at where
     * the target will be rather than where it is now. `ActorAnimatedAttackComponent`
     * does not lead: it aims at the target's current position (a thrown item can
     * home on its target instead).
     */
    targetVelocity?: Vec3 | null;
    /**
     * Deliberate aim error: the shot leaves within a cone of this half-angle
     * (degrees) around the true line to the target, on top of the weapon's own
     * `spreadDeg`. Absent or 0 aims true. A directed melee hit ignores it, and a
     * homing projectile steers back onto its target, so it barely affects one.
     */
    aimErrorDeg?: number;
}

export interface IActorAttackController extends ActorController {
    attack(payload: IActorAttackPayload): void;
    /**
     * Whether `attack()` against `target` would be accepted now. Every refusal
     * `attack()` makes shows here, so a caller pacing on this answer never
     * retries a refused attack. An accepted attack reads false until the next
     * may start, which is what lets a caller count one attack per ready edge.
     * With no target, only the attacker is checked.
     */
    canAttack(target?: Entity | null): boolean;
    /**
     * True while attacks go through a GAS weapon, whose fire ability refuses
     * what the body cannot do (dead, staggered, reloading, cooldown, ammo).
     * False: no weapon to attack with.
     */
    readonly attacksThroughWeapon?: boolean;
    /**
     * Farthest distance (m) the weapon that would attack now can hit, for a
     * caller choosing when to attack: root to root for a ranged weapon, from
     * the aim origin to the target's surface for a melee one. Absent: unknown.
     */
    readonly attackReach?: number;
}

export const IActorAttackControllerTypeId = 'IActorAttackController';
