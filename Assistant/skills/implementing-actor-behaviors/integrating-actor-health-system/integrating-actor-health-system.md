---
name: integrating-actor-health-system
description: Gives an Actor Framework entity health, damage and death through GAS. The BaseActor template already ships ActorGASHealthComponent, so most requests are a property change rather than new code — this skill says how to check, how to tune, how to deal damage from script, and how to extend with armor, invulnerability, damage-over-time or hit/death VFX. Use for any "add health / HP / damage / armor / invulnerability / revive" request on an NPC or actor.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
local_tools:
  # Every source this skill governs is checked in under scripts/, and is edited
  # in place, so no copy tool is granted -- only the rebuild an in-place edit
  # requires.
  - build_assets
consider_skills:
  - name: making-actors-die
    when: the actor should stop acting, despawn, or otherwise react when its HP reaches zero
  - name: searching-vfx-effects
    when: hit and death VFX templates must be sourced or created for the actor
---

# Actor health

Health is a GAS attribute. There is one implementation and both the player and
every NPC run on it:

```
CharacterGASComponent          scripts/Character/gas/CharacterGASComponent.ts
  |                            health + max_health attributes, raises the death
  |                            tag, last-attacker tracking
  \- ActorGASHealthComponent   scripts/Actor/Utilities/ActorGASHealthComponent.ts
                               adds the Actor Framework adapters: health
                               controller registration, blackboard death
                               reporting, telemetry

CharacterTags                  scripts/Character/gas/CharacterTags.ts
                               the tag constants themselves, importing nothing
                               so either side of a gate can depend on them:
                               state.dead, state.staggered, cooldown.stagger
```

`PlayerCharacter.hstf` carries the base; `BaseActor.hstf` carries the actor
subclass. Read either file for the current property list and defaults — do not
trust a copied table.

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new
actor is duplicated from — **already carries `ActorGASHealthComponent` and
`StarterHealthAndDeathComponent`**. So:

| The actor needs | Do |
|-----------------|-----|
| HP, damage, death, stagger, despawn | **Nothing.** Already on `BaseActor`. Set `initialMaxHealth` on the instance. |
| A different HP total | Set `initialMaxHealth` on the instance. No code. |
| Armor, damage types, invulnerability, DoT, regeneration | Author a GAS effect — see "Extending" below. |
| Hit / death VFX | GAS cues — see "Extending" below. |

An actor must carry **exactly one** health component. Do not add a second one.

## Trigger conditions

Activate when the user asks to:
- "Give this NPC 500 hp" / "Set max health" / "Make the enemy tankier"
- "Make the enemy deal 20 damage" / "Deal damage to the player"
- "Do this when hp drops below half"
- "Add armor to the enemy" / "Reduce incoming damage"
- "Make the player invulnerable for 3 seconds"
- "Poison the target" / "Regenerate health over time"
- "Kill the NPC" / "Revive the player"
- "Show a health bar for this actor"

## Prerequisites

- `ActorSdkManagerComponent` on a persistent scene entity
- `ActorSdkLogicComponent` on the actor root
- `ActorGASHealthComponent` on the actor root (already there on a `BaseActor` duplicate)

## Setting HP

`initialMaxHealth` is the `@property` on `CharacterGASComponent` that seeds the
GAS `max_health` attribute. Set it on the template instance. `maxHealth` is a
read-only getter over the live attribute, not a property: writing `maxHealth`
through the property tools is rejected, and `setMaxHealth()` changes it at runtime.

🚨 **A template instance zero-inits an omitted property.** The code default is
only a fallback for a fresh instantiation; if the template stores `0`, runtime
sees `0`. Always write the value explicitly on every instance, and never rely on
the code default. A `0` here is not an error — it is an actor that dies to the
first hit.

## Dealing damage from script

```typescript
const health = target.getComponent(CharacterGASComponent);
health?.recordAttacker(this.entity, knockbackMultiplier);  // optional, before
health?.takeDamage(amount);
```

An NPC attack needs none of this: the actor's mounted GAS weapon applies its own
registered damage effect, sourced at the attacker. This path is for script that
deals damage outside a weapon.

Notes that matter:

- **`recordAttacker` is optional and must come first.** `StaggerBehavior` reads
  it to aim knockback away from the attacker; without it knockback falls back to
  the victim's facing.
