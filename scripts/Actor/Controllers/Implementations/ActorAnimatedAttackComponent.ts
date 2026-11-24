/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
    component,
    Component,
    editor,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    property,
    subscribe,
    ExecuteOn,
    TransformComponent,
    type Entity,
} from 'meta/worlds';
import { IActorAttackControllerTypeId, type IActorAttackController, type IActorAttackPayload } from '../Definitions/IActorAttackController';
import type { IActorInterruptibleAttack } from '../Definitions/IActorInterruptibleAttack';
import type { IActorItemWeapon } from '../Definitions/IActorItemWeapon';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { CharacterAnimationController } from '../../../animation/CharacterAnimationController';
import { AnimationAction } from '../../../animation/modules/AnimationModule';
import { ActorActionTuning } from '../../../animation/modules/ActorActionAnimationModule';
import { TargetDeathReader } from '../../Utilities/ActorDeathReader';
import type { AimProvider } from '../../../gas_abilities/weapons/core/AimProvider';
import { GASComponent } from '../../../gas/core/GASComponent';
import { TargetAimProvider } from '../../../gas_abilities/weapons/targeting/TargetAimProvider';
import { canEquipWeapon, equippedWeaponOf } from '../../../ItemSystem/features/Weapon';

const DEFAULT_TARGET_HEIGHT_OFFSET = 1;

/**
 * Attack controller for animated Actor entities. It attacks with the weapon
 * in the actor's hand ({@link IActorItemWeapon}): the item its ItemSystem
 * `EquipmentBinder` equipped from a `Selected` loadout. `BaseActor` carries
 * that binder and loadout on its `ItemSystem` child and starts with the
 * `fists` item; a scene overrides the loadout to arm an actor (`sword`,
 * `rifle`, `fireball`, ...).
 *
 * The weapon owns the attack. Its GAS fire ability answers readiness (cooldown
 * from `fireRate`, the wind-up / recovery window, ammo and reload, and the
 * `state.dead` / `state.staggered` tags), and its damage effect lands the hit,
 * sourced at this actor. This component aims the weapon at the attack target
 * with a `TargetAimProvider`, perturbed within `payload.aimErrorDeg` when the
 * caller asks for a miss chance, and calls `fireOnce()`. The fists and the
 * fireball play the generic melee and ranged actions when they fire; a gun or
 * sword animates through `EquipmentAnimationModule`. The weapon in hand is
 * known only on the machine that equipped it, so an actor whose ownership moves
 * reads as empty-handed on its new owner until its binder equips again.
 *
 * It is ONE component, registered once under `IActorAttackControllerTypeId`:
 * `ActorBehaviorManagerImpl` drives every controller registered under a type
 * with the winning behavior, so two attack controllers on one actor would both
 * attack each time.
 *
 * It plays no attack animation itself, but it owns the animation layers'
 * per-actor timing (`swingDurationSec` / `swingCooldownSec` and the throw pair),
 * handed to the layers at create time by `pushAnimationTuning`.
 */
@component({
    description: 'Attack controller for animated actors: attacks with the weapon in hand (the item its ItemSystem loadout equips, such as BaseActor\'s fists), aiming it at the combat target.',
})
export class ActorAnimatedAttackComponent extends Component implements IActorAttackController, IActorInterruptibleAttack {
    @property()
    @editor({ description: 'Height above the target root, in meters, that the weapon aims at. 0 (the template-instance zero-init) uses 1.' })
    targetHeightOffset: number = DEFAULT_TARGET_HEIGHT_OFFSET;

    @property()
    @editor({ description: 'Never attack: the component registers as the actor\'s attack controller but refuses every attack (canAttack() is always false), so combat behaviors still chase, face and hold range but no swing or throw is ever issued and no attack intent is reported. For training dummies and actors that use a combat starter only to follow a target. Off by default, which is also the template-instance zero-init.' })
    passive: boolean = false;

