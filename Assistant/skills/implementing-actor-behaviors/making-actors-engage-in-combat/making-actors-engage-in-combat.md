---
name: making-actors-engage-in-combat
description: Gives an NPC full combat engagement with EngageCombatBehavior, a composite that acquires a target from the tagging blackboard, chases it, and attacks. Use when the enemy should both pursue and fight, rather than only attacking what comes into range.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
consider_skills:
  - adding-navigation
  - integrating-actor-health-system
  - name: configuring-actor-combat-blackboard
    when: combat targets come from an external detection or threat system, or factions must be distinguished
  - name: triggering-npc-animations
    when: attack, stagger, or death should play specific animation clips rather than the template defaults
---

# Adding Combat Engagement to an NPC

`EngageCombatBehavior` is a composite behavior that combines target acquisition, following, and attacking into a single behavior. It internally wires two sub-behaviors:

1. **FollowTaggedEntityBehavior** (priority 1) — resolves the closest entity matching `targetTags` from `ActorTaggingBlackboard` and moves toward it
2. **AttackEntityInRangeBehavior** (priority 2) — attacks when the resolved target is within the attack band

All distance parameters use **surface-to-surface distance** semantics — the framework reads both actors' collider radii (`ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`) and adds them automatically. Authors set weapon reach, not center-to-center distance.

The composite derives all internal follow/attack/hysteresis values from `maxAttackDistance` so the NPC is **guaranteed to park inside its own attack band**. This eliminates the class of bug where an NPC's follow distance, attack range, and collider sizes disagree.

Because `AttackEntityInRangeBehavior` has higher internal priority, it wins the movement controller when in range — stopping the NPC to attack. When the target leaves range, the follow behavior resumes pursuit.

The target is synced from the follow behavior to the attack behavior each frame automatically. No manual target wiring is needed.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC chase and attack the player"
- "Add combat engagement" / "Make an NPC fight"
- "Have the enemy follow me and attack when close"
- "Create an NPC that pursues and attacks tagged entities"
- Any variation involving an NPC following a target and attacking it

## Prerequisites

A `BaseActor` duplicate already carries `ActorSdkLogicComponent`,
`ActorAnimatedAttackComponent`, `ActorTransformMoveComponent`, `ActorGASHealthComponent` and its
capsule collider. What is **not** free: the `StarterCombatComponent` itself (combat is
authored per-instance, never baked into the template), the `ActorSdkTagComponent` on the target,
a loadout override for any weapon other than the default fists, and the NavMesh.

