---
name: implementing-actor-combat
description: Adds melee combat to an Actor Framework NPC by composing the follow and attack behaviors under EngageCombatBehavior, including target resolution by tag and the melee strike wiring.
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
    when: targets come from an external detection or threat system, or factions must be distinguished
---

# Adding Melee Combat to Actor Framework NPCs

A melee combat NPC uses two core behaviors composed by `EngageCombatBehavior`:

- **FollowTaggedEntityBehavior** — finds the closest entity matching one or more tags (e.g. `"player"`) via `ActorTaggingBlackboard` and moves toward it
- **AttackEntityInRangeBehavior** — triggers an attack when the target is within range, claiming the attack and movement controllers to stop and strike

`StarterCombatComponent` wires this up as a single component on the NPC root entity.

> **Ranged variant.** This skill covers melee (direct-hit) attackers. For a
> **ranged** attacker — one that shoots, casts, fires, or throws a projectile
> (e.g. an archer, a turret, a wizard that shoots fireballs) — the structure is
> the same, and the attack controller is the SAME component: only the item in
> the actor's hand changes. Override the `ItemSystem` child's loadout
> `initialItems` with `fireball` (a thrown `Projectile` item) or a gun (`pistol`,
> `rifle`, `npc_test_pistol`) instead of the default `fists`. Never hand-roll a
> bespoke projectile. An actor cannot hold a grenade or molotov: the loadout's
> `rejectTags` refuses `weapon.thrown`, so such an `initialItems` entry is
> skipped. See the `making-actors-engage-in-combat` skill (Melee vs Ranged).

## Trigger Conditions

Activate this skill when the creator asks to:

- "Create a melee enemy" / "Make a melee NPC" / "Add a sword-wielding enemy"
- "Make an NPC that attacks me" / "Create an NPC that fights the player"
- "Add combat to this NPC" / "Make this NPC fight" / "Give this NPC attack abilities"
- "Create enemies that will attack me" / "Add hostile NPCs"
- "Create NPCs that fight each other" / "Make two NPCs battle each other"
- "Create a boss enemy" / "Make a mob enemy" / "Add combat AI"
- "Make an NPC chase and attack" / "Add a goblin that attacks nearby players"

## Prerequisites

