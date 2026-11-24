/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v7

import {RemapPageAsset, TemplateAsset, TextureAsset, Vec3} from 'meta/worlds';
import {HEALTH_ATTR} from '../Character/gas/CharacterAttributes';
import {GASAttributeData} from '../gas/attributes/GASAttributeData';
import {DurationPolicy, MagnitudeMode, ModifierOperator, StackDurationRefreshPolicy, StackingPolicy} from '../gas/core/Enums';
import {GASEffectData} from '../gas/effects/GASEffectData';
import {GASEffectModifier} from '../gas/effects/GASEffectModifier';
import {ItemDefinition, defineItem, Stackable} from '../ItemSystem/items/ItemDefinition';
import {WorldModel} from '../ItemSystem/items/ItemFragments';
import {Expendable} from '../ItemSystem/features/Expendable';
import {Magazine} from '../ItemSystem/features/Magazine';
import {Usable} from '../ItemSystem/features/Usable';
import {Weapon} from '../ItemSystem/features/Weapon';
import {Hitscan, Melee, Projectile, THROWN_WEAPON_TAG, Throw} from '../ItemSystem/features/WeaponDelivery';

/**
 * Every item this game knows. Loaded on every machine by `ItemCatalogLoader`, so
 * server and clients register the same ids. A new weapon is one `defineItem`
 * call here: a `weapon.*` tag (the loadout accepts only those), a `Weapon`
 * (numbers, a delivery such as `Hitscan` or `Melee`, a pure visual template for
 * `visual`, a remap page for `remapper`), a `WorldModel`, and for a gun a
 * `Magazine`; no component or class.
 */

const PISTOL_MODEL = new TemplateAsset('@Templates/Weapons/PistolVisual.hstf');
const RIFLE_MODEL = new TemplateAsset('@Templates/Weapons/RifleVisual.hstf');
const SWORD_MODEL = new TemplateAsset('@Templates/Weapons/SwordVisual.hstf');
const PISTOL_ANIMATIONS = new RemapPageAsset('@Assets/AnimationProfiles/Equipment/Pistol/Pistol_Remap.remapper');
const RIFLE_ANIMATIONS = new RemapPageAsset('@Assets/AnimationProfiles/Equipment/Rifle/Rifle_Remap.remapper');
const SWORD_ANIMATIONS = new RemapPageAsset('@Assets/AnimationProfiles/Equipment/Sword/Sword_Remap.remapper');
// Until grenades have clips of their own: the sword's idle and the NPC ranged throw (`Throw_Fast`).
const GRENADE_ANIMATIONS = new RemapPageAsset('@Assets/AnimationProfiles/Equipment/Grenade/Grenade_Remap.remapper');
/** `Throw_Fast`'s event at the frame the hand lets go; the throw leaves on it. */
const THROW_RELEASE_EVENT = 'release';
/** `Throw_Fast`'s event once the arm is back: the next one shows in the hand. */
const THROW_READY_EVENT = 'ready';
/** `Throw_Fast`'s length: the latest a throw leaves if the event never arrives. */
const THROW_WINDUP_SEC = 0.6;
const FIRE_ICON = new TextureAsset('@UI/icons/icn_Fire.png');
const RELOAD_ICON = new TextureAsset('@UI/icons/icn_Reload.png');
const SWING_ICON = new TextureAsset('@UI/icons/icn_SwingWeapon.png');
const FIREBALL = new TemplateAsset('@Templates/Weapons/Fireball.hstf');
const GRENADE = new TemplateAsset('@Templates/Weapons/Grenade.hstf');
const GRENADE_MODEL = new TemplateAsset('@Templates/Weapons/GrenadeVisual.hstf');
const MOLOTOV = new TemplateAsset('@Templates/Weapons/Molotov.hstf');
const MOLOTOV_MODEL = new TemplateAsset('@Templates/Weapons/MolotovVisual.hstf');
const FIRE_AREA = new TemplateAsset('@Templates/Weapons/FireArea.hstf');
/** Where a throw leaves from when the thrower's rig has no hand socket: above the shoulder, clear of its capsule. */
const THROW_OFFSET = new Vec3(0, 1.5, 0.6);
// Placeholder cubes until real models exist.
const AMMO_BOX_MODEL = new TemplateAsset('@Templates/GameContent/AmmoBoxModel.hstf');
const MEDKIT_MODEL = new TemplateAsset('@Templates/GameContent/MedkitModel.hstf');