- **Resolve `CharacterGASComponent`, not the subclass.** The player carries the
  base and NPCs carry `ActorGASHealthComponent`; matching on the base finds
  both. Search the entity **and its descendants** — a character rig nests the
  component below the root. `findCharacterGAS` (`CharacterGASComponent.ts`) does
  both.
- **Ownership is handled for you.** `takeDamage` on a non-owner RPCs the owner.
  It routes the amount rather than an effect, because effect ids resolve against
  a per-machine registry.
- **Damage always runs as an instant GAS effect**, never a direct attribute
  write — only the effect path reaches `postGameplayEffectExecute`, which is
  where death is detected. If you write the attribute directly, nothing dies.

## Death

Health reaching zero applies the `state.dead` tag (`DEAD_TAG`, exported from
`scripts/Character/gas/CharacterTags.ts`). Resolve the import specifier relative
to your own file rather than copying one — from
`scripts/gas_abilities/weapons/core/` it is `../../../Character/gas/CharacterTags`.
Query the tag with `health.isDead`.

The tag is hierarchical and replicated, so it is the fact to gate on. To stop an
ability firing while dead, add it to that ability's `blockedByTags` — the weapon
stack's fire and reload grants both do this. Do not re-derive death from a health
number.

🚨 `blockedByTags` is read once, at activation, and never re-checked while the
ability runs. A multi-round burst or a timed reload that started before death
keeps ticking to completion. An ability that spans frames must re-check the tag
itself on each step. `hasTag` lives on `GASComponent`, not on the `AbilityOwner`
interface that `GASAbility.owner` is typed as, so reach the full facade before
querying: prefer an accessor that already does it (`WeaponFireAbilityBase`
exposes `ownerGas`), and where none exists cast — `(this.owner as unknown as
GASComponent).hasTag(DEAD_TAG)`. A bare `this.owner.hasTag(...)` does not
compile.

Raising the tag drives the state machine, not the reverse —
`CharacterStateMachine.subscribeDeathTag` turns `onTagAdded(DEAD_TAG)` into
`setDead(true)`. So anything calling `setDead()` directly poses the character
without making it dead to GAS, and its abilities stay usable. Kill through
`takeDamage` to get both.

Death is permanent by design: the tag's comment reads "never cleared — respawn
rather than revive". Nothing calls `removeLooseTag(DEAD_TAG)`, and
`ActorGASHealthComponent.setHealthData()` restores health without clearing it, so
an actor revived that way keeps the tag and stays unable to fire or reload —
**a revive request cannot currently be satisfied here**, despite this skill's
trigger list naming one. To bring an actor back, respawn a fresh copy instead:
`despawnTimer` on `StarterHealthAndDeathComponent` plus an `ActorSpawner`, as in
the `making-actors-die` skill's Respawning section. For an actor that should
despawn, stop acting, or drop loot on death, use that skill too —
`DeathBehavior` is already wired by `StarterHealthAndDeathComponent`.

## Extending

These are the GAS mechanisms that cover the advanced requests. The framework
supports all of them; **none is currently exercised by this package**, so treat
each as a starting direction and verify against `scripts/gas/` rather than
assuming a worked example exists.

| Request | Mechanism | Where to read |
|---|---|---|
| Armor, resistances, damage types | A second attribute plus a magnitude calculator, or a modifier on the damage effect | `gas/attributes/`, `gas/effects/GASMagnitudeCalculator.ts` |
| Invulnerability window | A durational effect that applies a tag; put that tag in the damage ability's `blockedByTags`, or check it in `preGameplayEffectExecute` | `gas/effects/`, `gas/abilities/GASAbilityData.ts` |
| Damage over time, regeneration | A periodic effect (`period` on the effect data) | `gas/effects/GASEffectData.ts` |
| Per-hit variable damage | `MagnitudeMode.SetByCaller` instead of minting an effect per value | `gas/effects/GASEffectModifier.ts` |
| Reacting to health changes | `onAttributeChanged`, or `onTagAdded` / `onTagRemoved` for death | `gas/core/GASComponent.ts` |
| Hit / death VFX and SFX | Gameplay cues | `gas/cues/` |

Prefer an effect or a tag over a new boolean on a component. A boolean is a
second source of truth that will drift from the attribute; an effect is
replicated, stackable and inspectable.

