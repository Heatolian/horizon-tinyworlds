# ItemSystem

Server-authoritative pipeline from interaction to item to container to
equipment, for players and NPCs alike. The supplied player (`PlayerCharacter.hstf`)
is armed only through it, and so are the NPCs.

## Three concepts

1. **Item**: what something is (`ItemDefinition` + fragments) and one stack of it (`ItemStack`).
2. **Container**: where items are. The only storage class is `ItemContainer`, configured by three independent properties:
   - `role` (string): its name on the owner, e.g. `backpack`, `loadout`, `chest`. A lookup key with no behaviour.
   - `accessMode` (`Owner` / `Proximity` / `Trade`): who may reach in from another entity.
   - `equipMode` (`None` / `Selected` / `All`): whether its items take effect on the owning character.
3. **Equipment**: items in a container whose `equipMode` is not `None` take effect on the character (abilities granted, animation tag, model shown). `EquipmentBinder` does this automatically; gameplay code changes containers and selections, never equipment directly.

## Common tasks

### Giving the player a weapon

The supplied player starts empty-handed.

- **Start with a weapon** ("give the player a pistol", "start with a sword"): add the item id to the `Loadout` container's `initialItems` in `Templates/GameContent/PlayerContainers.hstf`, e.g. `pistol`, and its ammo to the `Backpack` container's, e.g. `ammo_9mm*60`. Entry *i* goes into slot *i*, up to `initialSlotCount` (loadout 3, backpack 20). `name*count` sets a stack size, capped at the item's `Stackable` max (`ammo_9mm` 60, `ammo_556` 90, `ammo_12g` 24, `medkit` 3, weapons 1): add another entry for more. Entries that do not fit only log a warning.
- **A weapon on the ground**: place an instance of `Templates/GameContent/LootPistol.hstf`, `LootRifle.hstf`, `LootSniper.hstf`, `LootShotgun.hstf`, `LootSword.hstf`, `LootGrenade.hstf` or `LootMolotov.hstf` (ammo: `LootAmmo.hstf`; change its container's `initialItems` for other items or counts).
- **A new weapon**: one `defineItem` in `scripts/GameContent/ItemCatalog.ts` (see Adding content), then use its id as above.
- Item ids in this world: `pistol`, `rifle`, `sniper`, `shotgun`, `sword`, `grenade`, `molotov`, `ammo_9mm`, `ammo_556`, `ammo_12g`, `medkit`; for NPCs also `fists`, `npc_test_fists`, `npc_test_pistol` and `fireball`.

The scene must carry the `ItemSystemServices` entity (`space.hstf` does).
`PlayerItemInput` drives the weapon in hand and shows the touch buttons on its
own: Use, Reload (for a weapon with a magazine), Drop (while something is in
hand) and `SwitchWeapon` (when the hand container holds another equippable item
to take); all but Drop also need `TouchControlsHud.weaponButtons`.

### Reading item state

Every machine can read item state; only `ItemCommands` change it.

| Question | Read |
|---|---|
| What is in the character's hand? | `findOnCharacter(character, EquipmentBinder)?.hand()` (role, index, item); the hand is the first `Selected` container, so give a character only one |
| The weapon in hand, its magazine | `equippedWeaponOf(character)` (owner only): `config`, and `magazine` (`rounds`, `size`; null for melee) |
| One of the character's containers | `containerRegistry.find(character, 'backpack')`; all of them: `containerRegistry.all(character)` |
| How many of something it carries | `container.countWithTag('ammo.9mm')`, `container.count(stack => stack.defId === 'medkit')` |
| What an item is | `itemRegistry.get(stack.defId)` (`displayName`, `hasTag`, `find(Weapon)`) |
| React to changes | `container.addSlotListener(listener)`; `containerRegistry.subscribe(listener)` for containers appearing |
| A loud weapon going off (server) | `addWeaponNoiseListener(listener)`: each loud round and detonation the server accepted, players' and NPCs' alike |

### Adding content

- New weapon of an existing kind: one `defineItem` in the game's catalog (`scripts/GameContent/ItemCatalog.ts`) with `WorldModel`, `Weapon({...numbers, delivery: new Hitscan({...}) | new Melee({...}) | new Projectile({...}) | new Throw({...})})` and, for a gun, `Magazine({size, ammoTag, reloadTimeSec, reloadButtonIcon})`, plus a pure visual template (mesh, optional `Muzzle` and `GameplayCuePresentation`; no scripts, physics or network). Give it a `weapon.*` tag (the loadout's `acceptTags` is `weapon`). How far NPCs hear it is the delivery's: a `Hitscan`'s `loudness` (1 by default, 0 for a suppressed gun) and a `Throw`'s `detonationLoudness` (1 by default); swings and projectiles are silent. A weapon in the hand names a `remapper`: a `.remapper` page pointing the shared `InteractionItem_Layer`'s `idleItem` / `useItem` / `reloadItem` at its clips (copy one under `Assets/AnimationProfiles/Equipment/`). The page is registered per `animKey`, so a variant reuses `pistol` / `rifle` / `sword` and its page, and one with different clips takes a new key. A weapon with nothing in hand instead uses a key of `ITEM_FIRE_ACTIONS` in `ActorActionAnimationModule.ts` and plays an actor action (`fists`, `fireball`); a `Magazine`'s `ammoTag` must be carried by an ammo item, or be omitted for infinite ammo. A thrown weapon (grenade, molotov) has a `Throw` delivery whose template carries `GASDeployable`, a DynamicCollider `PhysicsBody` and a `GameplayCuePresentation` binding `cue.deployable.detonate` (to its `Detonation` child's VFX; the thrower's GAS broadcasts that cue, so every machine shows the detonation), and sits beside `Expendable` and `Stackable`, so each throw spends one of the stack. Its `releaseEvent` names the animation event the throw leaves the hand on (`release` on `Throw_Fast`, authored on the MHS animation preview timeline), and `windupSec` is the latest it leaves if that never arrives. Its hand model hides on that event and shows again on `ready` (`visual.hideOnEvent` / `showOnEvent`, on every machine); throwing the last one removes the item, and with it the model. It leaves from that hand (`aimSource: 'hand'`): the socket's position at release, moved out to 0.5 m from the body if it is closer, so it clears the thrower's capsule.
- New kind of weapon (a beam, an arcing throw): a new `WeaponDelivery` in `features/WeaponDelivery.ts` (plus a fire ability if none fits). Nothing else changes.
- New consumable: `defineItem` with `Stackable` + `Usable({effect})`; the effect needs an `effectId`. No player input uses items yet: something must call `ItemCommands.useItem(character, slot('backpack', i))`.
- New slot type that takes effect (armour, trinkets): a container with `equipMode: All` (or `Selected`) and items with an `Equippable`. No code.
- New interaction: `registerItemRequestHandler('interact.<action>', fn)`, where `fn` returns an `ItemResult`, in a module the server loads (handlers register at module load), and an entity like `Templates/GameContent/LootPistol.hstf`: a server-owned networked root with `Interactable` (`action`) and an `InteractionSensor` child carrying the WSDK interaction target.
- New spendable/refillable stat (durability, battery): implement `statLimit(key)` on the fragment; call `ItemCommands.spendStat` / `ItemCommands.refillStat`.
- New request: a command in `ItemCommands` that sends an `ItemRequest` of a new `kind`, and `registerItemRequestHandler(kind, handler)` in the module that owns it. The handler returns an `ItemResult`: how much it did (say in the command's doc what `amount` counts) and, when that is short of the request, the `ItemRefusal` that explains why. Callers use only the command.
- New capability: a new `ItemFragment` subclass in the module that consumes it. Do not add fields to `ItemDefinition`.

## Vocabulary

One word, one meaning. New code follows the same table.

| Word | Means only | Examples |
|---|---|---|
| `Item*` | item data | `ItemDefinition`, `ItemStack`, `ItemFragment` |
| `Container`, `Slot` | storage | `ItemContainer`, `SlotRef`, `SlotOps` |
| `PlayerContainers` | all containers whose `ownerCharacter` is one character (`containerRegistry.all(character)`). A player's live on a server-owned *container entity* spawned per player, because the character itself is client-owned; an NPC's live on the NPC. Not "inventory", which games use for the backpack alone | `PlayerContainersSpawner`, `PlayerContainers.hstf` |
| `Equip*`, `Equipment*` | an item taking effect on a character | `EquipmentBinder`, `EquipmentLedger`, `Equippable`, `equipMode` |
| `ItemRequest*` | the wire format and channel under `ItemCommands`; callers never build requests | `ItemRequest`, `ItemRequestServer`, `sendItemRequest` |
| `*Handler(s)` | the server function that processes one request kind | everything in `container/RequestHandlers.ts` |
| `*Commands` | the one way UI, input, AI and features change items, or report what a weapon did; each call sends one request | `ItemCommands.dropItem`, `ItemCommands.interact`, `ItemCommands.reportShot` |
| `Action` | interaction only: what an `Interactable` does when used | `Interactable.action`, the `take` action |
| `Weapon*` | everything about weapons, from fragment to runtime | `Weapon`, `WeaponDelivery` (`Hitscan`, `Melee`, `Projectile`), `ItemWeapon`, `WeaponEquipment` |

## The one rule

**What is in effect on a character is a function of its containers, never of
how an item arrived.** Every acquisition path only writes a container;
`EquipmentBinder` converges equipment to "the selected slot of each `Selected`
container plus every slot of each `All` container".

```
pickup / starting kit / move / drop / NPC spawn
        │ write
        ▼
ItemContainer (server)  ──replicates──►  EquipmentBinder (one component per character)
                                             ├─ EquipmentLedger (owner only) ──► GAS abilities, `equipment.{animKey}` tag, per-frame ticks
                                             └─ EquipmentVisuals (every machine) ──► local models
```

Invariants:
- Only `EquipmentLedger` grants equipment abilities, and only `EquipmentBinder` drives it.
- Only the server mutates networked containers (`ItemContainer` refuses otherwise).
- A container's slots exist in three forms: `networkedSlots` (the replicated
  source of truth, written only by the server), `localSlots` (the decoded copy
  every machine reads and diffs against), and a `SlotDraft` that exists only
  while one change runs: `SlotOps` edit the draft, then it is committed to both.
