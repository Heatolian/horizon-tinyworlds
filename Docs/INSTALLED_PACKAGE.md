# Installed Package

Installed systems, default wiring and reuse instructions. **Configured** means
attached and wired; **available** means installed but still needing
configuration or placement. Neither certifies ingestion, rendering or runtime
gameplay. Default state refers to `space.hstf` and
`Templates/PlayerCharacter.hstf`.

## Authoring

Start scene changes in `space.hstf`, and player changes in
`Templates/PlayerCharacter.hstf`.

Reuse the installed building blocks for the requested feature rather than
treating their presence as an already-authored game.

The floor, skybox and mannequin character are placeholders that must be replaced
for the game being authored. This does not require changing art for
unrelated incremental edits.

Configured or installed does not mean runtime-verified: these
docs do not certify ingestion, rendered poses, multiplayer behavior or gameplay.

## System catalog

| System                            | Default state                                             | Details                                         |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Movement and jump                 | Player scaffold configured; touch Jump wired.             | [Movement](#movement-and-jump)                  |
| Moving platforms                  | Player ride configured; rides any moving platform.        | [Platforms](#moving-platforms)                  |
| Input and touch controls          | Portrait joystick/Move/Jump/Look configured.              | [Input](#input-and-touch-controls)              |
| Camera                            | ThirdPerson configured; eleven modes; local body hiding. | [Camera](#camera)                               |
| Interaction                       | Player detection configured; no targets placed.           | [Interaction](#interaction)                     |
| Items and containers              | Catalog/services configured; player containers empty.     | [Items](#items-and-containers)                  |
| Weapons and deployables           | Drivers installed; player unarmed; presentation assets in inventory. | [Weapons](#weapons-and-deployables)             |
| Audio                             | Music/ambience helper unassigned and unplaced.             | [Playback choices](../scripts/GameContent/Audio/README.md) |
| Character and equipment animation | Base graph and four feature layers configured.            | [Animation](#character-and-equipment-animation) |
| GAS health and death              | Player health/death configured; hit stagger off.          | [Health](#gas-health-and-death)                 |
| Actors (NPC/Enemy) and spawning   | Base actor/library installed; no NPC placed.              | [Actors](#actors-and-spawning)                  |
| Bot players                       | Services placed; bot fill off.                            | [Bots](#bot-players)                            |
| Navigation                        | Baked assets configured; rebake after edits.              | [Navigation](#navigation)                       |
| Persistence                       | Saved-number example available; not placed.               | [Persistence](#persistence)                     |
| NUX                               | Saved tutorial example available; not placed.             | [NUX](#nux)                                    |
| Asset building blocks             | SDK primitives available; placeholder scene/character art installed. | [Assets](#asset-building-blocks)                |

## Asset inventory

Some templates lack visuals. Download the listed asset or bundle first; read its
README and use included resources.

Rifle visuals are installed locally.

- Grenade: Grenade bundle (model, VFX, SFX) — asset library listing ID
  `1108623388809310`.
- Molotov: Incendiary grenade bundle (model, impact/fire VFX, SFX) — asset
  library listing ID `1131420619287802`.

## Movement and jump

- **Provides:** Character movement, facing, simulation, ground detection and
  Jump, including coyote-time and buffering logic.
- **Default:** `StartingWorld` selects `PlayerCharacter`. Native left-axis and
  touch joystick movement are camera-relative. Touch Jump reaches
  `CharacterStateMachine` and `JumpAbility`; the jumping state is registered.
- **Customize:** Tune movement/jump on `Templates/PlayerCharacter.hstf`. Select
  `Joystick`, `ClickToMove` or `HoldToMove` through
  `LocomotionSettingsComponent.locomotionMode`; these are alternatives.
  Click-to-move uses navigation; hold-to-move suits top-down/isometric views.
- **Implementation:** `scripts/Character/`,
  `scripts/Character/Abilities/JumpAbility.ts`, `scripts/Locomotion/` and
  [movement schemes](../scripts/Input/README.md#movement-schemes).
- **Limits:** No native keyboard/gamepad Jump binding is assigned. Changed
  movement schemes and scenery need navigation/runtime checks; configured
  movement is not a completed game loop.

### Runtime movement-facing / camera-facing switch

`AutoFaceRotationAbility` on the player root controls where the body faces. Its
public `strafeMode` flag is read every frame: `false` faces travel and preserves
idle heading; `true` faces horizontal camera-forward during movement **and
idle**, so the animation blend plays strafe/backpedal clips. No respawn or
template swap is needed. `CameraManager` suppresses movement-follow
auto-rotation in camera-facing mode. Rotation blocks and explicit facing
overrides take priority.

**Third-person shooter contract.** The stock player starts in movement-facing
mode. For a camera-aimed shooter, wire
`strafeMode` to held/aimed weapon state. A gun keeps camera-facing during
idle/movement/reload, not only while firing; drop/melee/forward-aim switching
releases it. Do not replace the stock movement controller or add another writer
of player `worldRotation`. In the owner-side integration that resolves the
current player (re-resolve after respawn):

```ts
const facing = player.getComponent(AutoFaceRotationAbility);
const weapon = equippedWeaponOf(player);
if (facing != null) {
  facing.strafeMode =
    weapon != null && !weapon.isMelee && weapon.config.aimSource !== 'forward';
}
```

`equippedWeaponOf` is in `scripts/ItemSystem/features/Weapon.ts`. Firing
eligibility still belongs to the weapon's GAS abilities; the flag controls
facing only.

### Detecting the player in a trigger

`OnTriggerEnterEvent` fires for the stock player: its `KinematicCharacter` body
is a kinematic `DynamicCollider`. Handlers that never react usually filter the
event out:

- `actorEntity` is the `KinematicCharacter` child, not the player root. Walk up
  `parent` to the root and identify the player by `BasePlayerComponent` or
  `PlayerService.getAllPlayers()`. The stock player has no `PlayerComponent`,
  so a `getComponent(PlayerComponent)` check never matches.
- Ownership depends on where the handler runs. On the server, the owner of a
  networked scene trigger, the player is a remote copy: `isOwned()` and
  `PlayerService.isLocalPlayer()` are false there and true on the player's
  client. Gate on them only when the effect must run on one side.
- The default trigger collider layer already detects the player; changing
  layers is not the fix. A custom character is invisible to triggers until it
  has a `PhysicsBody` (`DynamicCollider`, `Kinematic` drive) and a collider;
  `KinematicCharacterPlatformComponent` alone creates no physics body.

## Moving platforms

- **Provides:** Players ride moving platforms: lifts, shuttles, spinners,
  Ferris wheel cars, vehicles and kinematic physics bodies.
- **Default:** `MovingPlatformRideComponent` on the player mounts any moving
  entity under the player's feet; no registration is needed. It parents the
  player root to the platform root, or carries the player by the platform's
  motion when it cannot. A standing rider idles; a jump leaves in the world
  frame.
- **Customize:** Move the platform any way: script its transform, or drive a
  kinematic physics body. Optionally extend `MovingPlatformMoverBase` on the
  platform root to mount without waiting for motion and to tune the
  detachment grace.
- **Implementation:** `scripts/Character/Physics/MovingPlatformRideComponent.ts`
  and `scripts/Character/Physics/MovingPlatformMoverBase.ts`.
- **Limits:** Do not add platform motion to the character's movement
  (`addMoveDelta`, velocity, `KinematicForceController` edits): the ride
  already carries the player, who would move twice and play the walk
  animation while standing. Make the platform root networked for a full
  multiplayer ride. Unnetworked roots, and roots whose scale would shear a
  parented rider (scaled unevenly across the floor, a mirrored axis, or
  scaled unevenly and tilted off upright; scale a child mesh and collider
  instead), carry the stock player without a parent link, so other
  players see the rider walk with the platform. Free-simulated dynamic
  bodies (props) are never ridden.

## Input and touch controls

- **Provides:** Native/custom action routing, touch HUD, floating joystick, look
  zone, tap target and optional hold-to-move controls.
- **Default:** `PlayerActionController` routes native left-axis and custom
  Move/Jump/Look; assigned `SecondaryRight` drives held-weapon use. Separate
  `TouchControl` children carry router/HUD/joystick/look/tap/hold controls.
  Joystick/HUD/look use `landscape: false`; portrait and landscape XAML are
  installed. Built-in mobile controls are suppressed. Jump is visible; Interact
  is contextual. `PlayerItemInput` makes Use/Reload/Drop/SwitchWeapon follow the
  item in hand, with Aim only for scoped weapons. Scope/crosshair displays do
  not consume touches.
- **Customize:** Tune `TouchJoystick.mode` (Floating/Fixed/Follow) and
  `directions` (analog/four/eight-way). Follow the input README for new
  controls; keep native bindings, custom button geometry and all three HUD
  layouts in sync, with orientation flags matching the chosen layout.
- **Implementation:** `space.hstf`, `scripts/Input/`, `UI/`,
  `scripts/Input/PlayerActionController.ts`,
  `scripts/GameContent/PlayerItemInput.ts` and
  [controls](../scripts/Input/README.md).
- **Limits:** This controller has no right-stick or mouse-look subscription.
  Native action rows without an assigned input configuration are skipped.
  Disabling custom controls does not supply built-in touch fallbacks; do not
  assume a project-settings file exists at a guessed path.

## Camera

- **Provides:** Eleven camera modes, look, auto-rotation, collision handling,
  scope zoom, recoil and reversible local first-person body hiding.
- **Default:** The scene's single `CameraManager` uses ThirdPerson
  (`cameraMode: 0`), with framing from `targetDistance`, `shoulderHeight` and
  `shoulderOffset`. Look, auto-rotate and collision are enabled. Look feeds
  `addLookDelta`; scopes use `setZoom`, while recoil uses unscaled `kick`.
  Collision snaps by default.
- **Customize:** Tune `targetDistance`, `shoulderHeight` and `shoulderOffset`
  for the default ThirdPerson view. `cameraMode: 10` selects the available
  close OverShoulder view, which instead uses `overShoulderDistance`,
  `overShoulderHeight` and `overShoulderOffset`; its `overShoulderPitch` applies
  on mode activation. The ThirdPerson framing properties do not tune
  OverShoulder. Both modes share look, FOV, zoom and collision controls.
  Switch through the scene property or `CameraManager.setMode()`.
  `collisionSmoothing` opts into hold/ease behavior;
  zoom and recoil remain independent of zoom-scaled look input. FirstPerson and
  scope zoom with `fromEyes: true` hide the owned, non-networked body mesh bound
  through `CharacterAnimationController.animatorEntity`. Leaving the eye view
  restores its previous visibility; late/replaced meshes and pending restores
  are retried.
- **Implementation:** `space.hstf` and `scripts/Camera/`, including
  `FirstPersonBodyVisibility.ts`; see
  [controls](../scripts/Input/README.md) for the look-input route.
- **Limits:** Networked body meshes are not hidden; they need a client-local
  visibility API. Installed modes and collision wiring are not runtime
  validation of a changed scene or camera setup.

## Interaction

- **Provides:** Nearby detection, camera-facing selection, tap/contextual
  interaction, example toggles and ItemSystem pickup interaction.
- **Default:** The player's `Interactor` has a Layer3 sensor, Layer2
  line-of-sight mask and contextual Interact bridge. No interactable target is
  placed. Lever/door examples use `SimpleInteractableToggle`; loot uses
  ItemSystem `Interactable`.
- **Customize:** Reuse `Templates/Interaction/InteractableLever.hstf` or
  `Templates/Interaction/InteractableDoor.hstf` for a toggle, or the matching
  loot template for pickup. Preserve networked roots and interaction sensors.
- **Implementation:** `Templates/PlayerCharacter.hstf`,
  `Templates/Interaction/`, `scripts/Interaction/` and
  [interaction instructions](../scripts/Interaction/README.md).
- **Limits:** Player-side wiring does not place targets. Layer1 is for
  characters, Layer2 for world collision and Layer3 for interaction detection;
  preserve this wiring when customizing.

## Items and containers

- **Provides:** Catalog definitions, server-owned containers, equipment
  requests, pickup/chest templates, dropping and death bags.
- **Default:** Scene `ItemCatalogLoader` and `PlayerContainersSpawner` create
  each player's empty three-slot Loadout and 20-slot Backpack from
  `Templates/GameContent/PlayerContainers.hstf`. No pickup/chest is placed.
  Registered player items are `pistol`, `rifle`, `sniper`, `shotgun`, `sword`,
  `grenade`, `molotov`, `ammo_9mm`, `ammo_556`, `ammo_12g` and `medkit`;
  NPC/test items are `fists`, `npc_test_fists`, `npc_test_pistol` and
  `fireball`. `DropOnDeath` transfers carried items into `DeathBag`, whose
  interaction action is `search`; ordinary drop uses
  `Templates/ItemSystem/DroppedItem.hstf`.
- **Customize:** Set Loadout/Backpack `initialItems` for the requested kit; see
  [weapons](#weapons-and-deployables) for item/ammo examples. For ground loot,
  place a matching template under `Templates/GameContent/`, such as
  `LootPistol`, `LootRifle`, `LootSniper`, `LootShotgun`, `LootSword`,
  `LootGrenade`, `LootMolotov`, `LootAmmo` or `Chest`. `LootAmmo` contains 9mm
  by default; change its items for other ammo.
- **Implementation:** `scripts/ItemSystem/`,
  `scripts/GameContent/ItemCatalog.ts`,
  `Templates/GameContent/PlayerContainers.hstf`,
  `Templates/GameContent/DeathBag.hstf`,
  `scripts/ItemSystem/features/DropOnDeath.ts` and
  [ItemSystem](../scripts/ItemSystem/README.md).
- **Limits:** Definitions do not place items or enemies. Death bags are not
  preplaced pickups, a complete inventory UI or unconditional take-all actions.
  `medkit` has a `Usable` effect, but player input does not call
  `ItemCommands.useItem`; consumable use still needs authoring.

## Weapons and deployables

- **Provides:** Held-item GAS abilities, hitscan/melee/projectile/throw
  delivery, magazines/automatic reload, crosshair triggering, scope/shot feel,
  networked physics deployables and pacing of NPC hits on players.
- **Default:** The player is **unarmed**. `EquipmentBinder` equips the selected
  item and grants abilities: Use/native held-use fires, Reload applies to a
  magazine, and Drop/SwitchWeapon depend on carried items. Pistol/rifle/shotgun
  use `aimMode: 'auto'`: the first eligible ray hit arms automatic triggering,
  with a target-grace window. `CrosshairTrigger` falls back to tag `enemy`,
  blocks `state.dead`, reads Aim and drives recoil, bloom, scope steadying and
  the target-coloured spread ring. Sniper is scoped and manually fired; Aim
  toggles its eye-framed zoom. Sniper/shotgun reuse rifle visuals/clips.
  `AutoTargetWeaponController` is present with `autoTargetEnabled` and
  `autoAttackEnabled` false and `requiredTargetTag` empty.

  Grenade/molotov are available but neither carried nor placed. `Throw` uses
  grenade fuse/blast or molotov impact/blast plus pulsing `FireArea`;
  `Expendable` spends one stack item per shot. Hand aim clears the body and
  falls back to a muzzle offset. Release/ready animation events drive launch and
  hand-model visibility, with timed launch fallback.

  NPC hits on players are paced by shooting tickets, on by default: per
  player, two NPCs at a time may fire shots that can hit, each for a 0.5 s
  turn; turns start at least 0.25 s apart, and each is followed by a 1 s rest.
  The others fire near misses about 1 m beside the player (wider for a blast
  or a spread cone) that damage nothing. A turn goes to an NPC in the
  player's view first, then to whoever has waited longest. Player shots and
  melee swings are not paced.

  Presentation resources come from the bundles in the asset inventory.
  Gameplay and animation wiring do not supply their model, material, VFX or
  SFX bindings; configure those when using the resources.

- **Customize:** Set Loadout `initialItems` in
  `Templates/GameContent/PlayerContainers.hstf`, and ammo in Backpack: `pistol`
  with `ammo_9mm*60`, `rifle`/`sniper` with `ammo_556*90`, `shotgun` with
  `ammo_12g*24`, ammo-free `sword`, or expendable `grenade*3`/`molotov*3`.
  Choose the requested kit within three Loadout slots. To add a weapon, reuse
  catalog `defineItem` with `Weapon` and the appropriate `Hitscan`, `Melee`,
  `Projectile` or `Throw` delivery, plus `Magazine` for guns or `Expendable` for
  spent stacks; reuse/author its visual and animation remap page. To arm an NPC,
  override its `ItemSystem` loadout and acquisition tags. To tune NPC hit
  pacing or turn it off, place one `ShootingTicketSettingsComponent` in the
  world (a knob left at 0 keeps its default); to pace NPC hits on a
  non-player too (an escort, a dummy), add `ShootingTicketTargetComponent` to
  it.
- **Implementation:** `Templates/Weapons/`,
  `Templates/GameContent/LootGrenade.hstf`,
  `Templates/GameContent/LootMolotov.hstf`,
  `scripts/gas_abilities/deployables/`, `scripts/ItemSystem/features/Weapon.ts`,
  `scripts/ItemSystem/features/Magazine.ts`,
  `scripts/ItemSystem/features/WeaponFeel.ts`,
  `scripts/gas_abilities/weapons/targeting/CrosshairTrigger.ts`,
  `scripts/gas_abilities/weapons/targeting/AutoTargetWeaponController.ts`,
  `scripts/gas_abilities/weapons/targeting/ShootingTickets.ts` (with its
  settings and target components), [weapons](../Templates/Weapons/README.md) and
  [ItemSystem](../scripts/ItemSystem/README.md).
  - **Required assets:** For weapons in the [asset inventory](#asset-inventory),
    **you MUST download the listed asset or bundle first**, read its README, and
    use its included model, VFX and SFX. **Use these resources as-is unless the
    user explicitly requests a different appearance; an item name alone is not
    such a request.** **Do not search, generate or substitute resources the
    bundle already supplies without that explicit request.** Source only missing
    parts separately.
  - `Templates/Weapons/Grenade.hstf`, `GrenadeVisual.hstf` —
    [Grenade bundle](#asset-inventory).
  - `Templates/Weapons/Molotov.hstf`, `MolotovVisual.hstf`, `FireArea.hstf` —
    [Incendiary grenade bundle](#asset-inventory).
- **Limits:** Weapon visual templates are models, not a way to arm a character.
  Automatic crosshair triggering needs an armed player and eligible tagged
  targets; enabling the optional auto-target controller may introduce a
  competing aim driver. Servers receive no animation events, hence the throw
  fallback. Supplied NPC loadouts reject `weapon.thrown` (grenade/molotov).
  Shooting tickets are counted on the machine that fires the shots (the server
  for spawned NPCs).
  Presentation assets and bindings need rendering/runtime verification; no
  grenade or explosion is placed in the default scene. Example
  weapon/throwable art is not finished game art.

## Character and equipment animation

- **Provides:** Base-graph locomotion/jump driving, feature modules, equipment
  remapping and authored hand/back/head socket entities.
- **Default:** The player and `BaseActor` animators reference
  `Assets/AnimationGraphs/Main_Layer.animgraph` (locomotion only; jumps play on
  `Airborne_Layer`). `CharacterAnimationController`
  hosts airborne, actor-action, damage, death, dodge and equipment modules.
  Mounted layers are `Airborne_Layer`, `InteractionItem_Layer`,
  `Take_Damage_Layer` and `Death_Layer`. Equipment uses one shared item layer
  and pistol/rifle/sword/grenade remap pages, not separate weapon layers or the
  old equipment-profile registry. `BaseActor` additionally mounts Attack/Ranged;
  the default player does not.
- **Customize:** Reuse the shared equipment layer and registered page selected
  by the held item's `animKey`. `CharacterItemRemappers` supplies optional
  per-character pages, with controller add/remove-remapper operations. Load
  required item clips in the character animator as well. Available Dodge and
  Attack/Ranged modules need their required layers and gameplay/input wiring.
- **Implementation:** `Templates/PlayerCharacter.hstf`, `scripts/animation/`,
  `scripts/animation/modules/`, `Assets/AnimationGraphs/`,
  `Assets/AnimationProfiles/Equipment/`,
  `scripts/ItemSystem/equipment/EquipmentRemappers.ts`,
  `scripts/Character/Abilities/DodgeRollAbility.ts` and
  [actor sources](../Templates/Actors/actorTemplatesRegistry.md).
- **Limits:** Installed module code does not mount its layer. The default player
  has no `DodgeRollAbility`, `Dodge_Roll_Layer` or Dodge input. A remap page
  alone is not an animation-retargeting workflow. Pose quality on the chosen
  character still needs runtime verification.

## GAS health and death

- **Provides:** Health/max-health attributes, damage events, death state and
  survivable-hit stagger/cooldown effects consumed by state/animation wiring.
- **Default:** Player `CharacterGASComponent` is configured; `staggerOnHit` is
  off. `initialMaxHealth` is the spawn seed; `maxHealth`/`setMaxHealth` use the
  live ceiling. No encounter damages the player by default.
- **Customize:** Change the live ceiling through
  `CharacterGASComponent.setMaxHealth`. On NPCs,
  `StarterHealthAndDeathComponent` owns stagger opt-in based on `disableStagger`
  and logic availability; `disableStagger` wins over authored `staggerOnHit`.
  Hold/recovery tunables are on GAS, with zero falling back to 0.3/0.5 seconds.
  See [actors](#actors-and-spawning) for regeneration and movement/facing
  arbitration.
- **Implementation:** `scripts/gas/`,
  `scripts/Character/gas/CharacterGASComponent.ts`,
  [GAS](../scripts/gas/using-gas-system.md) and
  [actor health integration](../Assistant/skills/implementing-actor-behaviors/integrating-actor-health-system/integrating-actor-health-system.md).
- **Limits:** No automatic player respawn/revive flow is configured. Healing HP
  does not fully revive GAS death state, movement and animation. A stagger tag
  alone does not freeze the player's body.

## Actors and spawning

**Actor means NPC/Enemy** in this project; the Actor Framework is the NPC
system, not the player controller.

- **Provides:** Reusable actor simulation, animation, attacks, health/death,
  behavior starters and spawning. `ActorSpawner` plus interval/proximity
  triggers use shared `SpawnService` for the live set and cap. Shooter actors
  can remember accepted server gunshot/explosion reports without treating
  sound as visual line of sight.
- **Default:** Library/services are installed but no NPC is placed.
  `Templates/Actors/BaseActorTemplate/BaseActor.hstf` is a neutral authoring
  source, not a finished character type: it carries `fists` and health/death
  wiring, but no patrol/combat gameplay starter or `ActorSdkTagComponent`.
  `ActorGASHealthComponent` adds SDK health control, telemetry and owned
  regeneration effects. Shooter behavior paces regeneration through this
  adapter. `StaggerBehavior` interrupts attacks and arbitrates movement/facing
  and knockback; it does not write GAS state. The physical controller applies
  knockback. `StarterShooterCombatComponent` enables hearing by default:
  gunshots within 30 m, explosions within 60 m, or shots passing within 3 m
  of the first 100 m of the reported ray at range scale 1 and delivery
  loudness 1. Hearing uses horizontal distance, not wall occlusion or acoustic propagation.
- **Customize:** Duplicate `BaseActor` under `Templates/Actors/`, rename the
  root, add the requested starter (for example `StarterCombatComponent`), then
  place/spawn that type. Do not duplicate its existing health/death starter.
  Bake required components/settings into the spawned template. Give targets
  their required acquisition tags, including `enemy` for the player crosshair
  fallback; override the NPC `ItemSystem` loadout for its requested kit. Follow
  `implementing-actor-behaviors` then `spawning-npc-actors` for authoring.
  On a shooter starter, `disableHearing` (Ignore gunfire and blasts) turns
  hearing off; `hearingRangeScale` (Hearing range, default 1.0) changes hearing
  distances/radius but not the ray's 100 m reach. Both controls apply live.
- **Implementation:** `scripts/Actor/`, `scripts/Actor/Behaviors/`,
  `scripts/Actor/Perception/` (hearing, noise service and weapon-noise adapter),
  `scripts/Actor/Utilities/ActorGASHealthComponent.ts`,
  `Assistant/skills/implementing-actor-behaviors/`,
  [actor sources](../Templates/Actors/actorTemplatesRegistry.md) and
  [health integration](../Assistant/skills/implementing-actor-behaviors/integrating-actor-health-system/integrating-actor-health-system.md).
- **Limits:** A base template is not an authored encounter. Plain
  `CharacterGASComponent` does not provide the shooter regeneration route.
  Supplied actor loadouts reject grenade/molotov; stagger opt-in follows the
  [GAS health rules](#gas-health-and-death). Spawned behavior and multiplayer
  operation remain subject to runtime verification.

## Bot players

- **Provides:** Optional bot-player fill controller and services. The
  `BotBehaviorInstaller` accepts `follow`, `shooter-combat`, `wander` or a
  comma-separated combination; movement priority is shooter, then follow,
  then wander. A shooter needs an equipped gun; wander yields to other brains.
- **Default:** Services are placed; `StartingWorld` names the player template
  for bots. `WorldsBotFillController.enabled` is false.
- **Customize:** Configure the desired brain/headcount and check world player
  capacity, then enable the controller. Set `BotBehaviorInstaller.brainId`
  before the behavior starts; changing brains requires a restart.
- **Implementation:** `space.hstf` and `scripts/WorldsBotPlayer/`.
- **Limits:** Placed services do not mean bots are enabled or runtime-verified.

## Navigation

- **Provides:** Baked navmesh/profile/area-type assets and NPC-size/position-aware
  navigation lookup. `NpcSize.ts` reads the authored character controller size,
  otherwise the largest enabled upright non-trigger capsule with collider scale;
  `FindNavMesh.ts` selects an enabled mesh covering the NPC and baked for at
  least its radius and height, preferring the closest size match.
- **Default:** `space.hstf` references the baked assets. Authored half-extents
  are `(100, 10, 100)` at `y = 5`; the placeholder floor spans x/z ±100 m.
  There is no automatic startup rebake: NPCs use the NavMesh as last baked in
  the editor.
- **Customize:** Expand floor collision and navigation bounds when building
  beyond the floor. Provision a NavMesh for each NPC size (`remix nav provision
  --agent <npc>`, or `provision_nav_mesh`) and bake after any change to walls,
  floors, props or bounds (`remix nav bake`, or `bake_nav_mesh`), then verify
  navigation, including click-to-move routes. Use
  `NavMeshLookup.resolveFor(actor)` for NPCs or `resolveAny()` for callers
  without an actor, such as click-to-move and pre-spawn lookup. Use one lookup
  per NPC.
- **Implementation:** `space.hstf`, `NavMesh/`, `scripts/Navigation/` and
  [movement schemes](../scripts/Input/README.md#movement-schemes).
- **Limits:** A scene edited after its last bake keeps the old NavMesh until it
  is baked again. Crowd steering uses an existing `NavMeshAgentComponent` on
  an owned NPC in server context; no-agent and straight-line movement use the
  regular path. Installing the driver does not add agents or NPCs to a scene.
  A sole non-fitting mesh is used with a warning; with multiple
  meshes and no fit or unknown NPC size, lookup returns null. Older runtimes
  without NavMesh size/bounds getters fall back to the first mesh.

## Persistence

- **Provides:** `SavedPlayerNumber`, an example storing one number in a PVar.
- **Default:** Available but not placed. If saving is unavailable in preview, it
  uses a session default without writing.
- **Customize:** Add one scene entity per number, set `variableName`, and call
  its server mutation API after loading.
- **Implementation:** `scripts/Persistence/SavedPlayerNumber.ts`; follow its
  file-header instructions.
- **Limits:** An installed example is not an authored persistence feature;
  preview fallback does not certify persistent saves.

## NUX

- **Provides:** `NuxTutorial`, an example of a NUX (new user experience): a
  once-in-a-lifetime tutorial shown once per player, with the seen status
  saved as 1 in a PVar. Listener-only: it renders nothing itself.
- **Default:** Available but not placed. If saving is unavailable in preview,
  the tutorial shows for the session without writing.
- **Customize:** Add one scene entity per tutorial, set `variableName`, render
  the panel from its `addListener` callback, and call `dismiss()` from the
  panel's Dismiss control. If a tutorial is requested without saying whether
  it returns, ask the user whether it is a single occurrence or not: use
  `NuxTutorial` for a once-in-a-lifetime NUX, and build a simple tutorial
  panel without seen-state persistence otherwise.
- **Implementation:** `scripts/GameContent/NuxTutorial.ts`; follow its
  file-header instructions.
- **Limits:** An installed example is not an authored tutorial feature;
  preview fallback does not certify persistent saves.

## Asset building blocks

- **Provides:** SDK primitive templates (cone, cube, cylinder, disc, plane,
  prism, pyramid, sphere, torus, wedge) from the `meta/editor_kit_primitives`
  dependency's `menu/Shapes/`, plus installed reusable templates and presentation
  assets. Discover these through the editor's dependency asset listing; they
  are not project-local templates.
- **Default:** **EMPTY GAME TEMPLATE, not a completed game.** The floor, skybox
  and mannequin character are placeholders that must be replaced.
  `SurfaceObjects` is empty; no walls, buildings, props, NPCs, pickups,
  objective or game loop are authored in `space.hstf`. The floor is a 200×200 m
  collision plane.
- **Customize:** Reuse `Templates/` and `Assets/` for the requested content. For
  a complete-game/demo request, author the requested playable loop and replace
  the placeholder floor, skybox and mannequin character; unrelated incremental
  requests do not require redesigning art.
- **Implementation:** `space.hstf`, `Templates/` and `Assets/`.
  `Templates/Primitives/` contains only
  `bb_default.material` and its metadata, reused by existing objects. Grenade
  VFX wiring is documented under
  [weapons and deployables](#weapons-and-deployables).
- **Limits:** Installed assets are building blocks, not finished gameplay.
  Version headers identify each script's last synced revision, not gameplay
  certification. These scripts remain editable source.
