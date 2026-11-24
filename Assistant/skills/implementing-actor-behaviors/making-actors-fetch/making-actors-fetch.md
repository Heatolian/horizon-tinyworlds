---
name: making-actors-fetch
description: Makes an NPC fetch a specific item, pick it up, carry it to a drop-off point, and drop it, using SimpleFetchBehavior plus the pickup component for hand-slot mechanics.
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

# Making an NPC Fetch and Deliver an Item

Sets up an actor to fetch a specific item entity, pick it up, carry it to a drop-off point, and drop it using `SimpleFetchBehavior`. The NPC needs `ActorPickupItemComponent` for hand-slot pickup/drop mechanics.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC fetch the ball"
- "Have the NPC pick up the sword and bring it here"
- "Make the NPC carry items from A to B"
- "NPC should retrieve the key and deliver it"
- Any variation involving fetching, carrying, or transporting a specific item

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor is duplicated
from — **already carries `ActorSdkLogicComponent`, `ActorTransformMoveComponent` and
`ActorPickupItemComponent`**, with its `rightHandSlotEntity` / `leftHandSlotEntity` already wired
to the `RightHand_Socket` / `LeftHand_Socket` child entities. So:

| The actor needs | Do |
|-----------------|-----|
| Walk to an item, carry it, drop it | Add `StarterSimpleFetchComponent` and set its properties. No code. |
| Pickup/drop mechanics, hand slots | **Nothing.** Already on `BaseActor`. |
| A movement controller | **Nothing.** Already on `BaseActor`. |
| An effect when the item arrives (not just a drop) | Use `StarterUseItemComponent` — see `making-actors-use-items`. |

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorPickupItemComponent` on the actor root (already there on a `BaseActor` duplicate)
- A movement controller on the actor root (already there on a `BaseActor` duplicate)
- The item entity should have a child entity named `GripPoint` for proper hand positioning
- A baked **NavMesh** exists in the scene so the NPC walks to and from the item around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Add the shipped starter

Add `StarterSimpleFetchComponent` to the actor root and set `itemToPickUp` and
`itemDropOffPoint`. That is the whole setup — do not write a script for this.

**Set every property explicitly.** A template instance zero-inits any property its delta does not
name, so an instance that omits them gets a pickup range of 0 (never reached), a move speed of 0
(never moves), and a hand slot of `None` (which `pickupItem` rejects). Each property's `@editor`
description names its own zero-init trap.

Read the current property list and defaults off
`scripts/Actor/Behaviors/Starters/StarterSimpleFetchComponent.ts` — do not trust a copied table.

## Hand slot

`pickupHand` is typed `number`, not `PickupItemSlot`: an enum-typed `@property` reflects as
`NativeTypeId::Enum`, which no `.hstf` serialises, so a scene-authored enum value never arrives.
Set it to the numeric `PickupItemSlot.RightHand` / `.LeftHand` value.
`BehaviorStarterComponent.resolveHandSlot()` warns and falls back to RightHand on a bad value, so
a wrong hand is visible rather than a silent no-op.

## Advanced: composing the behavior in code

Only needed when the fetch has to be built at runtime, sequenced with other behaviors, or
observed for completion — `startBehavior()` returns the behavior so a caller can watch
`isFinished`. For the ordinary case use the starter above.

Inside a script the behavior object still takes the `PickupItemSlot` enum directly
(`SimpleFetchBehavior.pickupSlot: PickupItemSlot`); the `number` retype applies only to the
starter's `@property`.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SimpleFetchBehavior} from '../scripts/Actor/Behaviors/BaseBehaviors/SimpleFetchBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'Makes this NPC fetch an item and deliver it to a drop-off'})
export class StartFetchComponent extends Component {
  @property() itemToPickUp: Entity | null = null;
  @property() dropOffPoint: Entity | null = null;
  @property() moveSpeed: number = 5.0;
  @property() pickupRange: number = 1.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartFetchComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    if (!this.itemToPickUp || !this.dropOffPoint) {
      console.warn('[StartFetchComponent] Missing itemToPickUp or dropOffPoint');
      return;
    }

    const fetch = new SimpleFetchBehavior();
    fetch.name = 'FetchItem';
    fetch.itemToPickUp = this.itemToPickUp;
    fetch.itemDropOffPoint = this.dropOffPoint;
    fetch.moveSpeed = this.moveSpeed;
    fetch.itemPickupRange = this.pickupRange;
    fetch.pickupSlot = PickupItemSlot.RightHand;
    fetch.basePriority = 30;

    actorLogic.addBehavior(fetch);
  }
}
```

## Parameters

Source: `scripts/Actor/Behaviors/Starters/StarterSimpleFetchComponent.ts` (starter) and
`scripts/Actor/Behaviors/BaseBehaviors/SimpleFetchBehavior.ts` (behavior). Read the current names, defaults and
per-property zero-init warnings there rather than from a copy here.

`basePriority` is claimed on both the **Pickup** and **Movement** controllers — `SimpleFetchBehavior`
copies it into the nested `GotoBehavior` that drives the walk, once, in `initialize()`, so set it
before `addBehavior()`: a later write moves the Pickup claim but not the walk. That matters when
sequencing fetch against another mover, since an equal Movement priority is a tie.

## How SimpleFetchBehavior Works

1. **Moving to item** — NPC walks to `itemToPickUp` position
2. **Pickup** — When within `itemPickupRange`, picks up item via `ActorPickupItemController`
3. **Moving to drop-off** — NPC walks to `itemDropOffPoint` position
4. **Drop** — When within range of drop-off, drops the item
5. **Finished** — Behavior sets `isFinished = true`

## GripPoint Setup

For proper hand positioning, add a child entity named `GripPoint` to the item:
- The `GripPoint`'s local position/rotation defines the offset from the hand slot
- Without a `GripPoint`, the item is held at its origin (which may look wrong)

## Validation

- [ ] `StarterSimpleFetchComponent` is on the actor root
- [ ] `itemToPickUp` and `itemDropOffPoint` are both set
- [ ] Every other property on the starter is set explicitly, not left at the instance zero-init
- [ ] A baked NavMesh covers the path between the item and the drop-off
- [ ] Advanced path only: the start script uses `ExecuteOn.Owner`
