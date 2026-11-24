---
name: making-actors-search-and-pickup
description: Makes an NPC find the closest entity carrying a given tag, walk to it, and pick it up with SearchAndPickupBehavior, composing targeting, movement, and pickup into one behavior.
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
  - name: sequencing-actor-behaviors
    when: the pickup is one step of an ordered chain, such as fetch-then-deliver, rather than the whole task
---

# Making an NPC Search for and Pick Up Tagged Items

Sets up an actor to find the closest entity with a given tag, walk to it, and pick it up using `SearchAndPickupBehavior`. This composes targeting, following, and pickup into a single behavior.

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC pick up any nearby swords"
- "Have the NPC search for coins and collect them"
- "NPC should find the closest blue ball and grab it"
- "When the NPC sees a weapon, it should pick it up"
- Any variation involving searching for and picking up tagged objects

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor is duplicated
from — **already carries `ActorSdkLogicComponent`, `ActorTransformMoveComponent` and
`ActorPickupItemComponent`**, hand slots already wired. So:

| The actor needs | Do |
|-----------------|-----|
| Find the closest tagged item and pick it up | Add `StarterSearchAndPickupComponent` and set `targetTags`. No code. |
| Pickup mechanics, hand slots, a mover | **Nothing.** Already on `BaseActor`. |
| `detectionRange` dormancy, or a `bodyDirectionMode` other than the default | Compose in code — those are on the behavior, not the starter. See "Advanced" below. |

🚨 **`BaseActor` carries no `ActorSdkTagComponent`.** Tagging the *items* is the producer half of
the contract and is always your job.

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorPickupItemComponent` on the actor root (already there on a `BaseActor` duplicate)
- A movement controller on the actor root (already there on a `BaseActor` duplicate)
- Target items **MUST** have `ActorSdkTagComponent` with the matching tag (producer half — see "The Tag Targeting Contract" in the parent skill).
- A baked **NavMesh** exists in the scene so the NPC walks to items around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Tag the Target Items

Add `ActorSdkTagComponent` (provided by `meta/worlds`) to each item entity and set the `tags` property:

```
ActorSdkTagComponent → tags: ["sword"]
```

All items with the same tag are discoverable. The behavior finds the **closest** one.

## Step 2: Add the shipped starter

Add `StarterSearchAndPickupComponent` to the actor root and set `targetTags`. That is the
whole setup for the ordinary case — do not write a script for it.

`targetTags` is empty by default, and an actor with no tags logs an error and picks nothing up.

**Set every other property explicitly.** A template instance zero-inits any property its delta
does not name: a pickup range of 0 is never reached, a follow speed of 0 never moves, and a hand
slot of `None` is rejected by `pickupItem`.

Read the current property list and defaults off
`scripts/Actor/Behaviors/Starters/StarterSearchAndPickupComponent.ts` — do not trust a copied table.

## Advanced: composing the behavior in code

Needed when you want `detectionRange` dormancy or a non-default `bodyDirectionMode` — both live on
`SearchAndPickupBehavior`, not on the starter — or when the pickup is a step in a
`SequentialBehavior` chain.

Inside a script the behavior object takes the `PickupItemSlot` enum directly; the `number` retype
applies only to the starter's `@property`.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SearchAndPickupBehavior} from '../scripts/Actor/Behaviors/CompositeBehaviors/Tagging/SearchAndPickupBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'Makes this NPC search for tagged items and pick them up'})
export class StartSearchAndPickupComponent extends Component {
  @property() targetTags: string = 'coin';
  @property() pickupRange: number = 2.0;
  @property() followSpeed: number = 4.0;
  @property() persistent: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartSearchAndPickupComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const search = new SearchAndPickupBehavior();
    search.name = 'SearchAndPickup';
    search.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    search.pickupRange = this.pickupRange;
    search.followSpeed = this.followSpeed;
    search.pickupSlot = PickupItemSlot.RightHand;
    search.persistent = this.persistent;
    search.basePriority = 30;

    actorLogic.addBehavior(search);
  }
}
```