- Clients never change item state. The item system has exactly one network
  entry point, `ItemRequestServer.RpcRequest` on the player's container entity:
  requests are handled in send order, must carry the owner's private token, and
  are re-validated by the handler registered for their `kind`. World objects
  (loot, chests, shops) have no RPC at all.
- Every change goes through an `ItemCommands` call. On a client it becomes a request; on the server (NPCs) the same call runs the handler directly.
- Every call resolves with an `ItemResult`: how much the server did (`amount`; each command says what it counts) and, short of the request, why (`refusal`, an `ItemRefusal`: `missing`, `invalid`, `notAllowed`, `outOfReach`, `rejected`, `noRoom`, `unhandled`, or `lost` when a client's request can no longer be answered). On the server it resolves on the same frame, the request having run before the call returned; on a client, when the answer arrives. It never rejects. An NPC reads it to decide (give up on loot it is `rejected` from, walk closer when `outOfReach`); a UI can tell the player the backpack is full. It is a receipt, not state: read the containers for what the character holds. Callers that do not need it write `void dropItem(...)`.

## Containers by configuration

| Use | `role` | `accessMode` | `equipMode` | `autoPlacePriority` | `removeWhenEmpty` | Lives on |
|---|---|---|---|---|---|---|
| Backpack | `backpack` | Owner | None | 1 | no | player container entity / NPC |
| Hotbar (gun in hand) | `loadout` (`acceptTags: weapon`) | Owner | Selected | 2 | no | player container entity / NPC |
| Armour (future) | `armor` (`acceptTags: armor`) | Owner | All | 2 | no | player container entity / NPC |
| Ground loot, dropped item | `loot` | Proximity | None | – | yes | `Templates/GameContent/LootPistol.hstf`, `Templates/ItemSystem/DroppedItem.hstf` |
| Chest | `chest` | Proximity | None | – | no | `Chest.hstf` |
| Shop (planned) | `shop` | Trade | None | – | no | merchant NPC; moved only by `buy` / `sell` request handlers in a trade module |

`autoPlacePriority` routes items that arrive without a chosen slot (pickups):
the character's containers are tried from the highest priority down, and each
one's `acceptTags` and `rejectTags` still filter. With the values above, guns land in the
hotbar and everything else in the backpack; make the backpack higher to send
pickups there first. 0 means a container never receives them.

`removeWhenEmpty` removes the container's entity once its last item is taken.
Script can destroy only entities spawned at runtime, so a dropped item or a
death bag is destroyed, while loot placed in the scene is disabled instead
(`enabledSelf = false`, which replicates). A spawner outside ItemSystem marks
its loot with `ItemContainer.spawnedAtRuntime` to have it destroyed.

Roles must be unique per character. `accessMode` is enforced by the server for
anything reaching in from another entity (`external.*` requests and the `take`
interaction).

## Modules

Dependencies point one way. A fragment class lives in the module that reads it.
Every `@component` has its own file (templates reference components by file);
other code is grouped by concern. `(c)` marks a component.

| File | Contains |
|---|---|
| `items/ItemDefinition.ts` | `ItemFragment`, `StatLimit`, `ItemDefinition`, `Stackable`, `ItemRegistry` / `itemRegistry` / `defineItem` |
| `items/ItemStack.ts` | `ItemStack`, `ItemStat`, `ItemStatsBuilder`, stack helpers |
| `items/ItemFragments.ts` | `InitialStats`, `WorldModel` |
| `container/ItemContainer.ts` (c) | `ItemContainer`, `ContainerAccessMode`, `ContainerEquipMode`, `accessAllowed`, `ContainerRegistry` / `containerRegistry` |
| `container/SlotOps.ts` | pure slot logic (place, add, remove, transfer, swap) |
| `container/ItemRequest.ts` | `SlotRef`, `ItemRequest` (the wire format), `ItemResult` / `ItemRefusal` (what a request did, and why not all of it), `ItemRequestContext`, handler registry (`registerItemRequestHandler`, `findItemRequestHandler`) |
| `container/ItemRequestServer.ts` (c) | `ItemRequestServer` (the one network entry point, token check; answers each accepted request to the owner's client), `sendItemRequest` |
| `container/ItemRequestClient.ts` (c) | the player's end: receives the private token, numbers each request and resolves it with the server's answer; queues requests until the token arrives, resends what went out under a stale token, resolves whatever still waits `lost` when it goes away |
| `container/RequestHandlers.ts` | `runItemRequest` (resolves the handler's `ItemResult`, never rejects), built-in handlers `move`, `swap`, `drop`, `stat.spend`, `stat.refill`, `external.take`, `external.takeAny`, `external.put`, `interact.take` |
| `container/CharacterLookup.ts` | `characterOf` (nearest entity with GAS, from the given entity up), `findOnCharacter` / `allOnCharacter` (root and descendants): lets item components sit on the character root or a child |
| `container/ItemCommands.ts` | the public call surface: one command per request kind (`moveItem`, `dropItem`, `takeFrom`, `interact`, `spendStat`, ...), each resolving with an `ItemResult`; `addBeforeItemsLeaveListener` for state that must reach the server before an item leaves |
| `container/LootVisual.ts` (c) | world model of the first item in a loot container |
| `container/LocalModel.ts` | local model spawn helper (also used by `EquipmentVisuals`) |
| `equipment/EquipmentDefinition.ts` | `EquipmentDefinition` (`onEquip` may register `everyFrame` updates), `AbilitySetEquipment` |
| `equipment/EquipmentLedger.ts` | `EquipmentLedger` (pure): what is equipped and what each equip granted |
| `equipment/EquipmentVisuals.ts` | `EquipmentVisuals` (local models, cue relay), `findSocket` |
| `equipment/EquipmentController.ts` | `Equippable` fragment, `EquipmentController` (pure) |
| `equipment/EquipmentBinder.ts` (c) | `EquipmentBinder`: the character's one equipment component, owning the three above; `hand()` is what the character holds (the first `Selected` container), `select` / `selectNext` change it; relays the character's animation events to what it has equipped |
| `equipment/CharacterAnimationEvents.ts` | the relay: a leaf the binder dispatches animation events through and equipment listens on (clients only; the server receives none) |
| `interaction/Interactable.ts` (c) | `Interactable` (data: `action` + `maxDistance`), the `interact` request handler, and `registerLocalInteraction` for actions handled on the client (e.g. `search` opens a window) |
| `player/PlayerContainersSpawner.ts` (c) | spawns each player's container entity |
| `player/ContainerAssignments.ts` | pure player → container entity bookkeeping |
| `features/Expendable.ts` | `Expendable` fragment: each shot spends one of the stack (the server's `expend` request) |
| `features/Weapon.ts` | `Weapon` fragment (what every weapon has: numbers, aim, hand model, a delivery; makes the item equippable), `ItemWeapon` (the equipped weapon on its owner: grants the delivery's abilities via `setupWeapon`, auto fire every frame, its `magazine` if any), `WeaponEquipment` / `weaponEquipment`, `equippedWeaponOf`, the `weapon.shot` / `weapon.detonation` handlers and `addWeaponNoiseListener` |
| `features/Magazine.ts` | `Magazine` fragment (guns only: size, `ammoTag`, reload; declares `MAGAZINE_STAT` via `statLimit`), `MagazineRuntime` (rounds spent locally, reserve mirrored from the containers, reload, auto reload, server sync), the re-equip memory |
| `features/WeaponDelivery.ts` | `WeaponDelivery` (which fire ability + its per-shot config) and `Hitscan`, `Melee`, `Projectile` |
| `features/Usable.ts` | `Usable` fragment and the `use` handler |
| `features/DropOnDeath.ts` (c) | server: when the owning character gets the death tag, moves every item of these containers into a spawned bag (`bag` replicates the spawned entity) |

`features/` holds optional capabilities a game picks from; the rest is the core.

Import rules: `items/` imports nothing else in ItemSystem; `container/` never
imports equipment or features; in `equipment/` only `EquipmentController` and
`EquipmentBinder` see items or containers; the core never imports `features/`.
Nothing in ItemSystem imports game content.

### Game content (outside the framework)

Each game keeps its own content and depends on ItemSystem, never the reverse.
This world's lives in `scripts/GameContent/` and `Templates/GameContent/`:

| File | Contains |
|---|---|
| `scripts/GameContent/ItemCatalog.ts` | every item this game registers (pistol, rifle, sword, 9mm and 5.56 ammo, medkit; for NPCs fists, NPC test fists and pistol, fireball) |
| `scripts/GameContent/ItemCatalogLoader.ts` (c) | loads `ItemCatalog` on every machine |
| `scripts/GameContent/PlayerItemInput.ts` (c) | all of the local player's item input (Use, Reload, Drop, SwitchWeapon) and the touch buttons for them |
| `Templates/GameContent/PlayerContainers.hstf` | this game's player containers (loadout + backpack) with an empty starting kit; its root carries `DropOnDeath` |
| `Templates/GameContent/DeathBag.hstf` | the searchable bag a death drops: Proximity access, `removeWhenEmpty`, `Interactable` action `search` |
| `Templates/GameContent/LootPistol.hstf`, `LootRifle.hstf`, `LootSniper.hstf`, `LootShotgun.hstf`, `LootSword.hstf`, `LootGrenade.hstf`, `LootMolotov.hstf`, `LootAmmo.hstf`, `Chest.hstf` | placed loot and chest. Loot templates carry an `EditorPreview` child so they are visible while placing; `LootVisual` turns it off at runtime and shows the container's first item instead |
| `Templates/GameContent/AmmoBoxModel.hstf`, `MedkitModel.hstf` | placeholder ground models |


## Flows

| Flow | Who | Steps |
|---|---|---|
| Starting kit (player) | server | `PlayerContainersSpawner` spawns its `containersTemplate` (`GameContent/PlayerContainers.hstf`), containers seed `initialItems`, `ownerCharacter` = player → binder auto-selects the new gun in the `Selected` container and equips |
| Starting kit (NPC) | server | `ItemContainer` with `ownedByCharacter` and `equipMode` on the NPC; its binder runs on the server |
| Pickup | client → server | WSDK interaction → `interact` request → `Interactable` checks action and range → `interact.take` fills the character's containers in `autoPlacePriority` order |
| Switch / holster | owner | `EquipmentBinder.select(role, index)`; -1 holsters. `PlayerItemInput`'s `SwitchWeapon` calls `EquipmentBinder.selectNext(role)` on the hand container |
| Fire / reload | owner | input → `ItemWeapon` → the delivery's existing GAS fire ability (hitscan, melee, projectile, throw) and reload; magazine spent locally, an `Expendable` stack spent on the server |
| Loud round / detonation | owner → server | a round of a loud delivery → `reportShot` (its path) → `weapon.shot`: the loud weapon in the character's hand, a path starting at the character, holder samples reported rounds at 0.2 s intervals within an equip; the server uses a per-character two-slot budget that refills one slot per 0.2 s, allowing a burst of two → heard where the server has the character. A thrown one going off → `reportDetonation` (the deployable, in `other`) → `weapon.detonation`: a live `GASDeployable`, once each → heard where the server has it. Both → `addWeaponNoiseListener` (NPC hearing). An NPC's weapon makes the same calls, run on the server |
| Stat sync (magazine) | owner → server | `stat.spend`: a reported value can only go down. `stat.refill`: removes real items with the declared `refillTag` and adds what was removed. Only stats some fragment declares via `statLimit` are accepted |
| Drop | client → server | `ItemCommands.dropItem` → `drop` request → `Templates/ItemSystem/DroppedItem.hstf` loot with `LootVisual` |
| Use (medkit) | client → server | `ItemCommands.useItem` → `use` request → consume, `applyEffectToSelf` on the owner |
| Chest / other entity's container | client → server | `ItemCommands.takeFrom` / `putInto` → `external.take` / `external.put` → the other container's `accessMode` decides |
| Death | server | `DropOnDeath` sees the death tag → spawns `DeathBag.hstf` where the character died → moves every item into it. Nothing is re-issued: there is no respawn yet |
| Search a bag | client → server | interact with a `search` target → the game's window, registered with `registerLocalInteraction('search', ...)`, opens (no request) → each tap is `ItemCommands.takeFromAny` → `external.takeAny` → the slot goes to the searcher's containers by `autoPlacePriority`; the emptied bag is removed. Without a registered window (the production scenes have none; the test UI registers one) the interaction goes to the server as `interact.search`, which takes everything like `take` |

## Studio setup

- Scene: one server entity with `PlayerContainersSpawner` and `ItemCatalogLoader` (`ItemSystemServices` in `space.hstf`).
- Player character: `EquipmentBinder`, `PlayerItemInput`, `ItemRequestClient`, on the root (beside `GASComponent`) or grouped on a networkable child such as `ItemSystem` (`PlayerCharacter.hstf` does this). One of each per character. `PlayerContainersSpawner` warns at spawn when a framework one is missing.
- Player containers: set `PlayerContainersSpawner.containersTemplate` to `Templates/GameContent/PlayerContainers.hstf` (required; it already carries `ItemRequestServer`). Copy it to change the containers or the starting kit.
- NPC: `BaseActor.hstf` carries an `ItemSystem` child with `EquipmentBinder` and one `ItemContainer` (`equipMode=Selected`, `ownedByCharacter=true`, `initialItems` `fists`, `rejectTags` `weapon.thrown`: NPCs do not throw yet, since the server gets no animation events to release a throw on). An armed NPC overrides that container's `initialItems`, e.g. `rifle`, `ammo_556*90` (the container also holds the gun's ammo; `acceptTags` stays empty); the binder selects the first equippable item. No request components: NPC code calls `ItemCommands` on the server, which runs the handler directly. `ActorAnimatedAttackComponent` fires whatever is equipped.
- Loot: `Templates/GameContent/LootPistol.hstf`, or any copy with different `initialItems`.
- Chest: `Templates/GameContent/Chest.hstf` (Interact takes everything that fits; a UI can call `takeFrom` / `putInto` per slot).

## Gotchas

- One `ItemContainer` per entity. Two components of the same class on one entity share one data block at runtime (a loadout and a backpack on one entity both came up as "backpack"), so `PlayerContainers.hstf` puts each container on its own child entity; `containersIn(root)` finds them. An NPC keeps its single container on its `ItemSystem` child; `ownedByCharacter` resolves the owner to the NPC root.
- The asset pipeline compiles scripts with stricter SDK typings than the package `tsc`: a generic helper over components needs `T extends Component` (local `tsc` passes without it, the package build does not). Run the TS tests, not just `tsc`.
- The asset pipeline treats `import type` as a dependency: type-only import cycles fail the build.
- `@rpc` parameter types must be value imports: the SDK constructs them at runtime for the generated args class (`import type` -> `ReferenceError` when the module loads).
- `console.error` fails a TS unit test; use `console.warn` for recoverable conditions.
- Player-container and loot templates set `NetworkSettings.isAttainable = false` so clients cannot take ownership and write slots.
- Templates referenced with `new TemplateAsset('@...')` must exist or the package build fails.
- In `.hstf` files a numeric enum property is written as its member name (`"accessMode": "Proximity"`), not its number. The package build loads every template, so a wrong encoding fails the test run with `ComponentLoadFailed`.

## Known gaps

- Items are registered by `ItemCatalogLoader`. If its module loads after a container's `onStart`, that container skips its `initialItems` (it warns). Not yet checked in Studio.
- Container contents replicate to every client, including other players' backpacks.
- RPCs carry no caller identity, so requests are authorised by a per-player token the server sends only to the owner (via an RPC on their own character). The token is `Math.random`-based, not cryptographic. Any client can overwrite another player's received token with garbage (RPCs to a player-owned component are open); that only costs the victim the next request, after which the server re-sends the real token.
- Character position and health are client-authoritative, so a client can also fake its own death (and drop its bag).
- Noise is heard where the server has the character or the deployable, never where a client says. A client reports a round only for the weapon in its hand (the owner's replicated selection; a round fired just as the selection changes can be refused). A detonation names a deployable the server can see, heard once; the server cannot tell who threw it (entity ownership is not exposed to scripts), so a client could claim another's.
- If the server moves a gun out of the holder's containers before its magazine report arrives (anything other than the holder's own drop or put, which report first through `addBeforeItemsLeaveListener`), the stored count is not lowered.
- Two copies of the same gun cannot be in effect at once on one character (ids are keyed per definition).
- Containers replicate as whole arrays; split very large containers.
