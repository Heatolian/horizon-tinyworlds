---
name: spawning-npc-actors
description: Puts an actor into the scene by reusing a matching template from the registry, or creates a new NPC type by duplicating BaseActor, then places it, mark it networkable, and seat it on a surface. This is the spawn/placement step, not the behavior-authoring step.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
local_tools:
  - read_local_file
  - write_local_file
consider_skills:
  - adding-navigation
---

# Spawning an NPC

Spawns an actor into the scene. Two paths: a matching template already exists (reuse it from the registry), or you need a new type (duplicate `BaseActor` into a new template, then spawn it).

> **A new NPC/enemy type is a duplicate of `BaseActor` plus a behavior starter** (see **Create a new NPC/enemy type** below). `BaseActor` already carries the Actor Framework, movement controllers and character simulation stack; you add only the behavior. Do NOT write a custom movement/AI/spawner script. This skill then owns placing the new template and ensuring a NavMesh (below).

> **This skill places ONE instance. For a repeating wave, add a spawner entity.** If the request is "every N seconds", "keep spawning", "a wave/horde", or "spawn when the player approaches/leaves", placing instances from here is the wrong shape. Put `ActorSpawner` (`spawnTemplate` = the actor template, `maxAlive`, `spawnRadius`) plus `ActorIntervalTrigger` (`intervalSeconds`, cadence) or `ActorProximityTrigger` (distance-gated) on one scene entity at the spawn point; the template must carry its own `ActorSdkTagComponent`, since a spawned instance gets no scene delta. Do NOT write a custom spawner/timer component: on a plain scene entity every context owns its own copy, so a bespoke spawner subscribed with `ExecuteOn.Owner` runs on the server AND each client and a cap of 10 yields 20 live NPCs. `ActorSpawner` goes through `SpawnService`, which gates on `NetworkingService.get().isServerContext()` and holds one global per-group live budget.

> **IMPORTANT**: The `working-with-actor-templates` skill **MUST** also be active when this skill runs. It defines the component requirements and registry rules for all actor templates.

## Trigger Conditions

Activate when the user's message matches:
- "Spawn a NPC" / "Spawn an NPC"
- "Spawn an enemy"
- "Spawn an actor"
- "Add an NPC to the scene"
- "Create a character" (when referring to an NPC, not the player)
- Any variation involving spawning NPCs, enemies, or actors

**Do NOT activate** when the user is working on:
- The player character or player template
- Player movement, player input, player controls
- Anything prefixed with "player" (e.g., "player character", "player controller")

This skill is exclusively for non-player characters. Player templates use different components (`BasePlayerComponent`, `KinematicCharacterComponent`, etc.) and must NOT have `ActorSdkLogicComponent`.

## Prerequisite: Archetype animations for custom-mesh NPCs

If the request creates an NPC with a **custom-generated mesh** (not the BaseActor default mesh as-is) -- e.g. "create a barbarian warrior NPC", "spawn an orc enemy" -- the mesh swap and retarget are owned by `generating-character-mesh` -> the deterministic `workflow_image_character_swap` workflow, not this skill. Defer to it rather than retargeting here: create the type first by duplicating `BaseActor` (below) -- that already carries the Actor Framework stack -- then hand the new template to the workflow as the target and leave `mode` at its default of 1. Do NOT pass `mode: 0` with a `destination_template_path` on this path; there is nothing left to clone, and re-cloning produces a second template without the framework wiring. Pair it with `retrieving-character-archetype-animations` for archetype locomotion when that feature is enabled; it falls back to engine-default animations when it is not.

## Step 1: Pick a template (existing) or create one

Look for the registry file at `Templates/Actors/actorTemplatesRegistry.md`.