## Parameters

Source: `scripts/Actor/Behaviors/Starters/StarterSearchAndPickupComponent.ts` (starter) and
`scripts/Actor/Behaviors/CompositeBehaviors/Tagging/SearchAndPickupBehavior.ts` (behavior). Read the current names, defaults and
per-property zero-init warnings there rather than from a copy here.

`detectionRange` and `bodyDirectionMode` exist only on the behavior — reach them through the
Advanced path. Everything else is exposed on the starter.

## Priority-Based Activation with detectionRange (Preferred Pattern)

When the NPC has a default behavior (e.g., follow player) and should react to nearby items, use `detectionRange` with the priority system. **This is preferred over SequentialBehavior for conditional/reactive pickup.**

```typescript
@subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
onStart() {
  const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);

  // Default behavior: follow the player
  const follow = new FollowTaggedEntityBehavior();
  follow.targetTags = ['player'];
  follow.followRange = 3.0;
  follow.followSpeed = 5.0;
  follow.basePriority = 10;

  // Reactive behavior: pick up nearby sword when within 5m
  const pickup = new SearchAndPickupBehavior();
  pickup.targetTags = ['sword'];
  pickup.pickupRange = 2.0;
  pickup.followSpeed = 4.0;
  pickup.pickupSlot = PickupItemSlot.RightHand;
  pickup.persistent = false;
  pickup.detectionRange = 5.0;  // Dormant until sword is within 5m
  pickup.basePriority = 20;     // Wins over follow when active

  actorLogic.addBehavior(follow);
  actorLogic.addBehavior(pickup);
}
```

**How it works**: While the target is beyond `detectionRange`, the behavior returns `-1` for all controllers — the lower-priority follow behavior drives movement. When the target enters detection range, the pickup behavior activates at its higher priority, takes over movement, approaches the target, and picks it up. After pickup (`persistent = false`), it sets `isFinished = true` and is removed. The follow behavior resumes automatically.

Once activated, the behavior stays active even if the actor temporarily moves outside the detection range while approaching — no flickering.

## One-Shot vs Persistent Mode

- **One-shot** (`persistent = false`): Pick up one item, then `isFinished = true`. Use with priority-based activation or in `SequentialBehavior` chains.
- **Persistent** (`persistent = true`): keeps searching rather than finishing — but 🚨 **it still
  collects only one item per run.** The next pickup is refused while the hand is full, which ends
  the search. `persistent` alone does **not** give you "collect all coins". To collect several,
  sequence this after a behavior that empties the hand and let the sequence repeat.

## Chaining with SequentialBehavior

SearchAndPickupBehavior works as a step in a `SequentialBehavior` chain. **Use this only for strictly ordered tasks** (go here, pick up, deliver). For "follow but react to nearby items", use priority-based activation instead.

```typescript
const sequence = new SequentialBehavior();

// Step 1: Find and pick up the key
const pickup = new SearchAndPickupBehavior();
pickup.targetTags = ['key'];
pickup.pickupRange = 2.0;

// Step 2: Deliver to the door (see actor-deliver-to-tag skill)
const deliver = new DeliverToTagBehavior();
deliver.targetTags = ['door'];

sequence.addStep(pickup);
sequence.addStep(deliver);
actorLogic.addBehavior(sequence);
```

## Validation

- [ ] `StarterSearchAndPickupComponent` is on the actor root
- [ ] `targetTags` is set — it is empty by default and an empty value picks nothing up
- [ ] Target items have `ActorSdkTagComponent` with matching tag (case-sensitive)
- [ ] Tag string matches exactly between item and behavior
- [ ] Every other property is set explicitly, not left at the instance zero-init
- [ ] Advanced path only: the start script uses `ExecuteOn.Owner`