- `ActorSdkManagerComponent` on a persistent scene entity (bootstraps services including `ActorSdkTagPlayerService`) — this is a **scene** entity, not the actor, so it is never on `BaseActor`
- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorAnimatedAttackComponent` on the actor root (already there on a `BaseActor` duplicate). It attacks only with the weapon in the actor's hand: the item the `EquipmentBinder` on the `ItemSystem` child equips from its `Selected` loadout `ItemContainer` — the `fists` item by default, or whatever that container's `initialItems` override gives it (see Ranged variant above)
- A physics collider (`ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`) for automatic surface-to-surface distance calculation — the capsule on the `KinematicCharacter` child is already there on a `BaseActor` duplicate
- A masked additional AnimGraph layer (`Attack_Layer`) whose state machine holds the attack states `Attack` and `Empty State`, listed in the `Visuals` entity's `AnimatorPlatformComponent.additionalLayers`. Already bound on a `BaseActor` duplicate, alongside `Airborne_Layer`, `Ranged_Layer`, the shared equipment layer `InteractionItem_Layer` (driven by `EquipmentAnimationModule` with the held weapon's remap page), `Take_Damage_Layer` and `Death_Layer`. The attack states live on this additional layer, and their authored names live in `ActorActionAnimationModule`.

## Getting Started

Add `StarterCombatComponent` to the NPC root entity. It wires `EngageCombatBehavior` which composes `FollowTaggedEntityBehavior` + `AttackEntityInRangeBehavior`:

- **FollowTaggedEntityBehavior** moves the NPC toward the target, closing to striking distance
- **AttackEntityInRangeBehavior** triggers attacks when the target is within the `minAttackDistance`–`maxAttackDistance` band, stops movement, and rotates to face the target

The NPC also needs these components on the root entity:

- **`ActorSdkTagComponent`** — registers the NPC in the tagging system with tags (e.g. `"enemy"`). Without it, other combat NPCs cannot target this entity.
- **`ActorAnimatedAttackComponent`** — the attack controller. Aims the weapon in hand at the target and fires it; the weapon paces the attack and lands the damage. It never drives the animator itself: the fists play `AnimationAction.MELEE` and the fireball `AnimationAction.RANGED` through the entity's `CharacterAnimationController`, while pistol, rifle and sword animate through `EquipmentAnimationModule`'s equipment layers.

The framework sources are checked into this package — read them directly for
full implementation details:

- Behaviors: `scripts/Actor/Behaviors/BaseBehaviors/` and `scripts/Actor/Behaviors/CompositeBehaviors/`
- Controllers: `scripts/Actor/Controllers/Implementations/`
- Starter: `scripts/Actor/Behaviors/Starters/StarterCombatComponent.ts`

## Combat Properties

Key properties on `StarterCombatComponent`:

| Property | Default | Notes |
|---|---|---|
| `targetTags` | `'player'` | Comma-separated tags to target |
| `engagementRange` | `0` | Surface-to-surface distance to acquire/retain a target. `0` (or unset) = **unlimited**: acquires the nearest tagged target at any distance, so an enemy spawned away from the player still hunts it. Set a positive value only for a dormant/ambush enemy that must wake within range. |
| `minAttackDistance` | `0` | Min surface-to-surface distance. Dead zone for ranged NPCs. |
| `maxAttackDistance` | `1.5` | Max surface-to-surface distance (meters) for attacks. Weapon reach. |
| `followSpeed` | `3.0` | Chase speed (m/s) |
| `preferredAttackDistance` | `0` | Where NPC stands (surface-to-surface meters), clamped into the attack band. `0` presses to the INNER edge — a melee actor closes to the target's collider surface. Set a positive value only for a kiter that must hold range. |

Attack pacing lives only on the attack weapon — there is no behavior-side
cadence. `ActorAnimatedAttackComponent` attacks with the weapon item in the
actor's hand, equipped by the `EquipmentBinder` beside a `GASComponent`: the
item's fire ability decides
readiness, its `fireRate`, `windupSec` and `recoverySec` pace and time the swing,
its `damage` lands as a weapon effect sourced at the attacker, and the
`state.dead` and `state.staggered` tags refuse it. The behavior's `attackDamage`
does not reach the weapon. Gate other attacks on those same tags rather than on
local flags.

Every `BaseActor` duplicate starts with fists: the `fists` item (10 damage, one
punch per 1.5 s, 0.4 s wind-up, aimed directly at the attack target) in the
`Selected` loadout `ItemContainer` on its `ItemSystem` child, equipped by the
`EquipmentBinder` beside it. To arm the actor with something else, override that
container's `initialItems` with another catalog item id (e.g. `sword`, or
`rifle` plus `ammo_556*90`, or `fireball` for a thrown projectile); for different
fists, add an item to `scripts/GameContent/ItemCatalog.ts`. An actor with no
`EquipmentBinder` logs that it "will never attack" and does not register as an
attack controller.

Two constraints the source cannot state on its own, because each spans two
components or properties:

- The weapon's `windupSec` must be strictly LESS than the controller's
  `swingDurationSec`. It is the contact frame inside that swing, so a value at or
  past the end lands the hit on the last frame and the victim only reacts once the
  swing has finished. Tune per clip against both edges: too late and the reaction
  trails a completed swing, too early and the swing never reads before the victim
  recoils.
- Each cooldown must stay above `0.1`. The animation layer leaves on
  `state_finished AND <cooldown> > 0.1`, so a `0` freezes the character in the last
  frame of the pose.

Neither the controller nor the item holds a layer name, state name or animator
reference. The fists and fireball items ask the entity's
`CharacterAnimationController` for a gameplay INTENT when their fire ability
activates, and the animation side decides how to play it (pistol, rifle and
sword instead animate through `EquipmentAnimationModule`'s equipment layers):

```typescript
animation.play(AnimationAction.MELEE);    // fists
animation.play(AnimationAction.RANGED);   // fireball
animation.stop(AnimationAction.MELEE);    // abort a swing before contact (stagger)
```

**Multiplayer needs no extra wiring.** The layer serving that intent replicates the
edge itself — predicted locally on the caller for an instant response, then owner →
all clients — so there is one launcher by construction and no way to double-fire.
Call `play()` on whichever client detected the attack; do not wrap it in your own
`@rpc`.

**Timing lives on the weapon and the controller, playback in the layer.** The
weapon owns `fireRate`, `windupSec` and `recoverySec`; the controller owns
`swingDurationSec` / `swingCooldownSec` (and the throw pair) and pushes them down
to the layer with `animation.tune(...)` at create time. Keep the weapon's
`windupSec` under `swingDurationSec`: they describe the same swing.

**To add a new actor attack family**, add an `AnimationAction` and its authored names to
`ActorActionAnimationModule`; do not add another component or a class per Animator layer.
Equipment weapons instead name a remap page (`remapper`) in their `Weapon` config, or reuse an existing `animKey` and its page.

Source: `scripts/Actor/Controllers/Implementations/ActorAnimatedAttackComponent.ts`

## Customization

For more control over behavior composition — e.g. custom target selection, conditional activation, or additional behaviors — extend `BehaviorStarterComponent` and override `startBehavior()`:

```typescript
import {component, property} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent} from '../scripts/Actor/Behaviors/Starters/BehaviorStarterComponent';
import {EngageCombatBehavior} from '../scripts/Actor/Behaviors/CompositeBehaviors/EngageCombatBehavior';