## Overhead Health Bar

For a bar floating above each actor (not on the player's HUD).

**Entity**: a non-networked child of the actor root on the actor's template, so spawned copies get one and it is destroyed with the actor. Its client-only script reads `health` / `maxHealth` from the parent's `CharacterGASComponent` (`findCharacterGAS`) and writes a ViewModel.

**`CustomUiPlatformComponent`**:

| Property | Value |
|---|---|
| `customUiType` | `"Billboard"` |
| `panelVisibility` | `true` |
| `scaling` | `true` |
| `minPctScreenWidth` | `0.04`: a **fraction** of screen width, so `4` would be 400% |
| `maxPctScreenWidth` | `0.10` |
| `hasMaxDrawDistance` | `false`, so bars on distant actors do not vanish |

**Size**: a Billboard's world width is its entity scale in meters (the larger XAML dimension maps to 1 m at scale 1). Set the child's scale so the bar is about as wide as the actor's footprint; read the width with `get_entity_bounds`. Scale the actor root and the child's scale and offset are multiplied by it. `scaling` keeps the bar between 4% and 10% of the screen width at any camera distance, so:

- Do NOT write `localScale` from camera distance in a script.
- Do NOT copy `BillboardIndicator`'s `billboardScale = 3.0` / `maxBillboardScale = 10.0`; those values give a bar several times wider than the actor.
- Do NOT change `vrPanelWidth` / `vrPanelHeight` to resize it; they are ScreenSpace-only.

**Position**: local Y about 0.5 m above the top of the actor's mesh bounds.

**Too big or too small**: if the bar is too small from far away, raise `minPctScreenWidth`. If it is too big, lower `maxPctScreenWidth` or the child's scale. Between the clamps the bar keeps its world size, so the child's scale decides how big it looks at mid range.

## Actor Framework integration

`ActorGASHealthComponent` implements `ActorHealthController`, so the behaviours
work unchanged:

- `DeathBehavior` reads the `state.dead` tag directly. `StaggerBehavior`
  subscribes to `onDamaged` only to interrupt the in-flight attack and fire
  the knockback impulse; the stagger window itself is applied by
  `CharacterGASComponent` (a survivable hit on a character with `staggerOnHit`
  raises `state.staggered` for `staggerDuration` and `cooldown.stagger` for
  `staggerDuration + staggerCooldown`), and both clear themselves.
- `getHealthData()` still answers the SDK contract: `isDead`, `currentHealth`
  and `maxHealth` read GAS, and `isHit` reports `state.staggered`.
- Set `blackboardGroupId` to a faction id to have death reported to
  `CombatBlackboard` so combat behaviours stop targeting the corpse.
- Animation is not this component's job. `DeathAnimationModule` and
  `DamageAnimationModule` own the poses and are addressed with
  `AnimationAction.DEATH` / `AnimationAction.FLINCH`.

## After editing

Run `build_assets` with `inputs: ['scripts/']` only if a step edited a checked-in
source file. Attaching a component or changing a property on a template edits no
source and needs no rebuild.

## Troubleshooting

| Issue | Cause |
|---|---|
| Actor dies to the first hit | `initialMaxHealth` stored as `0` on the template instance (seeds 1 HP). Set it explicitly. |
| Damage does nothing, no error | The damage path resolved no health component. It must match `CharacterGASComponent` and search descendants, not just the root. |
| Attribute changes but nothing dies | The attribute was written directly instead of through an effect, so `postGameplayEffectExecute` never ran. |
| `DeathBehavior` never fires | The health component is not on the actor root (the entity carrying `ActorSdkLogicComponent`), so `DeathBehavior` finds no `CharacterGASComponent` to read `state.dead` from. |
| `StaggerBehavior` never fires | Only survivable damage staggers; a one-shot kill goes straight to death. A hit inside `cooldown.stagger` is also ignored. |
| Knockback has no direction | The damage carried no attacker: a `takeDamage` call without a preceding `recordAttacker`, or a GAS effect applied with no source (`applyEffectToSelf`). `applyEffectToTarget` attributes the caster automatically. |
| Corpse still acts | The gate reads a health number instead of the `state.dead` tag, or the ability lacks `blockedByTags`. |
