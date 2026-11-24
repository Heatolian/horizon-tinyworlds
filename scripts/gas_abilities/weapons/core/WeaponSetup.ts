/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v10

import {GASAbilityData} from '../../../gas/abilities/GASAbilityData';
import type {AbilityConstructor} from '../../../gas/abilities/GASAbility';
import {GASAttributeData} from '../../../gas/attributes/GASAttributeData';
import {GASComponent} from '../../../gas/core/GASComponent';
import {DurationPolicy, MagnitudeMode, ModifierOperator} from '../../../gas/core/Enums';
import {GASEffectData} from '../../../gas/effects/GASEffectData';
import {GASEffectModifier} from '../../../gas/effects/GASEffectModifier';
import {WeaponFireAbilityBase} from './WeaponFireAbilityBase';
import type {WeaponConfigProvider, WeaponFireConfigBase} from './WeaponFireAbilityBase';
import {WeaponReloadAbility} from './WeaponReloadAbility';
import {DEAD_TAG, STAGGERED_TAG} from '../../../Character/gas/CharacterTags';
import {createDamageEffect} from '../../../Character/gas/CharacterDamage';
import type {ReloadConfigProvider} from './WeaponReloadAbility';

/**
 * Start-up wiring shared by every weapon type: seed the magazine, build the
 * damage effect, build the per-shot ammo cost. Free functions rather than a base
 * component, because weapon types differ in which pieces they use.
 */

// Base attribute names; `weaponKey` namespaces them per weapon instance.
const AMMO_ATTR = 'ammo';
const RESERVE_ATTR = 'ammoReserve';

/**
 * Owner state tag, deliberately global (unprefixed) and shared by every weapon
 * family: reloading should block firing from any source, and an external stun
 * or disarm effect must be able to set the same tag without knowing what is
 * equipped.
 */
export const RELOADING_TAG = 'State.Reloading';

/** Names and objects a weapon needs afterwards to reach its own GAS state. */
export interface WeaponRuntime {
  ammoAttr: string;
  fireAbilityId: string;
  reloadAbilityId: string;
  damageEffect: GASEffectData;

  /** undefined when no reserve was seeded — the reload ability reads that as infinite. */
  reserveAttr: string | undefined;
}

/** Which ability class delivers the shot, and what to name the granted pair. */
export interface WeaponAbilitySpec {
  fireAbility: AbilityConstructor;
  /** Unprefixed fire ability id, e.g. 'weapon.hitscan.fire'. */
  fireAbilityName: string;
  /** Unprefixed reload ability id, e.g. 'weapon.hitscan.reload'. */
  reloadAbilityName: string;
}

export interface WeaponSetupOptions<TConfig extends WeaponFireConfigBase> {
  gas: GASComponent;
  magazineSize: number;
  fireRate: number;
  damage: number;
  damageEffectId: string;

  /** Receives both ability config callbacks; in practice the weapon component. */
  provider: WeaponConfigProvider<TConfig> & ReloadConfigProvider;

  /** Namespaces this weapon's attributes and ability ids. '' for a single weapon. */
  weaponKey: string;

  /** 0 = infinite reserve; no reserve attribute is seeded at all. */
  reserveAmmo: number;

  /** False for weapons such as swords that neither consume ammo nor reload. */
  reloadable: boolean;

  /** The attribute damage drains — health, or a shield / armour pool. */
  healthAttribute: string;

  /** Cue raised on the victim each time this weapon's damage lands. '' = none. */
  hitCueTag?: string;
}

/**
 * Seed the magazine, register the damage effect, and grant the fire + reload
 * abilities for one weapon. Delivery-agnostic: `spec` decides which fire
 * ability is granted, everything else is identical across weapon families.
 *
 * The fire ability is blocked by {@link RELOADING_TAG}, `state.dead` and
 * `state.staggered`; re-entry during a shot is refused by the ability itself
 * rather than by another tag.
 */