@component({description: 'Custom combat starter'})
export class CustomCombatStarter extends BehaviorStarterComponent {
  @property()
  targetTags: string = 'player';

  @property()
  engagementRange: number = 0; // 0 = unlimited acquisition — see Combat Properties

  @property()
  followSpeed: number = 4.0;

  override startBehavior(): void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[CustomCombatStarter] No ActorSdkLogicComponent on the controlled actor');
      return;
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = 10;
    combat.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    combat.engagementRange = this.engagementRange;
    combat.followSpeed = this.followSpeed;

    actorLogic.addBehavior(combat, this.removeDuplicates);
  }
}
```

The base owns the owner-scoped start subscription and resolves `controlledActor`, so
`startBehavior()` runs only on the owner and only once an actor is resolved. It also
supplies the inherited `controlledActor`, `autoStart` and `removeDuplicates`
properties.

## Tagging

Targets are resolved via `ActorTaggingBlackboard` — no manual player tracking code needed. `ActorSdkTagPlayerService` auto-tags players with `"player"`, and `ActorSdkTagComponent` tags NPCs with custom tags like `"enemy"`.

`StarterCombatComponent.targetTags` accepts a comma-separated string (e.g. `"player"`, `"player,enemy"`). The actor engages the closest entity matching **any** listed tag.

For NPC-vs-NPC combat, tag each faction differently (e.g. `"team_a"`, `"team_b"`) and set each NPC's `targetTags` to the opposing faction.

## Common Mistakes

1. **Missing `ActorSdkManagerComponent`** — without it, `ActorSdkTagPlayerService` never starts and players are never tagged. Combat NPCs won't find targets.
2. **Attack layer missing from the template** — actor melee uses the optional `Attack_Layer` entry on the `Visuals` Animator. If it is absent, `ActorActionAnimationModule` leaves that capability disabled. State names remain authored in the graph and declared beside the module config.
3. **Wrong `targetTags`** — must match tags registered on target entities. Use `"player"` to target auto-tagged players, or match custom `ActorSdkTagComponent.tags`.
4. **No physics body** — movement controllers require a `PhysicsBodyPlatformComponent`. Without it, the NPC cannot move.
5. **NPC missing `ActorSdkTagComponent`** — without it, other combat NPCs cannot discover this entity through the tagging system.
6. **Attack delay misaligned** — set the weapon's `windupSec` to match the hit frame in the attack animation. Too early = hit registers before visual contact; too late = after animation ends.
7. **Missing collider** — without a `ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`, collider radius defaults to 0. Attach a collider for correct surface-to-surface distance.
8. **Mutating colliders without invalidating the footprint cache** — `EngageCombatBehavior` caches footprints and auto-invalidates only on target swap or root XZ scale change. After rig swap, equipment change, or child-collider scale animations, call `combat.invalidateFootprintCache(scope)`:
   ```ts
   combat.invalidateFootprintCache('self');    // this actor scaled / swapped its rig
   combat.invalidateFootprintCache('target');  // current target swapped equipment
   combat.invalidateFootprintCache('all');     // world reset / NPC pool reuse
   ```
