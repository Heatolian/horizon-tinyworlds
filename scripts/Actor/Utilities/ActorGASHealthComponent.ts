/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v31

import {
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  NetworkingService,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  Service,
  ActorSdkBlackboardManager,
  ActorSdkLogicComponent,
  ActorHealthControllerData,
  ActorHealthControllerTypeId,
  BlackboardScope,
  type ActorHealthController,
} from 'meta/worlds';
import {CombatBlackboard} from '../Core/Blackboard/Implementations/CombatBlackboard';
import {CharacterGASComponent} from '../../Character/gas/CharacterGASComponent';
import {HEALTH_ATTR} from '../../Character/gas/CharacterAttributes';
import {STAGGERED_TAG} from '../../Character/gas/CharacterTags';
import {GASAttributeData} from '../../gas/attributes/GASAttributeData';
import {DurationPolicy, MagnitudeMode, ModifierOperator} from '../../gas/core/Enums';
import type {Effect} from '../../gas/effects/Effect';
import {GASEffectData} from '../../gas/effects/GASEffectData';
import {GASEffectModifier} from '../../gas/effects/GASEffectModifier';

/**
 * Tick period of the regeneration heal. Each tick is one GAS attribute change,
 * which republishes the replicated attribute snapshot, so it is not per frame.
 * Exported so the behavior pacing the heal shares the glimpse window with the
 * component holding the effect.
 */
export const REGEN_PERIOD_SECONDS = 0.5;

/**
 * NPC health: {@link CharacterGASComponent} plus the Actor Framework adapters —
 * `ActorHealthController` registration, blackboard death reporting, combat
 * telemetry, and the owned regeneration heal behaviors pace. Health itself is inherited unchanged, and the controller's `isHit`
 * reports the GAS `state.staggered` tag that StaggerBehavior applies.
 */