defineItem(
  new ItemDefinition({
    id: 'pistol',
    displayName: 'Pistol',
    tags: ['weapon.pistol'],
    fragments: [
      new WorldModel(PISTOL_MODEL),
      new Weapon({
        animKey: 'pistol',
        remapper: PISTOL_ANIMATIONS,
        visual: {template: PISTOL_MODEL, socket: 'RightHand'},
        aimMode: 'auto',
        recoil: {pitchDeg: 2, yawDeg: 0.5, recoverDegPerSec: 8},
        bloom: {baseDeg: 0.5, perShotDeg: 1, maxDeg: 2, recoverDegPerSec: 2.5, movingDeg: 1},
        damage: 25,
        fireRate: 4,
        fireMode: 'semi',
        aimSource: 'camera',
        fireButtonIcon: FIRE_ICON,
        delivery: new Hitscan({range: 40}),
      }),
      new Magazine({size: 12, ammoTag: 'ammo.9mm', reloadTimeSec: 1.2, reloadButtonIcon: RELOAD_ICON}),
    ],
  }),
);

// For test NPCs: barely hurts and never runs dry, so a tester can watch the AI fight.
defineItem(
  new ItemDefinition({
    id: 'npc_test_pistol',
    displayName: 'NPC Test Pistol',
    tags: ['weapon.pistol'],
    fragments: [
      new WorldModel(PISTOL_MODEL),
      new Weapon({
        animKey: 'pistol',
        remapper: PISTOL_ANIMATIONS,
        visual: {template: PISTOL_MODEL, socket: 'RightHand'},
        damage: 1,
        fireRate: 2,
        aimSource: 'forward',
        delivery: new Hitscan({range: 40}),
      }),
      new Magazine({size: 12, reloadTimeSec: 1.2}),
    ],
  }),
);

defineItem(
  new ItemDefinition({
    id: 'rifle',
    displayName: 'Rifle',
    tags: ['weapon.rifle'],
    fragments: [
      new WorldModel(RIFLE_MODEL),
      new Weapon({
        animKey: 'rifle',
        remapper: RIFLE_ANIMATIONS,
        visual: {template: RIFLE_MODEL, socket: 'RightHand'},
        aimMode: 'auto',
        recoil: {pitchDeg: 0.6, yawDeg: 0.4, recoverDegPerSec: 2},
        bloom: {baseDeg: 0.6, perShotDeg: 0.5, maxDeg: 2, recoverDegPerSec: 1.5, movingDeg: 1},
        damage: 10,
        fireRate: 5,
        fireMode: 'auto',
        aimSource: 'camera',
        fireButtonIcon: FIRE_ICON,
        delivery: new Hitscan({range: 50}),
      }),
      new Magazine({size: 30, ammoTag: 'ammo.556', reloadTimeSec: 2, reloadButtonIcon: RELOAD_ICON}),
    ],
  }),
);

// Scoped: Aim looks through its sight, and it fires only from Use. The rifle's model and clips until it has its own.
defineItem(
  new ItemDefinition({
    id: 'sniper',
    displayName: 'Sniper Rifle',
    tags: ['weapon.sniper'],
    fragments: [
      new WorldModel(RIFLE_MODEL),
      new Weapon({
        animKey: 'rifle',
        remapper: RIFLE_ANIMATIONS,
        visual: {template: RIFLE_MODEL, socket: 'RightHand'},
        aimMode: 'scoped',
        scopeFov: 20,
        recoil: {pitchDeg: 5, yawDeg: 1, recoverDegPerSec: 10},
        bloom: {baseDeg: 3, perShotDeg: 3, maxDeg: 6, recoverDegPerSec: 4, movingDeg: 4, steadyFactor: 0.05},
        damage: 80,
        fireRate: 0.8,
        fireMode: 'semi',
        aimSource: 'camera',
        fireButtonIcon: FIRE_ICON,
        delivery: new Hitscan({range: 120}),
      }),
      new Magazine({size: 5, ammoTag: 'ammo.556', reloadTimeSec: 2.5, reloadButtonIcon: RELOAD_ICON}),
    ],
  }),
);