- **A suitable template already exists** → go to **Spawning From Registry**.
- **No suitable template (or no registry)** → go to **Create a new NPC/enemy type** (duplicate `BaseActor`), then spawn the new template.

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` is an internal authoring
source, not a suitable existing character type. For a zombie, guard, monster or
other requested type, create that type by duplicating `BaseActor` and place the
new template. Never place `BaseActor.hstf` itself.

---

## Placing the spawned actor on the ground (shared sub-workflow)

Both spawn paths below place the actor on the surface. **Do not hard-code `Y = 0`** — that only works when the project's floor is at world origin. Elevated, sunken, or non-uniform terrain breaks naive Y=0 placement (NPC ends up buried or floating).

**Do not roll your own raycast + transform write.** Surface-aware placement is owned by the `placing-objects-on-surfaces` skill, which does a collider-filtered raycast and applies the template's AABB-bottom offset automatically — handling the feet-vs-center pivot difference for you. Use it in two phases:

1. **Add the actor template to the scene** as the named wrapper entity the Actor Framework expects, and make the wrapper Networkable. Do not estimate its Y position here.
2. **Snap the wrapper to the surface** using the `placing-objects-on-surfaces` workflow. Snapping is identity-preserving, so it keeps the same entity ID, parent, components, and Networkable state. For a specific location such as "in front of the player" or "left of B", provide the target XZ and let that workflow derive Y from the surface raycast.

**When to skip surface snapping:**

- The user explicitly asks for an aerial / floating / underwater / "in the air" spawn.
- The actor is being attached as a child of an existing entity (a socket, vehicle, mount) — in that case its position is parent-local and surface snapping does not apply.
- The agent is operating in a template editor with no scene loaded — there is no surface to snap to; place the actor and let the world author position it.

---

## Spawning From Registry

1. **Read the registry** at `Templates/Actors/actorTemplatesRegistry.md`
2. **Choose the template:**
   - If the user requested a specific type, find the best match in the registry
   - If the user requested a generic NPC/actor/enemy, use the template marked **DEFAULT**
3. **Spawn the template** into the scene:
   - **Place it on the surface via the "Placing the spawned actor on the ground" sub-workflow above** —
     add the template wrapper, then snap it with the `placing-objects-on-surfaces`
     skill. Do not hard-code `Y = 0`.
   - The wrapper must be Networkable.
4. **Verify actor compatibility** (per `working-with-actor-templates` rules):
   - `TransformPlatformComponent` on root (entity cannot exist in the world without it)
   - `ActorSdkLogicComponent` on root
   - Movement controller on root
   - Spawned entity is set to Networkable
   - If animated: `CharacterAnimationController` on root with `animatorEntity` set to the child entity holding the `AnimatorComponent` and non-zero numeric property values (`speedMultiplier`, `maxSpeedClamp`, `smoothingFrameCount`, `minSpeedThreshold`) — a `BaseActor` duplicate keeps these; see `working-with-actor-templates`
   - If the NPC should move: the template is a simulated character (root `CharacterStateMachine` + `CharacterUpdateManager`, plus the `KinematicCharacter` sub-entity) — this drives locomotion and a kinematic body; it is NOT what makes the animator tick (see the callout below)
   - If the NPC should move with gravity: `ActorTransformMoveComponent` on root with `kinematicCharacterEntity` set to the `KinematicCharacter` sub-entity

---

## Create a new NPC/enemy type

When no existing template matches, create the new type by duplicating `BaseActor`:

1. Duplicate `Templates/Actors/BaseActorTemplate/BaseActor.hstf` to
   `Templates/Actors/<Name>/<Name>.hstf`. Keep the whole file: it already carries
   `ActorSdkLogicComponent`, `ActorTransformMoveComponent`,
   `CharacterAnimationController`, the character simulation stack and the
   capability controllers (see `working-with-actor-templates`).
2. Rename the new template's root entity from `BaseActor` to `<Name>`.
3. Add the behavior to the new template's root as a starter component. Reuse a
   shipped `scripts/Actor/Behaviors/Starters/Starter*Component` when one matches;
   for a combination or a timed cycle, write one `BehaviorStarterComponent`
   subclass that composes the shipped behaviors (`sequencing-actor-behaviors`).
4. If anything must target the actor, or it is spawned at runtime, bake an
   `ActorSdkTagComponent` into the template.
5. Append a row for the new template to `Templates/Actors/actorTemplatesRegistry.md`.

Then place `<Name>.hstf` — never `BaseActor.hstf` itself. Place it via the placement sub-workflow above, and ensure a NavMesh (below).

> **Tag targeting is not automatic.** If a behavior chases/attacks a specific
> target (a castle, a flag — anything that is not the player), set the starter's
> target tags AND add `ActorSdkTagComponent` (from `meta/worlds`) with the
> matching `tags: [...]` string to that target entity, or the actor acquires
> nothing and never moves toward it. Players are the only exception — they are
> auto-tagged `"player"`. See "The Tag Targeting Contract" in the parent
> implementing-actor-behaviors skill.

> **Registry append.** Adding the row is a read-modify-write: read
> `Templates/Actors/actorTemplatesRegistry.md`, append a row for the new template
> (match the table format; don't mark `DEFAULT` unless it replaces the current
> default), and write the merged text back. Writing a bare row without reading
> first destroys every existing entry, making prior types invisible to
> **Spawning From Registry**.

**Do NOT write a custom movement / AI / spawner component.** Compose the shipped
behaviors through starters; the component contract every actor template must
satisfy lives in the `working-with-actor-templates` skill.

> **Why the simulation stack matters.** `HzAnimSystem` evaluates an `AnimatorComponent` every frame for ANY entity that has one and is active + enabled-in-hierarchy — it does **not** require the entity to be a "simulated character" (verified in `HzAnimSystem.cpp`: the per-frame job loop filters only on the animation driver being present and enabled). So the stack is not what makes the animator tick; what it provides is **locomotion and a kinematic body**, and it ensures the NPC spawns active/enabled (mirroring `PlayerCharacter.hstf`). A "frozen" animator is almost always a clip that isn't retargeted to the rig (look for `Animation loading skipped … not compatible with skeleton …`) or an entity that isn't enabled-in-hierarchy — not a missing character stack. **Preserve the stack when duplicating; never add a second PhysicsBody/collider on the root** (a duplicate root body ejects the character so it spawns invisible or displaced). See `working-with-actor-templates` and `triggering-npc-animations` (Prerequisite #3).

---

## Positioning Rules

- Default: position in front of the user/camera
- Place the actor **on the existing terrain surface, not at world Y = 0**. Delegate surface
  placement to the `placing-objects-on-surfaces` skill (it raycasts the surface and applies
  the AABB-bottom offset); never assume the floor is at world origin
- If the user specifies a position, use that instead

## Ensure a NavMesh (required — do this whenever an NPC is spawned)

Every spawned NPC will eventually move, and movement behaviors pathfind against a baked
NavMesh. **Whenever you spawn an NPC, ensure a baked NavMesh exists in the scene:**

1. Activate the **`adding-navigation`** skill.
2. Follow its Setup: it sizes the NavMesh profile to the NPC capsule, sizes the NavMesh to the world bounds, reuses or creates the profile and area-type assets and attaches them, then bakes (reusing a matching NavMesh entity if one already exists).

Without a baked NavMesh, the NPC silently falls back to straight-line movement and walks
through walls. `GotoBehavior` (used by every movement behavior) auto-discovers the baked
NavMesh, so no per-actor wiring is needed. Skip this only for an actor that will never move,
or when the user explicitly opts out of pathfinding.

## After Spawning

- Verify the spawned entity has `TransformPlatformComponent` on root (required for the entity to have a position in the world)
- Verify the spawned entity has `ActorSdkLogicComponent` on root
- Verify the spawned entity is set to Networkable
- Verify a baked NavMesh exists in the scene (via the `adding-navigation` skill) so the NPC can move and avoid obstacles
- If the template has animations, verify `CharacterAnimationController` is present on root with `animatorEntity` pointing at the child holding the `AnimatorComponent` and that its numeric template properties are non-zero (`speedMultiplier`, `maxSpeedClamp`, `smoothingFrameCount`, `minSpeedThreshold`)
- If the NPC should move, verify it is a simulated character (root `CharacterStateMachine` + `CharacterUpdateManager` with `characterSimulatedEntity` set, and a `KinematicCharacter` sub-entity with the simulation controllers + Kinematic `PhysicsBody` + capsule) — this drives locomotion and the kinematic body. Confirm the NPC plays its idle on its own before wiring any one-shot triggers; if it stands frozen, the usual cause is a clip not retargeted to its skeleton or an entity not enabled-in-hierarchy (see `working-with-actor-templates`), not a missing character stack.
- If a new template was created, verify `Templates/Actors/actorTemplatesRegistry.md` is up to date
