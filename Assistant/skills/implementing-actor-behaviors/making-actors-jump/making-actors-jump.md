---
name: making-actors-jump
description: Makes an NPC jump through the Actor Framework control layer, wiring ActorJumpController so a behavior can command the body's jump the same way player input does. Covers the JumpAbility prerequisite that BaseActor does not ship and the shared-locomotion-axis arbitration rule.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
---

# Making an NPC Jump

Jump reaches an actor through `ActorJumpController`, an adapter that drives
`CharacterStateMachine.handleJumpClick()` / `handleJumpRelease()` — the *same* seam player input
uses. A behavior commands it through the `IActorJump` contract (`requestJump()` / `abortJump()`).

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC jump"
- "Have the enemy hop / leap / bounce"
- "Make the NPC jump over the gap"
- Any variation involving an NPC leaving the ground under its own power

## Check before adding anything

🚨 **Jump is the one Uber Character capability `BaseActor` does NOT ship.** A bare `BaseActor`
duplicate carries `CharacterStateMachine` but neither `JumpAbility` nor `ActorJumpController`, so
it cannot jump. Both must be added.

| The actor needs | Do |
|-----------------|-----|
| The ability to jump at all | Add `JumpAbility` **and** `ActorJumpController` to the actor root. |
| To jump on a repeating timer | Install `PeriodicJumpBehavior` from a small starter script — see Setup step 3. There is no creator starter for it. |
| `CharacterStateMachine` (the seam the adapter drives) | **Nothing.** Already on `BaseActor`. |
| A custom jump trigger (on sight, on damage, at a waypoint) | Compose in code — see "Advanced". |

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- `CharacterStateMachine` on the actor root (already there on a `BaseActor` duplicate)
- `JumpAbility` on the actor root (**not** on `BaseActor` — add it)
- `ActorJumpController` on the actor root (**not** on `BaseActor` — add it)

## Setup

1. Add `JumpAbility` (`scripts/Character/Abilities/JumpAbility.ts`) to the actor root.
2. Add `ActorJumpController` to the actor root. It resolves `CharacterStateMachine` and
   `JumpAbility` off its own entity at dependency-resolution time.
3. For a timer-driven jump, install a `PeriodicJumpBehavior`
   (`scripts/Actor/Behaviors/BaseBehaviors/PeriodicJumpBehavior.ts`) from a starter script on the actor root:

```typescript
import {component, property} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent} from '../scripts/Actor/Behaviors/Starters/BehaviorStarterComponent';
import {PeriodicJumpBehavior} from '../scripts/Actor/Behaviors/BaseBehaviors/PeriodicJumpBehavior';

@component()
export class StartTimedJumpComponent extends BehaviorStarterComponent {
  @property() interval: number = 3.0;

  override startBehavior(): PeriodicJumpBehavior | void {
    const actorLogic = this.controlledActor?.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('[StartTimedJumpComponent] No ActorSdkLogicComponent on the controlled actor.');
      return;
    }
    const jumper = new PeriodicJumpBehavior();
    // A template instance zero-inits omitted properties; 0 would jump every frame.
    jumper.interval = this.interval > 0 ? this.interval : 3.0;
    actorLogic.addBehavior(jumper, this.removeDuplicates);
    return jumper;
  }
}
```

## Jump shares the locomotion axis — this is the rule that surprises people

`ActorJumpController` registers under **`ActorMovementControllerTypeId`**, not an id of its own.
Jump is locomotion on the vertical axis, so one arbitration winner owns both axes. Two
consequences:

- **A behavior that wants only to jump must win the whole locomotion axis**, so it takes over
  steering for that frame. That cost is accepted deliberately.
- **Suppressing movement suppresses jump.** A `DeathBehavior` winning movement at priority 1000
  stops the body walking *and* stops it jumping. Giving jump its own type id would let the two
  axes arbitrate independently and the corpse would jump.

`ActorJumpController` sets `providesLocomotion = false`, so it does **not** satisfy
`BehaviorStarterComponent`'s missing-mover warning. An actor with a jump but no
`ActorTransformMoveComponent` still warns — correctly, because it cannot walk.

## Advanced: commanding a jump from your own behavior

Feature-detect the capability; never assume it. A body that cannot jump simply does not implement
`IActorJump`, and capability presence is expressed by what is registered, never by a no-op method.

```typescript
override getControllerUsePriority(controllerType: string): number {
  return controllerType === ActorMovementControllerTypeId ? this.basePriority : -1;
}

override useController(_controllerType: string, controller: ActorController): void {
  const jumper = controller as Partial<IActorJump>;
  if (typeof jumper.requestJump === 'function') {
    jumper.requestJump();
  }
}
```

Duck-type with `Partial<IActorJump>` plus a `typeof` check rather than reaching for a
`supportsJump()` guard — no such guard is exported, because the SDK `.d.ts` generator flattens a
type predicate to plain `boolean` and it would not narrow for a consumer reading the kit bundle.
`StaggerBehavior` feature-detects `IActorStaggerImpulseReceiver` the same way.

`requestJump()` implementations own their own buffering, coyote time and cooldown, so a request
that cannot be honoured immediately may still be honoured shortly after. **Do not implement your
own retry.**

`PeriodicJumpBehavior` (`scripts/Actor/Behaviors/BaseBehaviors/PeriodicJumpBehavior.ts`) is the smallest working
example. It claims the locomotion axis at `basePriority` 1 on purpose — it must lose to anything
real, so combat, death or a possessing player stops the jumping.

## Validation

- [ ] `JumpAbility` is on the actor root — without it the jump silently does nothing
- [ ] `ActorJumpController` is on the actor root
- [ ] The commanding behavior claims `ActorMovementControllerTypeId`, not a jump-specific id
- [ ] The behavior feature-detects `requestJump` rather than casting unconditionally

## See Also

- `working-with-actor-behaviors` — behavior lifecycle and controller arbitration
- `making-actors-go-to-point` — horizontal movement on the same locomotion axis
- `making-actors-die` — `DeathBehavior` at priority 1000 owns both axes, so a corpse cannot jump
