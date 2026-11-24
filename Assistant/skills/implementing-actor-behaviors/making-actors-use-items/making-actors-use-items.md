---
name: making-actors-use-items
description: Makes an NPC walk to a target and use a held item on it with UseItemBehavior, invoking a game-supplied callback at range — key on door, potion on ally, lever activation — and optionally dropping or destroying the item or target afterwards.
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

# Making an NPC Use an Item on a Target

`UseItemBehavior` makes an actor walk to a target entity and use a held item on it. When the actor reaches the target (within `useRange`), it invokes an `onUseItem` callback with the actor, target, and item entities. Game scripts provide this callback to implement the "use" logic (open door, consume potion, activate lever, etc.).

After use, optionally drops or destroys the held item and/or target.

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC use the key on the door"
- "Have the NPC pick up a potion and use it on the wounded NPC"
- "NPC should grab the lever handle and pull it"
- "Make the enemy use their weapon on the target"
- Any variation involving an NPC using a held item on another entity

## Check before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor is duplicated
from — **already carries `ActorSdkLogicComponent`, `ActorTransformMoveComponent` and
`ActorPickupItemComponent`**, hand slots already wired. So:

| The actor needs | Do |
|-----------------|-----|
| Carry an item to a target and **drop or destroy** it there | Add `StarterUseItemComponent`. No code. |
| Carry an item to a target and make **something happen** (open the door, heal the ally, pull the lever) | Write a script — the effect is the `onUseItem` callback, and there is no way to supply it from a property. |
| Pickup/drop mechanics, hand slots, a mover | **Nothing.** Already on `BaseActor`. |

This is the one item skill where the script path is not merely an advanced option.
`StarterUseItemComponent` deliberately carries no `@component` description for exactly
this reason — a description is what lists a starter in the picker, and without `onUseItem` the
actor carries the item over and drops it with **no effect**.
Pick the row that matches what the user actually asked for.

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorPickupItemComponent` on the actor root (already there on a `BaseActor` duplicate)
- `ActorTransformMoveComponent` on the actor root (already there on a `BaseActor` duplicate)
- The NPC must be holding an item (picked up via `SearchAndPickupBehavior` or manually)
- The target entity must exist in the scene
- A baked **NavMesh** exists in the scene so the NPC walks to the target around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Drop/destroy only: add the shipped starter

Add `StarterUseItemComponent` to the actor root, set `targetEntity`, and configure
`dropAfterUse` / `destroyItemAfterUse` / `destroyTargetAfterUse`.

**Set every property explicitly** — a template instance zero-inits what its delta does not name.
`dropAfterUse` zero-inits to `false`, so the actor keeps holding the item; `useSlot` zero-inits to
`None`, so it holds nothing to use; `useRange` and `moveSpeed` zero-init to 0.

🚨 **`startDelay` when a pickup starter shares the actor.** Set it longer than the pickup starter's
own `startDelay` plus its travel time, or the use runs empty-handed and gives up immediately —
`UseItemBehavior.executeUse` abandons the instant it finds an empty slot, so `basePriority` cannot
rescue the ordering.

Read the current property list and defaults off
`scripts/Actor/Behaviors/Starters/StarterUseItemComponent.ts` — do not trust a copied table.

## With an effect: compose the behavior in code

Required whenever the use has to *do* something. Assign `onUseItem` on a `UseItemBehavior` you
construct yourself:

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
  type Entity, TransformComponent,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {UseItemBehavior} from './Actor/Behaviors/BaseBehaviors/UseItemBehavior';
import {SearchAndPickupBehavior} from './Actor/Behaviors/CompositeBehaviors/Tagging/SearchAndPickupBehavior';
import {SequentialBehavior} from './Actor/Behaviors/BaseBehaviors/SequentialBehavior';

@component()
export class UseItemOnTargetScript extends Component {
  @property() itemTag: string = 'key';
  @property() targetEntity: Entity | null = null;
  @property() useRange: number = 2.0;
  @property() moveSpeed: number = 5.0;
  @property() destroyItemAfterUse: boolean = true;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic || !this.targetEntity) { return; }

    // Step 1: Pick up the item by tag
    const pickup = new SearchAndPickupBehavior();
    pickup.targetTags = [this.itemTag];
    pickup.pickupRange = 2.0;

    // Step 2: Walk to target and use the item
    const useItem = new UseItemBehavior();
    useItem.targetEntity = this.targetEntity;
    useItem.useRange = this.useRange;
    useItem.moveSpeed = this.moveSpeed;
    useItem.destroyItemAfterUse = this.destroyItemAfterUse;
    useItem.onUseItem = (actor, target, item, slot) => {
      // Game-specific logic goes here
      console.log('Item used on target!');
    };

    // Chain them in sequence: pickup → use
    const sequence = new SequentialBehavior();
    sequence.addStep(pickup);
    sequence.addStep(useItem);
    sequence.basePriority = 30;

    actorLogic.addBehavior(sequence);
  }
}
```

