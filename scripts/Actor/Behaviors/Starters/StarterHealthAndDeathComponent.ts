/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v41

import {
  component,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  ExecuteOn,
  property,
  editor,
  type EventSubscription,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {CharacterGASComponent} from '../../../Character/gas/CharacterGASComponent';
import {DeathBehavior} from '../Guards/DeathBehavior';
import { StaggerBehavior } from '../Guards/StaggerBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';

// Above every StarterPriority role so a hit interrupts any starter; below
// DeathBehavior's 1000.
const STAGGER_PRIORITY = 100;

/**
 * Wires death and stagger for an actor. `BaseActor` ships it, so every actor
 * duplicated from it already dies and staggers.
 *
 * Place on the same entity as ActorSdkLogicComponent and the actor's
 * ActorGASHealthComponent. It wires against the ActorHealthController that
 * component registers rather than the class itself, so any future health
 * implementation registering under the same type id works unchanged.
 *
 * No `@component` description, so it stays off the GenStudio picker: every
 * actor already has it.
 */
@component()
export class StarterHealthAndDeathComponent extends BehaviorStarterComponent {
  @property()
  @editor({ label: 'Despawn delay', description: 'Seconds after death before the corpse is removed. Runtime-spawned actors are destroyed; actors that cannot be destroyed are disabled on the next update. The countdown continues across ownership transfers. 0 or -1 never despawns. Turning it on from 0 or -1 applies on restart; once on, edits apply at once.' })
  despawnTimer: number = -1;

  @property()
  @editor({ description: 'If true, disables collision on death. Warning: entity will fall through the floor.' })
  disableCollisionOnDeath: boolean = false;

  // Named so that the zero-inited false keeps hit reactions on.
  @property()
  @editor({ description: 'Turn off hit reactions: the actor neither holds still nor is knocked back when hit. This is the only opt-out here: the inherited Auto Start, Controlled Actor and Remove Duplicates have no effect on this component, and death is always wired.' })
  disableStagger: boolean = false;

  @property()
  @editor({ label: 'Knockback force', description: 'Knockback impulse speed in meters per second applied to this actor when it is staggered. Delivered to the ActorStaggerController via setStaggerParams(). Useful range is roughly 0.01-10: ground friction decelerates the impulse at about 4.9 m/s^2, so `5` throws a character ~2.5m and `2` throws it ~0.4m. 0 (unset) means 5; for a stagger that holds the actor still with no visible push, use a tiny value such as 0.01. Not clamped: a negative number inverts the impulse and pulls the actor toward whatever hit it, and a very large one launches it across the level. Read when the actor starts; edits apply on restart.' })
  // Literal so the editor shows the real default; it reads the initializer text and
  // cannot resolve a constant.
  knockbackForce: number = 5;

  private behaviorsRegistered = false;
  private death: DeathBehavior | null = null;
  private stagger: StaggerBehavior | null = null;

  @editor({show: false})
  @property({isNetworked: true})
  private ownerDeadElapsedSec: number = 0;

  @editor({show: false})
  @property({isNetworked: true})
  private ownerDespawnComplete: boolean = false;

  @editor({show: false})
  @property({isNetworked: true})
  private ownerDespawnRequested: boolean = false;

  @editor({show: false})
  @property({isNetworked: true})
  private ownerDisableRetryAtSec: number = 0;
  private ownerUpdateSubscription: EventSubscription | null = null;
  private ownerGas: CharacterGASComponent | null = null;
  private ownerDespawnResetPending: boolean = false;

  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer(): void {
    this.clearOwnerDespawnTracking();
    if (this.entity.isOwned()) {
      this.resetOwnerDespawnAfterDestroy();
      this.registerBehaviors();
      this.startOwnerDespawnTracking();
      return;
    }
    this.clearBehaviors();
  }

  private startOwnerDespawnTracking(): void {
    if (
      this.despawnTimer <= 0 ||
      this.ownerUpdateSubscription != null
    ) {
      return;
    }

    this.ownerUpdateSubscription = this.subscribe(
      OnWorldUpdateEvent,
      (payload: OnWorldUpdateEventPayload) => this.onOwnerUpdate(payload),
    );
  }

  // Replaces the base handler to ignore autoStart, which template instances
  // zero-init to false. Skips registerBehavior(), which tracks one behavior.
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  override onStart() {
    this.resetOwnerDespawnAfterDestroy();
    this.registerBehaviors();
    this.startOwnerDespawnTracking();
  }

  /** Late-resolving logic retries through the base tick, like every starter. */
  protected override onStartRetryResolved(): void {
    this.registerBehaviors();
  }

  /**
   * Health registers on its own entity, not the controlled actor, so
   * readiness checks the entity's logic. Otherwise an authored controlled
   * actor with logic would resolve every tick while registration keeps
   * failing and re-arming.
   */
  protected override isReadyToStart(): boolean {
    try {
      return this.entity.getComponent(ActorSdkLogicComponent) != null;
    } catch {
      return false;
    }
  }

  private registerBehaviors(): void {
    if (this.behaviorsRegistered) {
      return;
    }

    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    // Stagger application lives on GAS (CharacterGASComponent.maybeApplyStagger);
    // this starter is the single writer of the opt-in, so disableStagger always
    // wins over an authored staggerOnHit. Written before the early return so a
    // missing ActorSdkLogicComponent also forces it off: with no logic there is
    // no StaggerBehavior guard, and the tag alone would refuse attacks without
    // holding the body still. Owner-only write: onStart is Owner-scoped, but
    // direct callers (tests) may invoke it unowned, where a @property write
    // throws.
    if (this.entity.isOwned()) {
      const gas = this.entity.getComponent(CharacterGASComponent);
      if (gas) {
        gas.staggerOnHit = actorLogic != null && !this.disableStagger;
      }
    }

    if (!actorLogic) {
      console.warn('[StarterHealthAndDeathComponent] No ActorSdkLogicComponent on entity; retrying (GAS death and despawn still run).');
      this.armStartRetry();
      return;
    }

    this.behaviorsRegistered = true;

    const death = new DeathBehavior();
    death.disableCollisionOnDeath = this.disableCollisionOnDeath;
    actorLogic.addBehavior(death);
    this.death = death;

    if (!this.disableStagger) {
      const stagger = new StaggerBehavior();
      stagger.basePriority = STAGGER_PRIORITY;
      // A negative knockback is a supported, documented setting.
      stagger.knockbackForce = this.knockbackForce === 0 ? 5 : this.knockbackForce;
      actorLogic.addBehavior(stagger);
      this.stagger = stagger;
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy() {
    this.clearBehaviors();
    this.ownerDespawnResetPending = true;
    if (this.entity.valid && this.entity.isOwned()) {
      this.resetOwnerDespawnAfterDestroy();
    }
    this.clearOwnerDespawnTracking();
  }

  private resetOwnerDespawnAfterDestroy(): void {
    if (!this.ownerDespawnResetPending) {
      return;
    }
    this.ownerDeadElapsedSec = 0;
    this.ownerDespawnComplete = false;
    this.ownerDespawnRequested = false;
    this.ownerDisableRetryAtSec = 0;
    this.ownerDespawnResetPending = false;
  }

  private clearBehaviors(): void {
    const actorLogic = this.entity.valid
      ? this.entity.getComponent(ActorSdkLogicComponent)
      : null;
    if (actorLogic) {
      if (this.death) {
        actorLogic.removeBehavior(this.death);
      }
      if (this.stagger) {
        actorLogic.removeBehavior(this.stagger);
      }
    }
    // Return the body to its default: without the guard behavior nothing holds
    // movement, so a still-staggering body would block attacks it cannot pause.
    // Owner-only write: clearBehaviors also runs on ownership loss, where a
    // @property write throws. The next owner's registerBehaviors re-opts in.
    // A destroyed actor has no body or networked GAS properties left to reset.
    if (this.entity.valid && this.entity.isOwned()) {
      const gas = this.entity.getComponent(CharacterGASComponent);
      if (gas) {
        gas.staggerOnHit = false;
      }
    }
    this.death = null;
    this.stagger = null;
    this.behaviorsRegistered = false;
  }

  private clearOwnerDespawnTracking(): void {
    this.ownerGas = null;
    this.ownerUpdateSubscription?.disconnect();
    this.ownerUpdateSubscription = null;
  }

  private onOwnerUpdate(payload: OnWorldUpdateEventPayload): void {
    if (
      !this.entity.valid ||
      !this.entity.isOwned() ||
      this.despawnTimer <= 0 ||
      this.entity.isDestroyed()
    ) {
      return;
    }
    this.resetOwnerDespawnAfterDestroy();
    if (this.ownerDespawnComplete) {
      return;
    }

    const gas = this.resolveOwnerGas();
    if (!gas) {
      return;
    }
    if (!gas.isDead) {
      this.ownerDeadElapsedSec = 0;
      this.ownerDespawnRequested = false;
      this.ownerDisableRetryAtSec = 0;
      return;
    }

    this.ownerDeadElapsedSec += payload.deltaTime;
    if (this.ownerDeadElapsedSec < this.despawnTimer) {
      return;
    }

    if (!this.ownerDespawnRequested) {
      this.ownerDespawnRequested = true;
      this.entity.destroy();
      return;
    }

    // Destroy events settle before the next update. A surviving scene actor
    // may not grant Destroy permission; Disable is checked separately by native.
    if (this.ownerDeadElapsedSec < this.ownerDisableRetryAtSec) {
      return;
    }
    this.ownerDisableRetryAtSec = this.ownerDeadElapsedSec + 1;
    this.entity.enabledSelf = false;
    this.ownerDespawnComplete = !this.entity.enabledSelf;
  }

  private resolveOwnerGas(): CharacterGASComponent | null {
    if (this.ownerGas != null) {
      return this.ownerGas;
    }
    const gas = this.entity.getComponent(CharacterGASComponent);
    if (gas != null) {
      this.ownerGas = gas;
    }
    return gas;
  }
}
