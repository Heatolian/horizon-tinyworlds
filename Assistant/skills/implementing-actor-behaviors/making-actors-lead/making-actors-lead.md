---
name: making-actors-lead
description: Makes an NPC guide the player to a destination with LeadBehavior, walking ahead while watching the player's distance and waiting for them to catch up when they fall behind.
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
---

# Making an NPC Lead the Player to a Destination

Sets up an actor to lead the player to a destination using `LeadBehavior`. The NPC walks toward a target point while monitoring the player's distance — if the player falls too far behind, the NPC stops, turns to face the player, and waits until they catch up.

Two destination modes are supported:

| Mode | When to use | How destination is set |
|------|-------------|----------------------|
| **Entity/Position** (default) | Destination exists at edit-time | Link entity or set Vec3 directly |
| **Tag-based** | Destination is spawned at runtime or identified by tag | Set `destinationTag` to find closest tagged entity |

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC lead me to the castle"
- "Have the NPC guide the player to a location"
- "Make this goblin lead me to the sword of destiny"
- "Walk the player to a destination"
- Any variation involving an NPC leading, guiding, or escorting

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor is duplicated
from — **already carries `ActorSdkLogicComponent` and `ActorTransformMoveComponent`**. So:

| The actor needs | Do |
|-----------------|-----|
| Lead the player to an entity that exists at edit-time | Add `StarterLeadComponent`, set `destination`. No code. |
| Lead to something spawned at runtime, or named by tag | Same component; set `destinationTag` instead. It takes precedence over `destination`. |
| A movement controller | **Nothing.** Already on `BaseActor`. |

One shipped starter covers **both** destination modes — there is no reason to write a script for
either. 🚨 `BaseActor` carries no `ActorSdkTagComponent`, so tagging the *destination* is still
your job in the tag mode.

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorTransformMoveComponent` on the actor root (already there on a `BaseActor` duplicate)
- A baked **NavMesh** exists in the scene so the NPC leads around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Setup

Add `StarterLeadComponent` to the actor root and set **either** `destination` (an Entity —
the starter resolves the transform for you) **or** `destinationTag`. With neither, it registers
nothing and warns.

A template instance zero-inits any property its delta does not name. The starter is safe with
that: an unset `leadSpeed`, `arrivalThreshold`, `maxPlayerDistance` or `resumePlayerDistance`
falls back to its default, and `measureHeight: false` measures player distance on the ground plane,
which keeps a lead from stalling on a ramp. `followClosestPlayer` is the one boolean whose `false`
changes the path: it leads `targetPlayer`, or the closest player (with a warning) while
`targetPlayer` is null, so set it explicitly.

Read the current property list and defaults off
`scripts/Actor/Behaviors/Starters/StarterLeadComponent.ts` — do not trust a copied table.

## Advanced: composing the behavior in code

Only needed when the lead has to be built at runtime or sequenced with other behaviors —
`startBehavior()` returns the behavior, and `LeadBehavior` finishes on arrival, so it chains
cleanly.

Note the type difference across the seam: the **starter** takes `destination` as an `Entity`, the
**behavior** takes it as a `Vec3`. Resolve it through `TransformComponent.worldPosition` when
constructing the behavior yourself.

```typescript
const lead = new LeadBehavior();
lead.name = 'LeadToDestination';
lead.destination = destTransform.worldPosition;  // Vec3, not Entity
lead.destinationTag = '';                        // or a tag, which wins over destination
lead.leadSpeed = 2.0;
lead.maxPlayerDistance = 8.0;
lead.resumePlayerDistance = 4.0;
lead.followClosestPlayer = true;
lead.arrivalThreshold = 1.0;
lead.basePriority = StarterPriority.Task;  // 45, the starter's default Priority

actorLogic.addBehavior(lead);
```

## Parameters

Source: `scripts/Actor/Behaviors/Starters/StarterLeadComponent.ts` (starter) and
`scripts/Actor/Behaviors/BaseBehaviors/LeadBehavior.ts` (behavior). Read the current names, defaults and
per-property zero-init warnings there rather than from a copy here.

Lead claims Movement at its `basePriority` (the starter's Priority, `basePriority`, defaults to `StarterPriority.Task`, 45), and Look at the same priority while in `WaitingForPlayer`.

## How the Lead State Machine Works

1. **Leading** — NPC walks toward destination, monitoring player distance
2. **WaitingForPlayer** — Player fell behind (`> maxPlayerDistance`), NPC stops and faces player
3. **Arrived** — NPC reached destination, behavior finishes (`isFinished = true`)

When the behavior finishes, it can be chained with other behaviors using `SequentialBehavior` (see `sequencing-actor-behaviors` skill).

## Validation

- [ ] `StarterLeadComponent` is on the actor root
- [ ] Either `destination` entity is set, OR `destinationTag` is set with matching tagged entities in scene
- [ ] If tag-based: destination entity has `ActorSdkTagComponent` with matching tag (case-sensitive) — the producer half (same rule as "The Tag Targeting Contract" in the parent skill). `LeadBehavior` reads it via `destinationTag` (a single tag), not `targetTags`.
- [ ] `followClosestPlayer` is set explicitly — its `false` path leads `targetPlayer`, or the closest player while `targetPlayer` is null
- [ ] Every other property is either set explicitly or intended at its default
- [ ] `resumePlayerDistance` is below `maxPlayerDistance` (`LeadBehavior` keeps the effective resume distance at least 1 m inside it, so a larger value is silently reduced)
- [ ] Advanced path only: the start script uses `ExecuteOn.Owner`
