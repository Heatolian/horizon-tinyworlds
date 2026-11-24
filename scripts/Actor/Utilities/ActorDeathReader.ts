/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v28

import { type ActorHealthController, type Entity } from "meta/worlds";
import { CharacterGASComponent, findCharacterGAS } from "../../Character/gas/CharacterGASComponent";

/**
 * Reads whether an actor is dead, for behaviors that must stand down on death.
 *
 * Death is the GAS `state.dead` tag on the actor's CharacterGASComponent; an
 * actor authored without one falls back to polling its ActorHealthController.
 * Shared so the engine has one definition of "dead" -- a behavior that answered
 * the question differently from DeathBehavior would stand down at a different
 * moment than the corpse takes over.
 *
 * Reports LIVE state. A caller that needs a corpse to stay a corpse latches the
 * answer itself (DeathBehavior does); a caller gating a per-frame decision wants
 * the live read, so a revived actor resumes.
 */
export class ActorDeathReader {
    private gas: CharacterGASComponent | null = null;

    /**
     * Cached only once found: start order against the health component is not
     * guaranteed, so a miss is retried rather than latched.
     */
    read(
        entity: Entity | null,
        healthControllers: readonly ActorHealthController[] | undefined,
    ): boolean {
        const gas = this.resolveGas(entity);
        if (gas) {
            return gas.isDead;
        }
        return healthControllers?.some(healthController => healthController.getHealthData().isDead) ?? false;
    }

    /** Whether the actor has a CharacterGASComponent, cached the same way as {@link read}. */
    hasGas(entity: Entity | null): boolean {
        return this.resolveGas(entity) != null;
    }

    private resolveGas(entity: Entity | null): CharacterGASComponent | null {
        if (!this.gas && entity) {
            this.gas = entity.getComponent(CharacterGASComponent);
        }
        return this.gas;
    }
}

/**
 * Reads whether an attack target is dead, resolving its health with
 * `findCharacterGAS`. A target with no health is never dead.
 *
 * The lookup can walk the target's hierarchy and callers read it every frame,
 * so a found component is kept until the target changes. A miss is retried, as
 * in {@link ActorDeathReader}: a freshly spawned target may not have started its
 * health component yet. Death itself is read live, so a revived target reads
 * alive.
 */
export class TargetDeathReader {
    private target: Entity | null = null;
    private health: CharacterGASComponent | null = null;

    isDead(target: Entity | null): boolean {
        if (target !== this.target) {
            this.target = target;
            this.health = null;
        }
        if (!this.health && target) {
            this.health = findCharacterGAS(target);
        }
        return this.health?.isDead ?? false;
    }
}