- A baked **NavMesh** exists in the scene so the NPC chases around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)
- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorAnimatedAttackComponent` on the actor root (already there on a `BaseActor` duplicate). It attacks only with the weapon in hand: the item the `EquipmentBinder` on the actor's `ItemSystem` child equips from its `Selected` loadout `ItemContainer` (`initialItems: ['fists']` on every `BaseActor` duplicate — 10 damage, one punch per 1.5 s, 0.4 s wind-up, 1.2 m reach, strikes only the attack target). To arm it differently, override that container's `initialItems` with catalog ids, a gun's ammo after the gun in the same container: melee `sword` (2 m) or `fists`; hitscan `pistol` + `ammo_9mm*60`, `rifle` + `ammo_556*90` (up to 90 per entry; add entries for more), or `npc_test_pistol` (1 damage, never runs dry, no ammo); thrown `fireball`. The binder selects the first equippable item. The weapon owns damage, cadence (`fireRate`), timing (`windupSec`, `recoverySec`), ammo and reload. One controller serves every weapon; there is no separate ranged controller. With no `EquipmentBinder` (on a character with a `GASComponent`) it logs that the actor will never attack and does not register
- A new weapon is one `defineItem(...)` in `scripts/GameContent/ItemCatalog.ts`: `new Weapon({animKey, damage, fireRate, aimSource: 'forward', muzzleOffset, hitCueTag?, delivery})` with `delivery` one of `new Hitscan({range})`, `new Melee({range, coneHalfAngleDeg, windupSec, recoverySec, directedAtAimTarget})` or `new Projectile({template, speed, lifetimeSec, homeOnTarget, windupSec, recoverySec})`, plus `new Magazine({size, ammoTag?, reloadTimeSec})` for a gun (omit `ammoTag` for infinite ammo). A `Projectile` `template` must carry `GASProjectile`, a collider and a Trigger `PhysicsBody` (`Templates/Weapons/Fireball.hstf`, which the `fireball` item spawns, is one).
- The movement controller named in the Actor Contract (`implementing-actor-behaviors.md`) — `ActorTransformMoveComponent`, already there on a `BaseActor` duplicate; `ActorPhysicsComponent` is a collision controller, not a mover — unless it is an intentionally stationary attacker (see below)
- NPC and target have physics colliders for automatic surface-to-surface distance calculation (the NPC's capsule is already there on a `BaseActor` duplicate)
- Target entities are tagged via `ActorSdkTagComponent` or auto-tagged via `ActorSdkTagPlayerService`
- To make a target die and despawn after N hits, give it an `ActorGASHealthComponent` with `initialMaxHealth = N` — it is a subclass of `CharacterGASComponent` (so the projectile's `takeDamage` still applies and `DeathBehavior` sees the `state.dead` tag) that also carries the stagger and blackboard adapters. Then add a `DeathBehavior` with `despawnTimer > 0` (it defaults to `-1` = no auto-despawn). The attack controller only reads `isDead`; it does not despawn the target on its own. See the `making-actors-die` skill.

## Usage

`EngageCombatBehavior` is most commonly used through `StarterCombatComponent`. The same starter serves melee, ranged, spell and held-gun attackers: it picks the target, the range and the moment, and the actor's attack controller delivers the hit. For standalone use or custom composition, create it in a starter script:

```typescript
import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {EngageCombatBehavior} from '../scripts/Actor/Behaviors/CompositeBehaviors/EngageCombatBehavior';

@component({description: 'Adds chase-and-attack combat to this actor'})
export class StartEngageCombatComponent extends Component {
  @property()
  targetTags: string = 'player';

  @property()
  engagementRange: number = 0; // 0 = unlimited acquisition — see Key Properties

  @property()
  followSpeed: number = 5.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartEngageCombatComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = 10;
    combat.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    combat.engagementRange = this.engagementRange;
    combat.followSpeed = this.followSpeed;
    combat.attackDamage = 1;