export function setupWeapon<TConfig extends WeaponFireConfigBase>(
  options: WeaponSetupOptions<TConfig>,
  spec: WeaponAbilitySpec,
): WeaponRuntime {
  const {gas, provider, weaponKey} = options;

  const ammoAttr = prefixed(weaponKey, AMMO_ATTR);
  const reserveAttr = prefixed(weaponKey, RESERVE_ATTR);
  const fireAbilityId = prefixed(weaponKey, spec.fireAbilityName);
  const reloadAbilityId = prefixed(weaponKey, spec.reloadAbilityName);

  const ammoData = seedAmmoAttribute(gas, ammoAttr, options.magazineSize);
  const hasReserve = options.reserveAmmo > 0;
  if (hasReserve) {
    seedReserveAttribute(gas, reserveAttr, options.reserveAmmo);
  }

  const damageEffect = createDamageEffect(
    options.damageEffectId,
    options.damage,
    options.healthAttribute,
    hitCueTags(options.hitCueTag),
  );

  gas.grantAbility(
    new GASAbilityData({
      abilityId: fireAbilityId,
      cooldown: options.fireRate > 0 ? 1 / options.fireRate : 0,
      costEffect: options.reloadable ? createAmmoCostEffect(ammoData) : null,
      // A corpse or a staggered holder fires nothing. Gating here rather than
      // downstream means the ability never activates at all: no cooldown
      // burned, no ammo spent, no animation asked for. Covers every weapon
      // family, because melee, hitscan and projectile all grant their fire
      // ability through this call.
      blockedByTags: [RELOADING_TAG, DEAD_TAG, STAGGERED_TAG],
    }),
    spec.fireAbility,
  );
  const fireAbility = gas.getAbility(fireAbilityId);
  if (fireAbility instanceof WeaponFireAbilityBase) {
    fireAbility.configProvider = provider;
  }

  gas.grantAbility(
    new GASAbilityData({
      abilityId: reloadAbilityId,
      tagsAppliedToOwner: [RELOADING_TAG],
      blockedByTags: [RELOADING_TAG, DEAD_TAG],
    }),
    WeaponReloadAbility,
  );
  const reloadAbility = gas.getAbility(reloadAbilityId);
  if (reloadAbility instanceof WeaponReloadAbility) {
    reloadAbility.configProvider = provider;
  }

  return {
    ammoAttr,
    reserveAttr: hasReserve ? reserveAttr : undefined,
    fireAbilityId,
    reloadAbilityId,
    damageEffect,
  };
}

/** The damage effect's execute cues for a weapon's `hitCueTag`. */
export function hitCueTags(hitCueTag: string | undefined): string[] {
  const tag = hitCueTag?.trim() ?? '';
  return tag.length > 0 ? [tag] : [];
}

/**
 * Namespace one weapon's attribute and ability names. Two weapons on the same
 * avatar MUST use different prefixes: a second registration under an existing
 * key is silently ignored, so they would share one magazine and one ability.
 */
export function prefixed(prefix: string, name: string): string {
  return prefix.length > 0 ? `${prefix}.${name}` : name;
}

/**
 * Seed the magazine full. Returns the attribute data so the caller can pass the
 * very same instance to {@link createAmmoCostEffect}.
 */
export function seedAmmoAttribute(
  gas: GASComponent,
  attributeName: string,
  magazineSize: number,
): GASAttributeData {
  const ammo = new GASAttributeData({
    attributeName,
    defaultValue: magazineSize,
    minValue: 0,
    maxValue: magazineSize,
  });
  gas.tryAddAttribute(ammo);
  return ammo;
}

/**
 * Seed the spare-rounds attribute full. Omit the call entirely for an infinite
 * reserve — the reload ability reads a missing attribute as "always refill",
 * so seeding 0 would mean the opposite.
 */
export function seedReserveAttribute(
  gas: GASComponent,
  attributeName: string,
  reserveAmmo: number,
): void {
  gas.tryAddAttribute(
    new GASAttributeData({
      attributeName,
      defaultValue: reserveAmmo,
      minValue: 0,
      maxValue: reserveAmmo,
    }),
  );
}

/**
 * -1 ammo per activation, as an ability cost effect. Pass the instance returned
 * by {@link seedAmmoAttribute}: `canPayCost` reads `minValue` off it, so a fresh
 * GASAttributeData would let the magazine go negative. Left unregistered — cost
 * effects apply to self on the activating machine and never cross the wire.
 */
export function createAmmoCostEffect(ammo: GASAttributeData): GASEffectData {
  const cost = new GASEffectData({durationPolicy: DurationPolicy.Instant});
  cost.modifiers.push(
    new GASEffectModifier({
      attribute: ammo,
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: -1,
    }),
  );
  return cost;
}
