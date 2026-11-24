# Using the GAS system

Reference documentation for the Gameplay Ability System — attributes, tags,
effects, abilities and cues, plus the ready-made weapon, projectile and targeting
components. Covers health and damage, resource pools, buffs and debuffs,
cooldowns, status states, and any "fire a weapon" or "cast an ability" mechanic.
Not locomotion, camera or NPC behaviour trees: those belong to the character
controller and the Actor framework.

This lives beside the code it documents rather than under `Assistant/skills/`, so
it is not in the assistant's skill catalog. `Docs/INSTALLED_PACKAGE.md` points
here from every GAS row.

Two layers live in this project:

| Path | What it is |
|------|------------|
| `scripts/gas/` | The framework. Attributes, tags, effects, abilities, cues, and the `GASComponent` facade. |
| `scripts/gas_abilities/weapons/`, `scripts/gas_abilities/projectiles/` | Ready-made content built on it. Weapons, projectiles, targeting. |

Game code talks to **`GASComponent` only**. It owns five sub-managers and creates
them at start; do not construct `GASAttributeSet`, `GASEffectManager`,
`GASAbilityManager`, `GASTagContainer` or `GameplayCueManager` yourself.

Read exact signatures, enum members and defaults from the source — this skill
covers the decisions and the failure modes, not the API surface.

## 1. Both sides need a GASComponent

Add `GASComponent` to the caster **and** to anything it should affect. Effects
applied to an entity without one do nothing, silently — no error, no damage.

Two editor properties: `initialTags` (comma-separated, e.g. `player, faction.blue`)
and `useHierarchicalMatcher` (leave on).

## 2. Attributes — the numbers

Seed them either by subclassing `GASComponent` and overriding
`getInitialAttributes()`, or at runtime with `gas.tryAddAttribute(new GASAttributeData({...}))`.

**`tryAddAttribute` returns `false` and does nothing if the name is already
taken.** It does not overwrite and it does not throw. Two systems seeding
`health` means the second one silently inherits the first one's bounds.

Read with `getAttributeValue` / `getAttributeBase`; write with `setAttributeBase`
or `applyInstantModifier`. Prefer driving values through effects (§4) — direct
writes bypass the effect pipeline, so no `postGameplayEffectExecute` hook, no
cue, and no stack bookkeeping.

Clamp or reroute values by overriding `preAttributeChange` /
`preAttributeBaseChange` in a `GASComponent` subclass.

## 3. Tags — the states

Matching is **hierarchical**: a query matches a tag that is equal to it or a
descendant of it, split on `.`.

- query `status` matches an owner holding `status.burning` — yes
- query `status.burning` on an owner holding only `status` — **no**, parents do not grant children
- query `stat` on an owner holding `status` — no, not a path segment

Tags are stack-counted. `addLooseTag(tag, n)` / `removeLooseTag(tag, n)`; a tag
is present while its count is above zero.

## 4. Effects — how numbers and states change

A `GASEffectData` carries a `DurationPolicy`, a list of `GASEffectModifier`, and
optional tags applied to the target. Each modifier targets one attribute with an
operator and a magnitude mode. The enums are in `scripts/gas/core/Enums.ts`;
read them there rather than guessing member names.

Apply with `applyEffectToSelf(data, source?, level?)` or
`applyEffectToTarget(target, data, level?)`.

**Instant effects never stack** — they never enter the active queue, so every
stacking policy is ignored for them. Stacking only applies to `Durational` and
`Infinite`.

### The two rules that cause silent failures

**Cross-network application is by id.** Application always runs on the
*target's* authority. When the target is a remote proxy, only the `effectId`
crosses the wire and the authority resolves it from a static registry. So an
effect that can ever hit a remote target must have a non-empty `effectId` **and**
be passed to `GASComponent.registerEffect(data)` on every machine — register at
module scope or in start-up code, which runs identically everywhere. Without
that you get a console warning and nothing else. In that remote case the call
also returns `null`: no `Effect` handle crosses the wire, so do not rely on the
return value to remove the effect later.

**One id means one definition, forever.** If two *different* `GASEffectData`
objects are registered under one id, the id is dropped from the registry **and
permanently blacklisted** — after that neither definition ever applies again,
on any machine. This bites when a definition is rebuilt per component instance:
five players carrying the same gun build five objects under one id. Build the
definition once at module scope, or cache it keyed by id and by the values that
went into it (`scripts/gas_abilities/weapons/core/WeaponSetup.ts` shows the cached
form).

A corollary: reusing one id for a genuinely different effect is not a naming
nit, it disables both.

## 5. Abilities — the actions