@component({
  description:
    'NPC health. Inherits the shared GAS health component and adds the Actor Framework health controller, blackboard death reporting and combat telemetry.',
})
export class ActorGASHealthComponent
  extends CharacterGASComponent
  implements ActorHealthController
{
  @editor({
    description:
      'Blackboard group ID for faction-based combat target tracking. Leave empty to skip blackboard updates.',
  })
  @property()
  public blackboardGroupId: string = '';

  /** Damage applications this actor has survived-or-died to, counted per life. */
  public hitCount: number = 0;

  protected blackboardManager = Service.inject(ActorSdkBlackboardManager);
  private actorLogicComponent: ActorSdkLogicComponent | null = null;

  /** Held regeneration heal, owned here so behaviors never write GAS. */
  private regenEffect: Effect | null = null;
  private regenRate: number = 0;
  /**
   * Rate whose application was refused (a remote proxy returns no handle).
   * Remembered so a refused rate is tried once per episode, not every frame;
   * cleared by `clearRegen` or superseded by a different rate.
   */
  private regenRefusedRate: number | null = null;

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
  onActorHealthCreate(): void {
    this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
    // Reset for pooled reuse.
    this.hitCount = 0;
    this.clearRegen();
    if (this.entity.isOwned()) {
      this.registerActorController();
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onActorHealthDestroy(): void {
    this.unregisterActorController();
  }

  // --- ActorHealthController -------------------------------------------------

  /** Reads the GAS attributes, not the `initialMaxHealth` seed. */
  getHealthData(): ActorHealthControllerData {
    return Object.assign(new ActorHealthControllerData(), {
      maxHealth: this.maxHealth,
      currentHealth: this.health,
      isDead: this.isDead,
      isHit: this.hasTag(STAGGERED_TAG),
    });
  }

  /**
   * Writes land on the GAS attributes, not a local copy.
   *
   * A non-positive `maxHealth` leaves the ceiling alone rather than collapsing
   * it. `ActorHealthControllerData` is a plain struct whose number fields start
   * at zero, so a caller that builds a fresh one and fills in only
   * `currentHealth` — a reasonable reading of a whole-struct setter — would
   * otherwise drop the ceiling to 1 and take the health it was restoring down
   * with it.
   *
   * When the ceiling IS being moved it goes first, so that a lowered ceiling
   * clamps the old health rather than the new value this call is setting.
   *
   * `isHit` is ignored: it reports the `state.staggered` tag, which only a
   * stagger effect raises or clears.
   */
  setHealthData(data: ActorHealthControllerData): void {
    if (data.maxHealth > 0) {
      this.setMaxHealth(data.maxHealth);
    }
    this.setAttributeBase(HEALTH_ATTR, data.currentHealth);
  }

  registerActorController(): void {
    this.actorLogicComponent?.registerController(ActorHealthControllerTypeId, this);
  }

  unregisterActorController(): void {
    this.actorLogicComponent?.unregisterController(this);
  }

  // --- health regeneration ---------------------------------------------------
  //
  // The heal a behavior paces (ShooterCombat's unseen-regen) is applied here,
  // in the capability layer: behaviors decide WHEN to heal and call these, but
  // never touch effects themselves.

  /** True while a regeneration effect is held. */
  get isRegenHeld(): boolean {
    return this.regenEffect != null;
  }

  /**
   * Holds a periodic heal at `perSecond`, rebuilding it when the rate changes.
   * A non-positive rate clears instead. A refused application (remote proxies
   * return no handle) is tried once per rate while still a proxy, not every
   * frame; gaining authority retries it, so an ownership handoff mid-episode
   * does not leave regen off.
   */
  setRegenRate(perSecond: number): void {
    if (!(perSecond > 0)) {
      this.clearRegen();
      return;
    }
    if (this.regenRate === perSecond && this.regenEffect != null) {
      return;
    }
    if (this.regenRefusedRate === perSecond) {
      // Still a proxy: the refusal stands. Owned now: the refusal may have
      // cleared with authority, so drop it and retry below (a fresh refusal
      // re-pins). Owned applications return a handle, so this retries once,
      // not every frame.
      if (!this.entity.isOwned()) {
        return;
      }
      this.regenRefusedRate = null;
    }
    // Applied before the old heal is dropped: a refused application (remote
    // proxies return no handle) keeps the working heal instead of losing
    // regen for the episode. The removal is synchronous in the same call, so
    // no tick can run with both heals held.
    const next = this.applyEffectToSelf(createRegenEffect(perSecond));
    if (next == null) {
      this.regenRefusedRate = perSecond;
      return;
    }
    if (this.regenEffect != null) {
      this.removeEffect(this.regenEffect);
    }
    this.regenEffect = next;
    this.regenRate = perSecond;
    this.regenRefusedRate = null;
  }

  /** Drops a held regeneration heal and forgets refused rates. */
  clearRegen(): void {
    if (this.regenEffect != null) {
      this.removeEffect(this.regenEffect);
      this.regenEffect = null;
    }
    this.regenRate = 0;
    this.regenRefusedRate = null;
  }

  // --- damage and death ------------------------------------------------------

  /** Damage only; the base promotes the attacker. */
  protected override postDamage(amount: number, remainingHealth: number): void {
    super.postDamage(amount, remainingHealth);

    this.hitCount += 1;
    this.emitCombatTelemetry('hit', amount, remainingHealth);
    if (remainingHealth <= 0) {
      this.emitCombatTelemetry('death', amount, 0);
    }
  }

  protected override applyDeath(): void {
    super.applyDeath();
    if (!this.blackboardGroupId) {
      return;
    }
    const combatBlackboard = this.blackboardManager.getBlackboard(
      CombatBlackboard,
      /* actorId */ undefined,
      this.blackboardGroupId,
      BlackboardScope.Group,
    );
    combatBlackboard?.updateTarget(this.entity, {isDead: true}, false);
  }

  /** Server-only, so a landed hit is one line rather than one per client. */
  private emitCombatTelemetry(event: 'hit' | 'death', amount: number, health: number): void {
    if (!NetworkingService.get().isServerContext()) {
      return;
    }
    const name = this.entity?.valid ? this.entity.name : '<destroyed>';
    console.log(
      `[ActorCombatTelemetry] event=${event} target=${name} damage=${amount} hits=${this.hitCount} health=${health}`,
    );
  }
}

/**
 * Infinite periodic heal, self-only on the owner, so it carries no effect id:
 * GAS applies it as given rather than swapping in a registered definition, and
 * actors with different rates cannot collide. The first heal lands one period
 * after application, so an effect removed and re-applied never heals faster
 * than `perSecond`.
 */
function createRegenEffect(perSecond: number): GASEffectData {
  const effect = new GASEffectData({
    effectId: '',
    durationPolicy: DurationPolicy.Infinite,
    period: REGEN_PERIOD_SECONDS,
  });
  effect.modifiers.push(
    new GASEffectModifier({
      attribute: new GASAttributeData({attributeName: HEALTH_ATTR}),
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: perSecond * REGEN_PERIOD_SECONDS,
    }),
  );
  return effect;
}