    actorLogic.addBehavior(combat);
  }
}
```

## Melee vs Ranged

The same behavior handles both — adjust `maxAttackDistance`:

**Melee** — NPC runs up and strikes:
- `maxAttackDistance: 0.3` (sword reach, surface-to-surface)
- `minAttackDistance: 0` (no dead zone)
- Uses the `BaseActor` `fists` item (or override the loadout with `sword`): the punch hits the attack target directly at `windupSec`

**Ranged** — NPC keeps distance and attacks from afar:
- `maxAttackDistance: 12.0` (bow range, surface-to-surface)
- `minAttackDistance: 3.0` (flee/switch if target gets too close)
- `preferredAttackDistance: 8.0` (stand at 8m, attack up to 12m). Ranged is the case that **must** set this — the default `0` presses to the inner band edge and the NPC closes to melee instead of kiting.
- **Attack controller (mirror the melee setup).** To shoot a gun instead of a projectile, see **Ranged with a held gun** below. Where melee punches with the default `fists`, a thrower overrides the `ItemSystem` child's loadout `initialItems` with `fireball` (see Prerequisites). Each shot spawns the item's `Projectile` `template`, whose `GASProjectile` flies, detects the hit through its trigger and applies the item's damage. Do **not** hand-roll a bespoke projectile (a `PhysicsBodyComponent.linearVelocity` + `OnCollisionEnterEvent` component).
- **Spawn location — set the item's `muzzleOffset` to the firing point.** It is relative to the caster: x = right, y = up, z = **forward** (positive). Push `z` past the caster's collider radius so the projectile clears the caster, and prefer the exact firing point (wand tip, muzzle, dragon mouth) when the rig has one.
- **Aim — nothing to implement.** The controller aims the weapon at the attack target's body (`targetHeightOffset` above its root, default 1 m) through a `TargetAimProvider`, so the shot does not fly at the feet.
- **Scale — size the projectile entity AND its VFX separately.** Scale the projectile **template/mesh** small for a bolt (~0.2–0.5) via its entity transform. Scale the **VFX** with **VFX parameters** (e.g. `global_scale`), NOT the entity transform — transform scale does **not** affect VFX particles, and marketplace fireball/explosion effects are authored large, so a default-scale spawn effect looks huge; tune `global_scale` down to projectile size (see the `tuning-vfx-parameters` skill).
- **VFX placement.** Put the trail VFX **inside the projectile template** as a child entity so it travels with the shot. Give that child a `VfxPlatformComponent` (the asset + `global_scale` live there). For an impact effect, set the item's `hitCueTag` (e.g. `cue.weapon.hit.fireball`) and bind that tag on the victim's `GameplayCuePresentation` to a VFX child: the cue is raised by the damage itself and plays on every client.
- **Moving targets — home, do not lead.** There is no lead-target prediction: a shot flies at the target's position when it fires. For a projectile that must connect, set `homeOnTarget: true` on the item's `Projectile` delivery: each projectile then steers toward the target until it lands.

Do **not** add the target's body size to these values. The framework reads both actors' collider radii and computes center-to-center distances internally.

## Ranged with a held gun

To have an NPC shoot a gun with the same GAS abilities the player uses, change only the item in its hand:

- Override the `ItemContainer.initialItems` on the actor's `ItemSystem` child (the `Selected` loadout its `EquipmentBinder` equips from): `pistol` + `ammo_9mm*60`, or `rifle` + `ammo_556*90` (up to 90 per entry; add more entries for more), the gun first and its ammo after it in the same container. `npc_test_pistol` (1 damage, never runs dry) needs no ammo. The binder selects the first equippable item.
- Keep `ActorAnimatedAttackComponent`; nothing else is needed. It fires the gun in hand at the target through the same attack-controller registration, and the gun animates through `EquipmentAnimationModule`'s equipment layers. `targetHeightOffset` sets how high above the target root the gun aims (default 1 m).
- Set `maxAttackDistance` / `preferredAttackDistance` to gun range, as in **Ranged** above. A gunner left at the melee default walks up to the target before firing; a target past the gun's `Hitscan` `range` is refused.
- Damage, fire rate, magazine and reload belong to the **item** (its `Weapon` and `Magazine` in `scripts/GameContent/ItemCatalog.ts`). `attackDamage` on the starter does not affect a gunner. The weapon's GAS fire ability decides whether a shot happens (dead, staggered, reloading, cooldown, ammo), so do not add gates to the controller.
- The `Magazine` reloads by itself when empty, drawing items that carry its `ammoTag` from the actor's containers. Once the loadout's ammo is spent the gun stops firing, so carry enough ammo entries, or use `npc_test_pistol`, whose `Magazine` has no `ammoTag`.
- To filter hits, set the item `Weapon`'s `targetTag` to a **GAS** tag that only the NPC's intended targets carry. It is matched against the target's `GASComponent` tags, so the targets must list it in `GASComponent.initialTags` (for example, add `player` to the player template's `initialTags`). It is **not** the ActorSdk `player` tag that `targetTags` reads: players get that one automatically, but in this package they carry no GAS `player` tag, so `targetTag: player` alone filters out every hit with no error. Empty means anything with a `GASComponent`, so the shot damages whichever such entity is first on the ray, including another NPC standing in the way. The tag belongs to the catalog item, so a per-NPC tag needs its own item.
- The weapon sets the pace: `AttackEntityInRangeBehavior` attacks whenever `canAttack()` allows, and for every item in hand — gun, sword or fists — that is the item's GAS fire ability (`fireRate`, `windupSec`, `recoverySec`, reload, ammo).

## Shooter-game opponent (StarterShooterCombatComponent)

For an enemy that should fight like a bot in a shooter (strafe, take cover, retreat, hunt), use `StarterShooterCombatComponent` **instead of** `StarterCombatComponent` on an actor armed as in **Ranged with a held gun**. Do not put both on one actor; they claim the same controllers at the same priority.

- It sees only within `sightRange` and line of sight (a physics ray at 1 m height, blocked by world geometry and other characters), so cover and walls matter. Being shot by its target also reveals the target.
- It waits `reactionTime` after first sight before firing, and its shots stray within a cone that starts at `maxAimErrorDeg` and settles toward `minAimErrorDeg` while the target stays visible. A moving target or a moving shooter strays more.
- It strafes between `minRange` and `maxRange`, drifting toward `preferredRange`. It moves to cover while the weapon reloads, retreats toward cover at or below `retreatHealthPercent`, and searches the last known position for `memorySeconds` after losing sight.
- `regenPerSecond` heals it after two seconds out of its target's sight, through a periodic GAS effect it holds on itself while hidden (a dead body never heals). Without regeneration a retreat ends after `maxRetreatSeconds`, and the actor then fights on.
- It fires only through the weapon in hand, and only at a target within that weapon's reach (the controller's `attacksThroughWeapon` and `attackReach`); a target beyond the weapon's `range` is also refused by `canAttack(target)`. Arm it with a gun: the default `fists` reach only 1.2 m.
- Cover needs world geometry (Layer2) taller than `coverEyeHeight` (1.6 m, a standing character's eye height) and baked into the navmesh; walls 2 m tall are enough. On a bare floor the actor still strafes and retreats, but finds no cover.
- Turn off stagger (`StarterHealthAndDeathComponent.disableStagger`) for a gunner facing a fast-firing weapon, or each hit stops it from firing.

## Multiplayer (networked projectiles)

Worlds are client–server, so a ranged attacker must stay consistent for every player. An item's `Projectile` delivery + `GASProjectile` already do this; keep to it rather than adding logic to the projectile:

- **Hit detection runs on the owner, and damage lands once.** `GASProjectile` moves and detects hits on its owner, and the weapon applies its registered damage effect with `applyEffectToTarget`, which routes to the victim's owner. Applying damage on every client would multi-count it.
- **Impact cosmetics reach every player through the hit cue.** A `hitCueTag` cue is broadcast to all clients when the damage applies; a `NetworkMode.LocalOnly` impact spawned on the owner would be invisible to remote players.
- **Each shot is its own networked spawn,** destroyed when it lands or its `lifetimeSec` ends.

## Stationary attacker (turret / defender)

For a defender that must hold position (e.g. a wizard at a wall) instead of chasing, set `engagementRange === maxAttackDistance` (e.g. both `10`, with `minAttackDistance: 0`). The target is then never "detected but out of attack range", so `AttackEntityInRangeBehavior` (internal priority 2) claims the movement controller and stops the actor the instant it acquires a target — the priority-1 follow never advances it. For an absolute guarantee it cannot move, give the actor no movement controller at all (omit `ActorTransformMoveComponent`): `EngageCombatBehavior`'s follow then has nothing to drive, while the attack controller still fires. Do not try to compose `TargetTaggedEntityBehavior` + `AttackEntityInRangeBehavior` yourself — `AttackEntityInRangeBehavior.targetEntity` is only wired by `EngageCombatBehavior.update()`, so a hand-composed pair never acquires a target and never attacks.

## Attacking a static structure or objective (tower defense)

The target does **not** have to be a player or another actor — it can be a **static structure** (a castle, a base, a crystal, a door). This is the tower-defense pattern: enemies path to a structure and attack it until it is destroyed. Wire it exactly like any other combat target — do **NOT** hand-roll a per-frame "measure distance to the structure, then call `takeDamage`" loop on the spawner/attacker. That hand-rolled proximity loop is the anti-pattern this skill exists to replace: it re-implements (worse) what `EngageCombatBehavior` already does with correct surface-to-surface range, and it typically hardcodes the structure's position instead of tracking the live entity.

Give the **structure** three things:

1. A physics collider (`ColliderBoxComponent` for a building) — required for surface-to-surface distance.
2. A `CharacterGASComponent` with `initialMaxHealth` set explicitly. The attacker's weapon (the item in hand, or the `GASProjectile` a thrown item spawns) resolves the GAS of whatever it hits and applies its registered damage effect there, sourced at the attacker. Use its subclass `ActorGASHealthComponent` instead if the structure should play a hit/destroy animation or despawn via `DeathBehavior`.
3. A tag via `ActorSdkTagComponent` (e.g. `"castle"`) so `EngageCombatBehavior` can acquire it.

A structure that only *receives* damage (a passive objective — a wall, a crystal) needs nothing beyond the three items above: `EngageCombatBehavior` acquires it by tag (via its `ActorSdkTagComponent` + `TransformComponent`) and the attacker's controller resolves its `CharacterGASComponent` to apply damage — neither path reads an `ActorSdkLogicComponent` on the target. Add `ActorSdkLogicComponent` (plus its own attack behaviors) to the structure only if it must itself *act* — a defensive tower that shoots back, e.g. `wizard_fireball_defender`; then it is an actor in its own right.

Give the **attacker** a normal melee combat setup (`StarterCombatComponent` or `EngageCombatBehavior` + `ActorAnimatedAttackComponent`) with `targetTags` set to the structure's tag.

**Express the prompt's distance literally, as surface-to-surface reach.** When the creator says "attack when within 1 m of the castle", set `maxAttackDistance: 1.0` — nothing more. `maxAttackDistance` is the gap between the two colliders' *surfaces*; the framework adds both footprints (including the castle box's large half-extents) automatically. Do **NOT** convert "1 m" into a larger center-to-center number (e.g. `3.5`/`4.0` "to account for the castle collider") — that is exactly the footprint math the framework already does, it reads as the wrong distance to anything inspecting the value, and a large structure's center is unreachable anyway (the attacker collides with the wall long before reaching the pivot). Author the literal reach; the framework handles the geometry.

```typescript
// Configuration values only — wire into `actorLogic` inside a starter script as
// shown in the Usage section above:
//   import {EngageCombatBehavior} from '../scripts/Actor/Behaviors/CompositeBehaviors/EngageCombatBehavior';
//   const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
// Zombies attack a castle when within 1 m of its wall.
const combat = new EngageCombatBehavior();
combat.basePriority = 10;
combat.targetTags = ['castle'];   // matches the castle's ActorSdkTagComponent tag
combat.maxAttackDistance = 1.0;   // 1 m from the castle SURFACE (surface-to-surface)
combat.engagementRange = 0;       // unlimited: acquire the castle from anywhere
combat.followSpeed = 3.0;
actorLogic.addBehavior(combat);
```

## Key Properties

| Property | Default | Description |
|---|---|---|
| `targetTags` | `["player"]` | Tags to target via `ActorTaggingBlackboard` |
| `maxAttackDistance` | `1.5` | Max surface-to-surface distance (meters) for attacks. Weapon reach. |
| `minAttackDistance` | `0` | Min surface-to-surface distance (meters). Dead zone for ranged NPCs. |
| `preferredAttackDistance` | `0` | Where NPC stands (surface-to-surface meters), clamped into the attack band. `0` presses to the INNER edge — melee closes to the target's collider surface. Set a positive value only for a kiter (see Ranged above). |
| `engagementRange` | `0` | Surface-to-surface distance (meters) for target acquisition/retention. `0` (or unset) = **unlimited**: acquires the nearest tagged target at any distance, so an enemy spawned away from its target still hunts it. Set a positive value only for a dormant/ambush enemy that must wake within range. |
| `followSpeed` | `5.0` | Movement speed (m/s) when pursuing |
| `attackDamage` | `1` | Not used by `ActorAnimatedAttackComponent`: the held item's own `damage` applies (`fists`: 10) |
| `basePriority` | — | Priority of the composite behavior |

## How It Works

`EngageCombatBehavior` extends `CompositeBehavior`, which handles controller routing across sub-behaviors automatically. On `initialize()`:

1. Validates `minAttackDistance <= maxAttackDistance` (swaps and warns if violated)
2. Creates a `FollowTaggedEntityBehavior` (internal priority 1) configured with the target tags and follow speed
3. Creates an `AttackEntityInRangeBehavior` (internal priority 2) configured with attack damage; it attacks whenever the attack controller's `canAttack(target)` allows, so cadence is the attacking weapon's GAS fire ability (its `fireRate`, `windupSec` and `recoverySec`)

Each frame in `update()`:
1. Syncs the resolved target entity from the follow behavior to the attack behavior
2. Uses cached collider footprints (auto-invalidated on target swap and root XZ scale change)
3. Derives center-to-center distances: `follow.followRange = sumR + preferredAttackDistance`, `attack.maxAttackDistance = sumR + maxAttackDistance`, etc.
4. Pushes derived values to sub-behaviors via `applyRuntimeRanges()`
5. Monitors for pursuit stalls (warns after 5s if NPC cannot reach attack band)

The `getTarget()` method returns the currently resolved target entity, useful for external systems that need to know what the NPC is fighting.

Footprint cache invalidation: target swap and root XZ scale change auto-invalidate. For rig swap, equipment change, or child-collider scale animations that don't move the root scale, call `combat.invalidateFootprintCache('self' | 'target' | 'all')` from the authoring code that mutates the collider.

## Common Mistakes

1. **Setting `minAttackDistance` / `maxAttackDistance` on `AttackEntityInRangeBehavior` directly** — these fields on the sub-behavior are center-to-center values derived by the composite. Set them on `EngageCombatBehavior` instead, which adds collider radii automatically.
2. **Missing attack controller** — NPC needs an `ActorAttackController` implementation (e.g. `ActorAnimatedAttackComponent`) or attacks silently do nothing.
3. **Wrong `targetTags`** — must exactly match the tag on target entities (case-sensitive), and `EngageCombatBehavior.targetTags` is an array: use `["player"]` for auto-tagged players. See "The Tag Targeting Contract" in the parent skill.
4. **Missing collider** — without a `ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`, collider radius defaults to 0 (center-to-center fallback). Attach a collider for correct surface-to-surface distance.
5. **No movement controller** — a chasing NPC needs `ActorTransformMoveComponent` (the mover named in the Actor Contract) to follow the target. `ActorPhysicsComponent` is not a mover — it only toggles collision/gravity.
6. **Priority conflicts** — if other behaviors have higher priority on the same controllers, combat won't execute. Set `basePriority` higher than idle/patrol behaviors.
7. **Mutating colliders without invalidating the footprint cache** — `EngageCombatBehavior` caches `getFootprintXZ()` and auto-invalidates only on target swap or root XZ scale change. After rig swap, equipment change, or child-collider scale animations, call `combat.invalidateFootprintCache(scope)` to force recompute:
   ```ts
   combat.invalidateFootprintCache('self');    // this actor scaled / swapped its rig
   combat.invalidateFootprintCache('target');  // current target swapped equipment
   combat.invalidateFootprintCache('all');     // world reset / NPC pool reuse
   ```
8. **Wrong `muzzleOffset` on the item's `Weapon`** — the offset is relative to the caster with z **forward**. A zero or negative `z`, or world-space values, spawns the projectile inside or behind the caster, where it self-collides. Use a positive `z` past the caster's collider radius.
9. **Oversized projectile VFX** — the fireball/explosion effect spawns huge because VFX particle size is controlled by **VFX parameters** (e.g. `global_scale`), not the entity transform; scaling the projectile entity does nothing to the particles. Tune the VFX `global_scale` down (see the `tuning-vfx-parameters` skill).
10. **VFX not parented to the projectile** — the trail effect stays at the firing point instead of travelling with the shot because it was spawned as a separate entity (or left unparented). Bundle it as a child entity (with a `VfxPlatformComponent` carrying the asset + params) inside the projectile template so it follows the projectile.
11. **No impact effect** — the hit plays nothing because the item's `hitCueTag` is empty, or no `GameplayCuePresentation` on the victim binds that tag to a VFX.
12. **Projectiles miss moving targets** — there is no lead-target prediction, so the shot flies at the target's position when fired. For a projectile that must connect, set `homeOnTarget: true` on the item's `Projectile` delivery.
13. **Ranged NPC never fires** — the loadout override lacks a weapon item (it punches with the fists instead), the item id is misspelled (the container logs `could not place initial item`), the projectile item's `template` lacks `GASProjectile` + a Trigger body, or the item's `muzzleOffset` z is not forward past the collider.