Grant with `gas.grantAbility(new GASAbilityData({abilityId, cooldown, costEffect,
requiredTags, blockedByTags, tagsAppliedToOwner, ...}), MyAbilityClass)`, then
run with `gas.tryActivateAbility(id, userData?)`.

Subclass `GASAbility` and override:

- `canActivate()` — extra gate. **Must be side-effect free**: the public
  `canActivateAbility` query calls it speculatively. It receives no `userData`,
  so payload-dependent checks belong in `onActivate`.
- `onActivate(userData)` — the body.
- `onEnd()` — cleanup.
- `tick(delta)` — only runs while `isActive`, for channelled abilities.

### Activation order

`tryActivateAbility` checks, in order: granted → cooldown expired → `requiredTags`
all present and no `blockedByTags` present → cost affordable → `canActivate()`.
Only then does it commit: apply the cost, start the cooldown, add
`tagsAppliedToOwner`, set `isActive`, emit Activated and the activate cues, and
finally call `onActivate`. A failed gate costs nothing.

### Gotchas

- **`grantAbility` is silently idempotent.** A second grant under an existing id
  returns without replacing anything, and an empty `abilityId` only warns. Two
  systems granting the same id means the second one's class is never used.
- **Cost checks read `minValue` off the modifier's attribute object.** Only `Add`
  modifiers are checked, and against the *base* value. Pass the **same**
  `GASAttributeData` instance you seeded the attribute with — a freshly
  constructed one defaults `minValue` to `-Infinity`, so the pool goes negative
  and the ability never runs out.
- **Nothing auto-ends an ability.** Anything that is not instant stays `isActive`
  until you call `endAbility(id)`, and while active it keeps ticking.
- Blocking an ability with a state tag (a reload blocking a shot, a stun blocking
  everything) is the intended pattern: put the tag in `tagsAppliedToOwner` on one
  ability and in `blockedByTags` on the other.

## 6. Cues — cosmetic only

A cue is a tag plus a `GameplayCueContext` (source, source object, target,
location, normal, magnitude). There are two supported presentation routes:

- Put `GameplayCuePresentation` on the source object, add one or more bindings,
  and pass that entity as `context.sourceObject`. Each exact-tag binding can play
  the `VfxComponent` on its presentation entity and an optional spatial sound.
  This is the normal weapon path: the ItemSystem's `ItemWeapon` emits
  `cue.weapon.fire` / `cue.weapon.reload` with the holder as `sourceObject`,
  and `EquipmentVisuals` relays them to the model in hand.
- Implement `IGameplayCueHandler` with a `tagPrefix` and register it on
  `gas.cueManager.registerHandler(handler)` for global or prefix-routed
  presentation. Routing to a registered prefix is hierarchical, so `cue.vfx`
  receives every `cue.vfx.*`.

`GameplayCuePresentation` itself is generic. It knows only cue tags,
presentation entities and optional sounds; weapon semantics stay in the
emitter. Multiple bindings may share one tag to fan a cue out to several
effects.

Cues fire on **every** client via an Everywhere RPC. Never mutate gameplay state
in a handler — VFX, SFX and camera shake only, or clients diverge.

## 7. Authority — what runs where

Simulation is authority-only. On a non-owner these are **no-ops that return
quietly**: `setAttributeBase`, `applyInstantModifier`, `addLooseTag`,
`removeLooseTag`, `removeEffect`, `removeEffectStack`. Effects and ability state
live only on the authority; proxies receive attribute values and the tag set by
replication and are correct to read, not to write.

Attribute *definitions* are never replicated. They come from code, so
`getInitialAttributes` must produce the same set on every machine.

## 8. Prefer the ready-made components

Do not hand-write firing, reloading, spread, burst, hit resolution or projectile
flight. `scripts/gas_abilities/` already has them:

| Directory | Use it for |
|-----------|-----------|
| `gas_abilities/weapons/core/` | The shared skeleton — `WeaponSetup` (per-weapon GAS namespacing, ability grant), `WeaponFireAbilityBase`, `WeaponReloadAbility`, `WeaponTrigger`, `AimProvider`, `Spread`. Subclassed, not used directly. |
| `gas_abilities/weapons/hitscan/` | `WeaponHitscanFireAbility`, behind the item `Hitscan` delivery: pistol, rifle, SMG, shotgun, sniper, burst, piercing. |
| `gas_abilities/weapons/projectile/` | `WeaponProjectileFireAbility`, behind the item `Projectile` delivery: fireball, grenade, bolt, arrow. |
| `gas_abilities/weapons/melee/` | `WeaponMeleeFireAbility`, behind the item `Melee` delivery: a sphere overlap plus a facing arc at the moment of the press. |
| `gas_abilities/weapons/targeting/` | Target selection and filtering (`Targeting`, `TargetAimProvider`, `AutoTargetWeaponController`). `Targeting.ts` walks up from a hit collider to the entity carrying the `GASComponent`. |
| `gas_abilities/projectiles/` | The flying object itself — `GASProjectile`, `Motion`, `LaunchProjectileAbility`. Also the base for non-weapon projectile abilities such as a fireball. |

