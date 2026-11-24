---
name: configuring-actor-attention
description: Makes an NPC turn its whole body to face the nearest player, or the closest entity carrying a tag, while it is in range, using StarterLookAtComponent. Pairs with Wander or Patrol.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
---

# Making an NPC Face the Player (Look At)

Sets up an actor to turn its whole body toward the nearest player, or the closest living entity
carrying a tag, while it is within range. Uses `StarterLookAtComponent`, which runs
`AttentionBehavior` with the body turn on.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC look at the player"
- "Have the NPC face me when I'm nearby"
- "Make the NPC watch the player"
- Any variation involving an NPC looking at, watching, or facing entities

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor is duplicated
from — **already carries `ActorSdkLogicComponent` and `ActorTransformMoveComponent`** (which
registers `ActorBodyDirectionControllerTypeId`, the controller the turn uses). So:

| The actor needs | Do |
|-----------------|-----|
| Face the nearest player | Add `StarterLookAtComponent`. No code. |
| Face one specific entity | Give that entity a unique `ActorSdkTagComponent` tag and set `lookAtTags` to it. |
| A controller to turn the body | **Nothing.** Already on `BaseActor`. |

The turn is whole-body. **Nothing in this package registers an `ActorLookController`**, so there
is no head or eye aim, and idle gaze is switched off. While it faces a target it stands still;
turn-in-place animation is not implemented yet, so a turning actor plays its idle.

## Step 1: Add the shipped starter

Add `StarterLookAtComponent` to the actor root. That is the whole setup — do not write a script.
Unset settings fall back to their defaults, so a template instance that omits them still works.

Read the current property list and defaults off
`scripts/Actor/Behaviors/Starters/StarterLookAtComponent.ts` — do not trust a copied table.

## Combining with Other Behaviors

By default it runs at `StarterPriority.Attention` (15): above Wander and Patrol (`Ambient`, 5), so paired with
either the actor stops, turns to face a player who comes near, then carries on once the player
leaves; below Follow and Keep Away (`Social`, 25), which keep moving the actor when combined with it. While
it holds a target it claims body direction and movement (standing still), so the walker cannot keep
moving it sideways; with no target it claims neither. Combat and tasks still win at their default priorities. Each starter's Priority (`basePriority`) can change this order; give behaviors that share a control different values.

`AttentionBehavior` never finishes, so it cannot be sequenced on completion; the starter returns
nothing from `startBehavior()`.

## Validation

- [ ] `StarterLookAtComponent` is on the actor root
- [ ] For a non-player target, the target carries a matching `ActorSdkTagComponent` tag