// Eight pellets across a 5-degree cone, each doing `damage`: up close most land, at range few do. The rifle's model and clips until it has its own.
defineItem(
  new ItemDefinition({
    id: 'shotgun',
    displayName: 'Shotgun',
    tags: ['weapon.shotgun'],
    fragments: [
      new WorldModel(RIFLE_MODEL),
      new Weapon({
        animKey: 'rifle',
        remapper: RIFLE_ANIMATIONS,
        visual: {template: RIFLE_MODEL, socket: 'RightHand'},
        aimMode: 'auto',
        recoil: {pitchDeg: 4, yawDeg: 1.5, recoverDegPerSec: 12},
        bloom: {perShotDeg: 1, maxDeg: 1, recoverDegPerSec: 4, movingDeg: 0.5},
        damage: 10,
        fireRate: 1.2,
        fireMode: 'semi',
        aimSource: 'camera',
        fireButtonIcon: FIRE_ICON,
        delivery: new Hitscan({range: 20, pelletCount: 8, spreadDeg: 5}),
      }),
      new Magazine({size: 6, ammoTag: 'ammo.12g', reloadTimeSec: 2.5, reloadButtonIcon: RELOAD_ICON}),
    ],
  }),
);

defineItem(
  new ItemDefinition({
    id: 'sword',
    displayName: 'Sword',
    tags: ['weapon.sword'],
    fragments: [
      new WorldModel(SWORD_MODEL),
      new Weapon({
        animKey: 'sword',
        remapper: SWORD_ANIMATIONS,
        visual: {template: SWORD_MODEL, socket: 'RightHand'},
        damage: 20,
        fireRate: 1,
        aimSource: 'forward',
        fireButtonIcon: SWING_ICON,
        delivery: new Melee({range: 2, coneHalfAngleDeg: 120}),
      }),
    ],
  }),
);

// Bare hands: a weapon with no model, so nothing shows in the hand. BaseActor NPCs start with it.
defineItem(
  new ItemDefinition({
    id: 'fists',
    displayName: 'Fists',
    tags: ['weapon.fists'],
    fragments: [
      new Weapon({
        animKey: 'fists',
        damage: 10,
        fireRate: 2 / 3,
        aimSource: 'forward',
        delivery: new Melee({range: 1.2, coneHalfAngleDeg: 60, windupSec: 0.4, recoverySec: 1.1, directedAtAimTarget: true}),
      }),
    ],
  }),
);

// For stagger tests: a longer wind-up and shorter recovery, so a hit lands inside the wind-up.
defineItem(
  new ItemDefinition({
    id: 'npc_test_fists',
    displayName: 'NPC Test Fists',
    tags: ['weapon.fists'],
    fragments: [
      new Weapon({
        animKey: 'fists',
        damage: 10,
        fireRate: 2 / 3,
        aimSource: 'forward',
        delivery: new Melee({range: 1.2, coneHalfAngleDeg: 60, windupSec: 0.5, recoverySec: 0.7, directedAtAimTarget: true}),
      }),
    ],
  }),
);

// Caster NPCs: a thrown fireball, nothing in the hand.
defineItem(
  new ItemDefinition({
    id: 'fireball',
    displayName: 'Fireball',
    tags: ['weapon.fireball'],
    fragments: [
      new Weapon({
        animKey: 'fireball',
        damage: 10,
        fireRate: 0.4,
        aimSource: 'forward',
        muzzleOffset: new Vec3(0, 1.2, 0.6),
        hitCueTag: 'cue.weapon.hit.fireball',
        delivery: new Projectile({template: FIREBALL, speed: 8, lifetimeSec: 3, windupSec: 0.5, recoverySec: 0.7}),
      }),
    ],
  }),
);

