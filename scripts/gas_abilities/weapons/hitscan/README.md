# Hitscan Weapons

Instant-trace ranged weapons. The shot lands the frame the trigger is pulled —
pistol, rifle, SMG, shotgun, sniper, burst, piercing all differ only by
configuration.

A weapon is configured as an ItemSystem item: a `Weapon` fragment with a
`Hitscan` delivery (`scripts/ItemSystem/features/WeaponDelivery.ts`), whose
`ItemWeapon` is this ability's config provider. `pistol`, `rifle` and
`npc_test_pistol` in `scripts/GameContent/ItemCatalog.ts` are the working
examples.

The travelling-shot twin is `../projectile/`. Both sit on the same
`../core/` skeleton; this directory is only the ray.

## Files

| File | Role |
|------|------|
| `WeaponHitscanFireAbility.ts` | The contract (`HitscanFireConfig`, `HitResult`, `TagFilter`) plus `deliver()` — the raycast and how its hits resolve. |

## What comes from core

`ItemWeapon` (`scripts/ItemSystem/features/Weapon.ts`) supplies everything that
is not delivery-specific: the numbers, trigger, aim source and muzzle offset from
the item's `Weapon`, magazine and reload from its `Magazine`, per-weapon GAS
namespacing through `WeaponSetup`, and the per-frame polling that drives
sustained fire.

`WeaponFireAbilityBase` supplies cooldown gating, burst rounds, one ray per
pellet inside a spread cone, muzzle resolution, and game-time burst spacing.

So a hitscan weapon is: **the shared skeleton + `deliver()` + a `Hitscan` delivery.**

## One shot, end to end

```
ItemWeapon.pullTrigger() / fireOnce() / per-frame tick
  └→ gas.tryActivateAbility(fireAbilityId)
       └→ GASAbilityManager: cooldown? State.Reloading? enough ammo?
            └→ WeaponFireAbilityBase.canActivate()   isActive guard + config non-null
                 └→ onActivate → fire(config)
                      ├ resolve origin/direction (config first, else owner transform)
                      ├ for each of burstCount rounds:
                      │    ├ for each of pelletCount pellets:
                      │    │    └→ deliver()  ← rayCast, sort by distance, walk to the
                      │    │                     GAS root, tag filter, de-dup, onHit
                      │    └ wait burstIntervalSec (game time, via tick)
                      └ finally endAbility
```

## Minimum configuration

| Field | Why |
|----------|-----|
| `damage`, `fireRate`, `fireMode` | on the item's `Weapon`; a weapon is not a weapon without them |
| `range` | on the `Hitscan` delivery; max trace distance (default 50) |
| `Magazine` (`size`, `ammoTag`, `reloadTimeSec`) | on the item, for a gun that reloads |

Then only what the weapon type needs: `pelletCount` + `spreadDeg` for a shotgun,
`burstCount` + `burstIntervalSec` for a burst rifle, `maxHits` for armour
piercing (all on `Hitscan`), `aimSource: 'forward'` + `muzzleOffset` on the
`Weapon` for a turret or NPC.

## Arming a character

Players and NPCs are armed by putting the item in one of their ItemSystem
containers (see `../../../ItemSystem/README.md`); equipping grants this fire
ability onto the holder's `CharacterGASComponent`. The item's hand and ground
model is a pure visual template, `Templates/Weapons/PistolVisual.hstf` or
`RifleVisual.hstf`, carrying the mesh, muzzle and fire/reload audio bindings. See
`../../../../Templates/Weapons/README.md`.

## Extending

**Custom damage** (crits, headshots, falloff, per-pierce falloff) — implement
your own `HitscanConfigProvider` and compute damage inside `onHit`. `HitResult`
carries `colliderEntity` for hit location, `distance` for falloff, and
`hitIndex` for pierce order. Reuse the ability unchanged.

**Custom aim** — assign `aimProvider` at runtime; `aimSource` only picks the
default.

**A new weapon family** (beam, charge-up, thrown) — add a `WeaponDelivery` and
subclass `WeaponFireAbilityBase`, implementing `deliver()` the way this directory does.
If it needs a SECOND abstract method, the shared skeleton is the wrong fit for
it: inherit `GASAbility` directly and reuse the weaponcore parts à la carte. A
beam is the obvious case — it has no rounds and no pellets.

## Gotchas

**One copy of an item per character.** Attributes and abilities are keyed by
name on the shared `GASComponent` under a `weaponKey` derived from the item id,
and both `tryAddAttribute` and `grantAbility` silently ignore a duplicate.
Different items never collide; two copies of one item in effect at once would
share one magazine and one ability.

**`damageEffectId` identifies a weapon TYPE, not an instance.** An item's id is
derived from its tuning, so equal tuning shares one definition. Two *different*
definitions under one id is a real conflict: the id is dropped and neither deals
damage.

**Burst cooldown.** The cooldown is committed once per activation — set
`1 / fireRate >= (burstCount - 1) * burstIntervalSec` or bursts overlap.

**At most 4 excluded entities.** `rayCast` silently drops the rest. The trace
also walks up from the hit collider to the GAS-owning root and skips the
wielder, which is what actually prevents self-hits.

**Fire is client-authoritative.** The whole trace runs on the owner and damage
is routed to the target's authority with no validation. Fine for PvE and casual
play; a competitive mode needs a different authority model.

## Not covered yet

Damage falloff, hit zones, recoil / bloom spread, ADS, per-round reload and
spin-up. Hit cues come from the item's `hitCueTag`; `ItemWeapon` emits
`cue.weapon.fire` and `cue.weapon.reload`.
