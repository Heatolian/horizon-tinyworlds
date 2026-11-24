# Actor Templates Registry

| Template Name | File Path | Description | Status |
|---------------|-----------|-------------|--------|
| BaseActor | `Templates/Actors/BaseActorTemplate/BaseActor.hstf` | Internal authoring source that new NPC types are duplicated from: mesh, animator, character simulation, and capability controllers, but no behavior starter. It is not a ready NPC or enemy and must not be placed directly for a character request. | **AUTHORING SOURCE** |

## What `BaseActor` already carries

Generated from the template. Adding any of these to a duplicate is a duplicate
component, not a fix.

<!-- BEGIN GENERATED: base-actor-root-components -->

<!-- Generated from Templates/Actors/BaseActorTemplate/BaseActor.hstf. -->

| Already on the `BaseActor` root — do not add it again | What it gives you |
|---|---|
| `horizon::platform_api::TransformPlatformComponent` | The root transform every other component positions against. |
| `WorldsCharacterStateReplication` | Generic networked key → value + trigger replication with client-side prediction: predict locally, RPC to the owner, replicate to every client. Domain-agnostic… |
| `CharacterAnimationController` | Host for character animation modules: drives base locomotion, routes replicated state, and supplies shared Animator operations. |
| `CharacterStateMachine` | Tracks whether the character is moving, jumping or dead, and runs the ability that owns the current state. Dead is the authority on incapacitation. |
| `CharacterUpdateManager` | Centralized per-frame update driver for all character sub-systems |
| `horizon::platform_api::NavMeshModifierPlatformComponent` | Keeps the actor out of the baked navmesh, so it does not carve a hole in the surface it walks on. |
| `ActorSdkLogicComponent` | The Actor SDK hub every controller registers with and every behaviour claims through. Without it no behaviour reaches the body. |
| `ActorAnimatedAttackComponent` | Attack controller for animated actors: attacks with the weapon in hand (the item its ItemSystem loadout equips, such as BaseActor's fists), aiming it at the… |
| `ActorTransformMoveComponent` | Walks the actor and turns its body. Registers as the movement controller and the body-direction controller, except for an axis that an adapter on the same… |
| `ActorGASHealthComponent` | NPC health. Inherits the shared GAS health component and adds the Actor Framework health controller, blackboard death reporting and combat telemetry. |
| `ActorPhysicalStaggerController` | Applies a knockback impulse when StaggerBehavior staggers the actor. Hit animation is owned by CharacterGASComponent. |
| `StarterHealthAndDeathComponent` | Wires death and hit stagger for an actor, against whatever registers as the ActorHealthController, and handles post-death cleanup. |
| `ActorPickupItemComponent` | Lets the actor carry an item in a hand slot. Binds the slots by explicit entity reference, falling back to a child named RightHandSocket/LeftHandSocket when… |

<!-- END GENERATED: base-actor-root-components -->

Off the root: `Visuals` (mesh, animator, and the four sockets `RightHand`,
`LeftHand`, `Back`, `Head`), `KinematicCharacter` (character simulation, forces,
ground info) and its `KinematicCollider`.

## What `BaseActor` does not carry

| Missing | Add when |
|---|---|
| `ActorSdkTagComponent` | Anything must acquire this actor by tag. A scene instance can add it by delta; a spawned one cannot — see below. |
| A behaviour starter, e.g. `StarterCombatComponent` | Always. A bare duplicate stands still. |
| `JumpAbility` **and** `ActorJumpController` | The actor must jump. `CharacterStateMachine` is present, but the two pieces that drive it are not. |

## Contracts that catch people out

| | |
|---|---|
| **A template instance zero-inits every property its delta omits** | Class defaults do not survive instantiation. An instance carries only the properties its delta names; everything else arrives as `0`, `false` or `""` whatever the class declares. The booleans are the sharp edge, because `false` usually selects a *different code path* rather than a smaller value — so the component loads, runs, and silently does the wrong thing. Most `Starter*` settings treat an unset speed, range or interval as its default, and the starters name their booleans so that `false` is the usual choice. Some settings give 0 a meaning instead: `StarterCombatComponent` copies `minAttackDistance`, `preferredAttackDistance` and `engagementRange` as authored (0 = no dead zone, press to the inner band edge, unlimited range) and holds position at `followSpeed` 0; `StarterFollowComponent.giveUpRange` 0 means no limit. Other components may not default at all. Set every property explicitly on an instance, including the ones whose class default is already what you want. |
| **Hand slots are set explicitly, and must stay that way** | Left unset, `ActorPickupItemComponent` searches for a child named `RightHandSocket`/`RightHandSlot` or `LeftHandSocket`/`LeftHandSlot` — four names this template uses none of. Its entities are `RightHand_Socket` and `LeftHand_Socket`, so the fallback finds nothing and `rightHandSlotEntity`/`leftHandSlotEntity` carry the binding. The entity name is not the socket name: the sockets are `RightHand` and `LeftHand`. |
| **Death needs `ActorGASHealthComponent`** | A bare `CharacterGASComponent` raises the death tag but registers no `ActorHealthController`, which is what `DeathBehavior` polls. `ActorGASHealthComponent` extends it and adds that registration. |
| **`search-and-pickup` collects one item per run** | Even with `persistent: true`. The next pickup is refused while the hand is full, and nothing in the run empties it. |
| **Nothing registers an `ActorLookController`** | So gaze has no receiver and attention is invisible unless `turnBodyToTarget` is `true`. There is no `ActorAnimatedLookController`; that class does not exist. |

## Why station actors need their own templates

A template instance configured in a scene carries its settings in a per-instance
delta. A SPAWNED instance has no delta — `ActorSpawner` instantiates the template
as authored — so anything a spawned actor needs must be baked into its own
template file. That includes `ActorSdkTagComponent`, which `BaseActor.hstf` does
not carry at all (scene instances add it by delta), and without which no attacker
can acquire the spawned actor.