`scripts/gas_abilities/weapons/hitscan/README.md` and
`scripts/gas_abilities/weapons/projectile/README.md` cover the per-shot flow,
the minimum configuration, and how to extend each family. Read the one you need.

A new weapon is **configuration**, not code: one `defineItem` in
`scripts/GameContent/ItemCatalog.ts` with a `Weapon` fragment (`animKey`,
`damage`, `fireRate`, `aimSource`, `muzzleOffset`, `hitCueTag`,
`delivery: Hitscan | Melee | Projectile`) and, for a gun, a `Magazine`.
`../ItemSystem/README.md` is the reference. Write a class only for a genuinely
new delivery model: a new `WeaponDelivery`, plus, if no fire ability fits, one
subclassing `WeaponFireAbilityBase` and implementing `deliver()`.

### Arming a character

Every character is armed through the ItemSystem; equipping grants the item's
fire and reload abilities onto the character's own `GASComponent`, so do not add
a second `GASComponent` or a weapon component. A player holds weapons in the
loadout of `Templates/GameContent/PlayerContainers.hstf` (`initialItems`, ammo in
the backpack) or picks up a `Templates/GameContent/Loot*.hstf`; see "Giving the
player a weapon" in `../ItemSystem/README.md`. An NPC (any `BaseActor`
duplicate) holds its weapon in the `Selected` loadout `ItemContainer` on its
`ItemSystem` child, `initialItems: ['fists']` by default; a scene overrides that
list, e.g. `rifle` + `ammo_556*90`, `sword`, `npc_test_pistol` or `fireball`.
`ActorAnimatedAttackComponent` fires only the item in hand.

`Weapon.animKey` selects an existing animation profile (`pistol`, `rifle`,
`sword`, ...). It is intentionally reusable.

For fire presentation, give the item's visual template a `Muzzle` child at the
visible barrel tip with an optional `VfxComponent` (`autoPlay = false`), and
bind `cue.weapon.fire` to that child through `GameplayCuePresentation` on the
visual root. Bind `cue.weapon.reload` on the root for reload audio. `ItemWeapon`
supplies both cues; no weapon-specific cue handler is needed. For what each
template in `../../Templates/Weapons/` is, see its `README.md`.

### Automatic targeting and attack

`AutoTargetWeaponController` composes the existing weapon seams rather than
implementing another weapon. `autoTargetEnabled` selects a target, overrides the
held weapon aim, and drives facing without firing:

```
allTargetsInRadius + GAS tag filter
  -> fresh line-of-sight ray
  -> the player's auto-face ability setFacingOverride()
  -> TargetAimProvider on the ItemSystem weapon in hand
```

`autoAttackEnabled` independently drives `fireOnce()` at the weapon's configured
fire rate. With auto-targeting enabled, it waits for an aligned, visible target;
with auto-targeting disabled, it fires through the weapon's normal current aim.

The controller is owner-side and drives the ItemSystem weapon in hand. It
restores the weapon's previous aim provider and releases the facing override when
the target, weapon or targeting feature goes away. Automatic selection requires a
non-empty controller `requiredTargetTag` or held-weapon `targetTag`; without one
it stays disabled rather than targeting arbitrary GAS entities. The supplied
player templates enable `autoTargetEnabled` and leave `autoAttackEnabled` off,
so the weapon in hand aims at a tagged target automatically and fires only on
Use.

An item weapon's abilities and attributes are keyed by name on the shared
`GASComponent` under a `weaponKey` derived from the item id, and both
`tryAddAttribute` and `grantAbility` ignore duplicates. Different items never
collide, but two copies of the same item must not be in effect at once on one
character: the second would share the first magazine and fire ability.

`damageEffectId` identifies a weapon **type**, not an instance: an item's is
derived from its tuning. See the id rule in §4.

## 9. Verify in-world

To verify by playing, put the item id in the player's
loadout `initialItems` (or place a `Loot*` pickup and take it) and use the Use /
Reload buttons; for an NPC, override its `ItemSystem` loadout's `initialItems`.
In both cases the target needs a `GASComponent` and a collider; watch its
`health` attribute and confirm the fire cue presents on every client.

Run `build_assets` after adding or editing scripts; components do not appear in
the editor until the scripts compile.