// Thrown: each throw spends one of the stack (`Expendable`). The loot model stands in for a hand model, hidden from release until the arm is back. NPCs cannot hold them (`THROWN_WEAPON_TAG`).
defineItem(
  new ItemDefinition({
    id: 'grenade',
    displayName: 'Grenade',
    tags: ['weapon.grenade', THROWN_WEAPON_TAG],
    fragments: [
      new WorldModel(GRENADE_MODEL),
      new Stackable(3),
      new Expendable(),
      new Weapon({
        animKey: 'grenade',
        remapper: GRENADE_ANIMATIONS,
        visual: {template: GRENADE_MODEL, socket: 'RightHand', hideOnEvent: THROW_RELEASE_EVENT, showOnEvent: THROW_READY_EVENT},
        damage: 60,
        fireRate: 1,
        aimSource: 'hand',
        muzzleOffset: THROW_OFFSET,
        fireButtonIcon: FIRE_ICON,
        delivery: new Throw({
          template: GRENADE,
          speed: 12,
          fuseSec: 2.5,
          blastRadius: 5,
          windupSec: THROW_WINDUP_SEC,
          releaseEvent: THROW_RELEASE_EVENT,
        }),
      }),
    ],
  }),
);

defineItem(
  new ItemDefinition({
    id: 'molotov',
    displayName: 'Molotov',
    tags: ['weapon.molotov', THROWN_WEAPON_TAG],
    fragments: [
      new WorldModel(MOLOTOV_MODEL),
      new Stackable(3),
      new Expendable(),
      new Weapon({
        animKey: 'molotov',
        remapper: GRENADE_ANIMATIONS,
        visual: {template: MOLOTOV_MODEL, socket: 'RightHand', hideOnEvent: THROW_RELEASE_EVENT, showOnEvent: THROW_READY_EVENT},
        damage: 5,
        fireRate: 1,
        aimSource: 'hand',
        muzzleOffset: THROW_OFFSET,
        fireButtonIcon: FIRE_ICON,
        delivery: new Throw({
          template: MOLOTOV,
          speed: 11,
          windupSec: THROW_WINDUP_SEC,
          releaseEvent: THROW_RELEASE_EVENT,
          detonateOnImpact: true,
          fuseSec: 0,
          blastRadius: 1.5,
          area: {template: FIRE_AREA, radius: 3, durationSec: 8, intervalSec: 0.5, effect: burning('itemsystem.molotov.burning', 4, 3)},
        }),
      }),
    ],
  }),
);

defineItem(
  new ItemDefinition({
    id: 'ammo_9mm',
    displayName: '9mm Rounds',
    tags: ['ammo.9mm'],
    fragments: [new WorldModel(AMMO_BOX_MODEL), new Stackable(60)],
  }),
);
defineItem(
  new ItemDefinition({
    id: 'ammo_556',
    displayName: '5.56 Rounds',
    tags: ['ammo.556'],
    fragments: [new WorldModel(AMMO_BOX_MODEL), new Stackable(90)],
  }),
);
defineItem(
  new ItemDefinition({
    id: 'ammo_12g',
    displayName: '12 Gauge Shells',
    tags: ['ammo.12g'],
    fragments: [new WorldModel(AMMO_BOX_MODEL), new Stackable(24)],
  }),
);

defineItem(
  new ItemDefinition({
    id: 'medkit',
    displayName: 'Medkit',
    tags: ['item.medical'],
    fragments: [new WorldModel(MEDKIT_MODEL), new Stackable(3), new Usable({effect: instantHeal('itemsystem.medkit.heal', 50)})],
  }),
);

function instantHeal(effectId: string, amount: number): GASEffectData {
  const effect = new GASEffectData({effectId, durationPolicy: DurationPolicy.Instant});
  effect.modifiers.push(
    new GASEffectModifier({
      attribute: new GASAttributeData({attributeName: HEALTH_ATTR}),
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: amount,
    }),
  );
  return effect;
}

/**
 * Damage over time that a fire area reapplies each pulse: standing in it keeps the burn
 * topped up, and stepping out leaves `durationSec` of burning.
 */
function burning(effectId: string, damagePerTick: number, durationSec: number): GASEffectData {
  const effect = new GASEffectData({
    effectId,
    durationPolicy: DurationPolicy.Durational,
    duration: durationSec,
    period: 0.5,
    tickImmediately: true,
    stacking: StackingPolicy.AggregateByTarget,
    maxStack: 1,
    durationRefresh: StackDurationRefreshPolicy.RefreshOnAdd,
    tagsAppliedToTarget: ['state.burning'],
  });
  effect.modifiers.push(
    new GASEffectModifier({
      attribute: new GASAttributeData({attributeName: HEALTH_ATTR}),
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: -damagePerTick,
    }),
  );
  return effect;
}
