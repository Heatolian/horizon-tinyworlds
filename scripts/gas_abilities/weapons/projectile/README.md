# Projectile Weapons

The fire ability for weapons whose shots travel: fireballs, grenades, arrows.
A weapon is configured as an ItemSystem item: a `Weapon` fragment with a
`Projectile` delivery (`scripts/ItemSystem/features/WeaponDelivery.ts`), whose
`ItemWeapon` is this ability's config provider. The `fireball` item in
`scripts/GameContent/ItemCatalog.ts` is the working example.

The instant-hit twin is `../hitscan/`. Both sit on the same
`../core/` skeleton; this directory is only the spawn.

## Files

| File | Role |
|------|------|
| `WeaponProjectileFireAbility.ts` | The contract (`ProjectileWeaponFireConfig`) plus `deliver()` — spawning and configuring one projectile. |

The flying bullet itself lives in `../../projectiles/` (`GASProjectile`, `Motion`,
`LaunchProjectileAbility`) and is shared with the `ability_projectile` skill.
`deliver()` calls its `spawnConfiguredProjectile` helper, so the spawn logic —
template instantiation, the child-entity lookup, instigator defaulting — is not
duplicated here.

## What comes from core

`WeaponFireAbilityBase` supplies cooldown gating, burst rounds, one projectile
per pellet inside a spread cone, muzzle resolution, and game-time burst spacing.
`WeaponSetup` grants the ability pair and the damage effect.

## Minimum configuration (`Projectile` delivery)

| Field | Why |
|----------|-----|
| `template` | must carry `GASProjectile` + a collider + a **Trigger** PhysicsBody (`Templates/Weapons/Fireball.hstf`) |
| `speed` | m/s |
| `lifetimeSec` | speed x lifetime is the effective range (default 5 s) |
| `damage`, `fireRate`, `muzzleOffset`, `hitCueTag` | on the item's `Weapon` |

## How it differs from hitscan

| | hitscan | projectile |
|---|---|---|
| Hit resolves | inside the activation | frames later, asynchronously |
| Hit detail | `HitResult` — collider, distance, pierce index | the entity only |
| Range | trace `range` | `speed` x `lifetimeSec` |
| Penetration | `maxHits` | not supported — a projectile despawns on its first hit |
| Self-hit guard | ray excludes, then a walk to the GAS root | `instigator` on the projectile |

The differing hit payload is why the two configs stay separate rather than
merging into one: a projectile hit reports only the entity, not a collider or
a distance, and faking them would quietly break any damage model built on them.

**The muzzle matters here.** A projectile spawns at the weapon's `muzzleOffset`
(default 0.33 m forward) and travels; a target closer than that is already
behind the spawn point. The first sweep is a ray from the caster's pivot (at
muzzle height) to the end of the first step, closing that muzzle gap — except
for camera-aimed shots whose muzzle sits behind the caster, where no pivot ray
runs and the legacy dead zone still holds. Hitscan has no such constraint.

## The shooter can die mid-flight

A projectile outlives the activation that fired it, so the shooter may be
despawned by the time it lands. `ItemWeapon` drops the hit in that case: damage
is attributed to the shooter's GAS, and there is nothing to attribute it to
once that is gone.

## Extending

**Motion** — projectiles fly straight by default. With `homeOnTarget` on the
`Projectile` delivery and the weapon aiming through a `TargetAimProvider` (an
NPC's attack controller does), each projectile homes on the target that provider
held when the throw started (`../../projectiles/Motion.ts` `homing`). Homing
seeks the target's body collider, not the body-height point `TargetAimProvider`
aims the launch at, so the normal sweep lands the shot on its capsule.

**Custom damage** — compute it in the provider's `onHit`. There is no distance
or collider detail to shape it with, unlike hitscan.

## Not covered yet

Damage falloff, penetration and arcing motion. Hit cues come from the item's
`hitCueTag`; `cue.weapon.fire` from the shared weapon core.