    @property()
    @editor({ description: 'MELEE ACTION (the fists). Seconds the swing animation plays for. Keep it longer than the fists\' wind-up, which is the contact frame inside this swing. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
    swingDurationSec: number = 1.0;

    @property()
    @editor({ description: 'MELEE ACTION (the fists). Seconds after a swing before the animation layer allows another. Must stay above 0.1 — the layer leaves on `state_finished AND AttackCooldown > 0.1`, so a `0` freezes the character in the last frame of the swing pose. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly.' })
    swingCooldownSec: number = 0.5;

    @property()
    @editor({ description: 'RANGED ACTION (a thrown item such as the fireball). Seconds the throw animation plays for. Keep it longer than the item\'s wind-up, which is the release point inside it. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
    throwDurationSec: number = 1.0;

    @property()
    @editor({ description: 'RANGED ACTION (a thrown item such as the fireball). Seconds after a throw before the animation layer allows another. Same `> 0.1` exit gate as the melee swing — a `0` freezes the throw pose. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly.' })
    throwCooldownSec: number = 0.5;

    @property()
    @editor({ description: 'Enable debug logging to console.' })
    debugLogEnabled: boolean = true;

    /**
     * The entity's animation driver, resolved once. Null leaves every call a
     * no-op, which is the correct behaviour for an actor authored without one.
     */
    private animation: CharacterAnimationController | null = null;

    // The weapon in hand, re-read by every attack and readiness call (nothing
    // polls it per frame). The aim provider is ours while it is held; the
    // weapon's own provider is put back when the next read finds it gone. A
    // weapon that leaves the hand never carries our aim anywhere: unequipping
    // disposes its runtime (`WeaponEquipment.onEquip`'s cleanup in
    // ItemSystem/features/Weapon.ts) and the next equip builds a new one with
    // its own aim.
    private weapon: IActorItemWeapon | null = null;
    private aim: TargetAimProvider | null = null;
    private priorAim: AimProvider | null = null;

    private readonly targetDeath = new TargetDeathReader();

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.animation = this.entity.getComponent(CharacterAnimationController);
        this.pushAnimationTuning();

        if (this.entity.isOwned()) {
            this.registerActorController();
        }

        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorAnimatedAttackComponent] [${side}] Initialized on '${this.entity.name}'`);
        }
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        this.restoreAim();
        this.weapon = null;
        this.unregisterActorController();
    }

    /**
     * Hand this actor's attack pacing to the animation layers that play it.
     *
     * The layers are plain classes with no serialised properties of their own, so a value that
     * differs between actors has to come from the component that owns it. Pushed from the
     * `ExecuteOn.Everywhere` create handler because a proxy writes the graph variables itself
     * when the replicated trigger arrives, so every client must already hold the same numbers.
     */
    private pushAnimationTuning(): void {
        const animation = this.animation;
        if (!animation) {
            return;
        }
        animation.tune(
            AnimationAction.MELEE,
            ActorActionTuning.MELEE_DURATION_SEC,
            this.swingDurationSec,
        );
        animation.tune(
            AnimationAction.MELEE,
            ActorActionTuning.MELEE_COOLDOWN_SEC,
            this.swingCooldownSec,
        );
        animation.tune(
            AnimationAction.RANGED,
            ActorActionTuning.RANGED_DURATION_SEC,
            this.throwDurationSec,
        );
        animation.tune(
            AnimationAction.RANGED,
            ActorActionTuning.RANGED_COOLDOWN_SEC,
            this.throwCooldownSec,
        );
    }

    attack(payload: IActorAttackPayload): void {
        if (this.passive) {
            return;
        }
        const {target} = payload;
        const weapon = this.refreshHeldWeapon();
        // Readiness before the target is handed over: a call while a shot is in
        // flight would otherwise retarget that shot's aim, then be refused anyway.
        if (
            weapon &&
            !this.isTargetDead(target) &&
            this.withinReach(weapon, target) &&
            weapon.isReadyToFire() &&
            this.aimHeldWeapon(weapon, target, payload.aimErrorDeg ?? 0)
        ) {
            weapon.fireOnce();
        }
    }

    canAttack(target?: Entity | null): boolean {
        if (this.passive) {
            return false;
        }
        const weapon = this.refreshHeldWeapon();
        if (!weapon || this.isTargetDead(target)) {
            return false;
        }
        // With no target only the holder is judged. With one, the weapon is
        // pointed at it (see aimHeldWeapon), because the fire ability's answer
        // depends on the aim: a target that cannot be aimed at (no transform,
        // gone) leaves a null aim, which the fire ability refuses.
        if (target == null) {
            return weapon.isReadyToFire();
        }
        if (!this.withinReach(weapon, target) || !weapon.isReadyToFire()) {
            return false;
        }
        this.aimHeldWeapon(weapon, target);
        return weapon.canFire();
    }

    /**
     * Whether attacks go through a weapon: one in hand, or an `EquipmentBinder`
     * on a character with GAS that can equip one. Presence-based, so it answers
     * before the binder has equipped anything. False means this controller
     * never attacks.
     */
    public get attacksThroughWeapon(): boolean {
        return equippedWeaponOf(this.entity) != null || this.canBeArmed();
    }

    /**
     * Farthest distance (m) the weapon in hand can hit, 0 empty-handed.
     * Read-only: does not re-read the hand.
     */
    public get attackReach(): number {
        return equippedWeaponOf(this.entity)?.reach ?? 0;
    }

    /**
     * Whether `target` is inside a ranged weapon's reach, measured root to
     * root. A target the weapon cannot reach is refused rather than fired at.
     * Root to root is a little stricter than the shot, which strikes the
     * target's surface, so a target at the very edge of reach is refused.
     * Melee weapons are not checked: a melee hit reaches any collider surface
     * within range of the aim origin, and melee behaviors measure their range
     * surface to surface, which a root-to-root check would refuse.
     */
    private withinReach(weapon: IActorItemWeapon, target: Entity | null | undefined): boolean {
        const reach = weapon.reach;
        if (weapon.isMelee || !Number.isFinite(reach)) {
            return true;
        }
        const from = this.entity.getComponent(TransformComponent)?.worldPosition;
        const to = target?.getComponent(TransformComponent)?.worldPosition;
        return from != null && to != null && to.sub(from).magnitude() <= reach;
    }

    /** The weapon in hand, re-read so a swap is seen at once. */
    private refreshHeldWeapon(): IActorItemWeapon | null {
        const next = equippedWeaponOf(this.entity);
        if (next !== this.weapon) {
            this.restoreAim();
            this.weapon = next;
            if (this.debugLogEnabled) {
                console.log(`[ActorAnimatedAttackComponent] '${this.entity.name}' ${next ? 'attacks with its held weapon' : 'is empty-handed'}`);
            }
        }
        return this.weapon;
    }

    /**
     * Points the weapon at `target`, installing our aim provider on first use.
     * A missing target clears the aim rather than keeping the previous one, so
     * a call never acts on a target its caller did not pass. No fallback aim:
     * with no valid target the aim is null and GAS refuses, rather than firing
     * along a camera ray a server-owned actor does not have. `aimErrorDeg`, when
     * given, goes on the same provider; readiness checks leave it alone, since a
     * wound-up or burst shot reads the aim after `attack()` returns. Returns false
     * when there is no target to aim at.
     */
    private aimHeldWeapon(weapon: IActorItemWeapon, target: Entity | null | undefined, aimErrorDeg?: number): boolean {
        if (!this.aim || weapon.aimProvider !== this.aim) {
            this.priorAim = weapon.aimProvider;
            this.aim = new TargetAimProvider(
                weapon.muzzleOffset,
                this.targetHeightOffset > 0 ? this.targetHeightOffset : DEFAULT_TARGET_HEIGHT_OFFSET,
                null,
            );
            // An NPC's shots at a player hit only with one of that player's shooting tickets; swings are not rationed.
            this.aim.setRationHits(!weapon.isMelee);
            weapon.aimProvider = this.aim;
        }
        this.aim.setTarget(target ?? null);
        if (aimErrorDeg !== undefined) {
            this.aim.setAimErrorDeg(aimErrorDeg);
        }
        return this.aim.getTarget() != null;
    }

    private restoreAim(): void {
        const weapon = this.weapon;
        if (weapon && this.aim && weapon.aimProvider === this.aim) {
            weapon.aimProvider = this.priorAim;
        }
        this.aim = null;
        this.priorAim = null;
    }

    /** Shared by attack() and canAttack(), so readiness sees every target refusal. */
    private isTargetDead(target: Entity | null | undefined): boolean {
        return target != null && target.valid && this.targetDeath.isDead(target);
    }

    /**
     * Aborts an attack that has not yet landed, so an incoming hit visibly cuts
     * it off instead of queueing behind it. See {@link IActorInterruptibleAttack}
     * for why the pre-contact restriction is what keeps two evenly-matched
     * actors from cancelling each other forever.
     *
     * Ending the weapon's fire ability inside its wind-up cancels the shot; past
     * contact or release there is nothing left to take back. Owner-only, because
     * that is where the fire ability runs.
     */
    interruptAttack(): boolean {
        if (!this.entity.isOwned()) {
            return false;
        }
        const weapon = this.refreshHeldWeapon();
        if (weapon?.interrupt() !== true) {
            return false;
        }
        // The fists play the melee action and a thrown item the ranged one;
        // stopping it is the visible abort.
        this.animation?.stop(weapon.isMelee ? AnimationAction.MELEE : AnimationAction.RANGED);
        if (this.debugLogEnabled) {
            console.log(`[ActorAnimatedAttackComponent] Attack interrupted before contact on '${this.entity.name}'`);
        }
        return true;
    }

    /**
     * Ends the weapon's attack in any phase. Unlike interruptAttack() this is not
     * a visible abort: the animation layer finishes the swing it is playing and
     * leaves on the graph's own exit gate.
     */
    cancelAttack(): void {
        this.refreshHeldWeapon()?.cancel();
    }

    registerActorController(): void {
        // A passive attacker still registers so behaviors see a controller that
        // refuses; with none registered, AttackEntityInRangeBehavior decides on range.
        //
        // An attacker that can never hold a weapon has no attack to offer.
        // Declining to register keeps the actor's attack-controller list honest:
        // a behavior sees no attack controller rather than one that never lands.
        // Whether the actor CAN be armed is checked rather than whether it is:
        // its binder equips after create, but only beside a GASComponent.
        if (!this.passive && !this.canBeArmed()) {
            console.warn(`[ActorAnimatedAttackComponent] '${this.entity.name}' has no EquipmentBinder on a character with a GASComponent, so it can never hold a weapon — it will never attack, so it does not register as an attack controller. BaseActor carries the binder and a fists loadout on its ItemSystem child.`);
            return;
        }
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.registerController(IActorAttackControllerTypeId, this);
            if (this.debugLogEnabled) {
                console.log(`[ActorAnimatedAttackComponent] Registered attack controller for ${this.entity.name}`);
            }
        } else {
            console.warn(`[ActorAnimatedAttackComponent] No ActorSdkLogicComponent found on ${this.entity.name}`);
        }
    }

    unregisterActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.unregisterController(this);
        }
    }

    private canBeArmed(): boolean {
        return this.entity.getComponent(GASComponent) != null && canEquipWeapon(this.entity);
    }
}