There is a third way in, worth knowing: `StarterUseItemComponent.startBehavior()` **returns**
the `UseItemBehavior` it created, so a component that calls it explicitly can assign `onUseItem`
on the returned instance. The auto-start path in `BehaviorStarterComponent.onStart()` discards the
return value, so this escape hatch is unavailable to a component that merely inherits the starter.

## Key Properties

Source: `scripts/Actor/Behaviors/Starters/StarterUseItemComponent.ts` (starter) and
`scripts/Actor/Behaviors/BaseBehaviors/UseItemBehavior.ts` (behavior). Read the current names, defaults and
per-property zero-init warnings there rather than from a copy here.

Note the type difference across the seam: the starter's `useSlot` is a `number` (an enum
`@property` reflects as `NativeTypeId::Enum`, which no `.hstf` serialises), while the behavior's
`useSlot` is a `PickupItemSlot`. In a script, use the enum.

`onUseItem` exists only on the behavior. That is the whole reason the script path is not optional
for effect-bearing uses.

## How It Works

1. `UseItemBehavior` creates an internal `GotoBehavior` to walk toward the target
2. Each frame, checks XZ distance to the target
3. When within `useRange`, sets `pendingUse = true` and stops moving
4. Claims `ActorPickupItemController` only when `pendingUse` is true (does not interfere with other pickup behaviors during walk phase)
5. Executes the `onUseItem` callback with actor, target, item, and slot
6. Optionally drops/destroys the item and/or target
7. Sets `isFinished = true`

## Drop Items on Death

`DeathBehavior` supports automatic item dropping when the actor dies:

```typescript
const death = new DeathBehavior();
death.dropItemsOnDeath = true; // drops all held items when HP reaches 0
death.basePriority = 1000;
actorLogic.addBehavior(death);
```

When `dropItemsOnDeath` is enabled, `DeathBehavior` claims `ActorPickupItemController` at priority 1000 on death and drops all items from all hand slots.

## Common Patterns

### Key Opens Door
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const door = target.getComponent(DoorController);
  if (door) { door.open(); }
};
useItem.destroyItemAfterUse = true; // key consumed
```

### Potion Heals Target
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const health = target.getComponent(CharacterGASComponent);
  if (health) {
    const data = health.getHealthData();
    data.currentHealth = data.maxHealth;
    health.setHealthData(data);
  }
};
useItem.destroyItemAfterUse = true; // potion consumed
```

### Lever Activation
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const lever = target.getComponent(LeverScript);
  if (lever) { lever.toggle(); }
};
useItem.dropAfterUse = false; // keep holding the lever handle
```

## See Also

- `making-actors-search-and-pickup` — How to make NPCs find and pick up tagged items
- `making-actors-deliver-to-tag` — How to make NPCs deliver held items to tagged locations
- `making-actors-fetch` — Higher-level fetch-and-deliver using `SimpleFetchBehavior`
- `making-actors-die` — Death behavior with `dropItemsOnDeath` support
- `sequencing-actor-behaviors` — How to chain pickup → use in sequence
