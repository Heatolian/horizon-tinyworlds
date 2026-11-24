---
name: making-actors-die
description: Adds DeathBehavior so an actor stops acting and despawns when its GAS health reaches zero, claiming every controller at top priority to freeze movement and attacks, with optional collision disable and a destroy delay.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
consider_skills:
  - name: integrating-actor-health-system
    when: the actor does not yet have a health component — DeathBehavior reads the GAS death tag every frame and never fires without it
  - name: triggering-npc-animations
    when: a death clip should finish playing before the entity despawns, instead of the NPC vanishing instantly
---

# Adding Death Handling to an NPC

`DeathBehavior` watches the actor's GAS `state.dead` tag and takes over all controllers when HP reaches zero. Once dead, the behavior claims every controller at priority 1000 — higher than any other behavior — which stops movement, prevents attacks, and freezes the actor in place.

Optionally it can disable collision on death and destroy the entity after a configurable delay.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC die when health runs out"
- "Add death to this enemy" / "Handle NPC death"
- "Despawn the NPC after it dies" / "Destroy enemy on death"
- "Stop the NPC from moving when dead"
- Any variation involving NPC death handling or post-death cleanup

## Prerequisites

- `ActorSdkLogicComponent` on the actor root (already there on a `BaseActor` duplicate)
- A `CharacterGASComponent` on the actor root — use its subclass `ActorGASHealthComponent`
  (already there on a `BaseActor` duplicate, alongside `StarterHealthAndDeathComponent`, which wires
  `DeathBehavior` and `StaggerBehavior` for you). `DeathBehavior` alone works with a bare
  `CharacterGASComponent`, but `StaggerBehavior` and blackboard death reporting need the subclass.

## How It Works

Each frame, `DeathBehavior` checks the GAS `state.dead` tag on the actor's `CharacterGASComponent`, which is raised when health reaches zero. An actor with no `CharacterGASComponent` falls back to polling its `ActorHealthController`. Once dead:

1. **Claims all controllers at priority 1000** — this overrides every other behavior (combat, follow, patrol, stagger)
2. **Stops movement** — sends a null move command to prevent sliding or drifting
3. **Optionally disables collision** — removes the physics collider (warning: the entity will fall through the floor)

Despawn is not part of `DeathBehavior`. `StarterHealthAndDeathComponent.despawnTimer` owns it: whichever context owns the entity counts down after GAS death and destroys it (`0` or `-1` never despawns). The countdown is networked, so it continues where it left off when ownership transfers.

The death animation itself is played by the animation system (`DeathAnimationModule`), which subscribes to the same `state.dead` tag. `DeathBehavior` handles the gameplay side — freezing the actor and cleaning up.

## Usage

`DeathBehavior` is typically wired by `StarterHealthAndDeathComponent`, alongside `StaggerBehavior`. For standalone or custom use:

```typescript
import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {DeathBehavior} from '../scripts/Actor/Behaviors/Guards/DeathBehavior';

@component({description: 'Adds death behavior to this actor'})
export class StartDeathComponent extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartDeathComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const death = new DeathBehavior();
    death.basePriority = 100;
    death.disableCollisionOnDeath = false;

    actorLogic.addBehavior(death);
  }
}
```

## Key Properties

| Property | Default | Description |
|---|---|---|
| `disableCollisionOnDeath` | `false` | If true, disables the actor's collision on death. Warning: removes ground support — entity will sink through the floor. |
| `basePriority` | — | Base priority (typically 100). On death, claims all controllers at 1000 regardless of this value. |

## Respawning

There is no revive: the `state.dead` tag is never cleared. To bring an actor back, despawn the dead one and spawn a fresh copy:

1. Set `despawnTimer` on the actor's `StarterHealthAndDeathComponent` (e.g. `3`).
2. Spawn the actor from an `ActorSpawner` with an `ActorIntervalTrigger` and `maxAlive` 1 (see the `spawning-npc-actors` skill). When the corpse despawns, the slot frees and the trigger spawns a new one.

## Priority

`DeathBehavior` uses an internal dead priority of **1000** when the actor dies. This is hardcoded to be higher than any normal behavior priority, ensuring the dead actor stops all activity. The `basePriority` property only matters before death — set it high enough that the behavior's `update()` runs (it checks for death each frame).

## Common Mistakes

1. **Missing health** — `DeathBehavior` reads the `state.dead` tag off a `CharacterGASComponent` on the actor root (or, without one, an `ActorHealthController`). With neither, it never detects death.
2. **Priority too low on other behaviors** — not a problem for death itself (priority 1000 always wins), but if `basePriority` is 0, the behavior's `update()` still runs. Death detection works at any priority.
3. **Enabling `disableCollisionOnDeath`** — this removes the physics body's collision, causing the entity to fall through the ground. Only use if you specifically want a sinking/falling death effect.
4. **Expecting death animation from this behavior** — `DeathBehavior` does not play animations. The animation system (`DeathAnimationModule`) plays the death pose off the `state.dead` tag. This behavior handles gameplay (freeze + cleanup).
