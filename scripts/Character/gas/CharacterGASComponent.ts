/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v12

import {component, editor, property, rpc, ExecuteOn, WorldService, type Entity} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {GASAttributeData} from '../../gas/attributes/GASAttributeData';
import type {GASAttribute} from '../../gas/attributes/GASAttribute';
import type {EffectContext} from '../../gas/core/EffectContext';
import {DurationPolicy} from '../../gas/core/Enums';
import {GASEffectData} from '../../gas/effects/GASEffectData';
import {createDamageEffect} from './CharacterDamage';
import {HEALTH_ATTR, MAX_HEALTH_ATTR} from './CharacterAttributes';
import {DEAD_TAG, STAGGER_COOLDOWN_TAG, STAGGERED_TAG} from './CharacterTags';

export type DamagedListener = (amount: number, remainingHealth: number) => void;

// Fallbacks when a template instance zero-inits the stagger tunables below.
const DEFAULT_STAGGER_DURATION_SEC = 0.3;
const DEFAULT_STAGGER_COOLDOWN_SEC = 0.5;

/**
 * Character health as a GAS attribute: seeds `health` and `max_health`, clamps
 * them, and applies {@link DEAD_TAG} at zero. Serves player and NPC alike —
 * `ActorGASHealthComponent` extends it with the Actor Framework adapters.
 *
 * Death is published, not dispatched: raising {@link DEAD_TAG} is the whole of
 * it, and consumers subscribe. `CharacterStateMachine` incapacitates itself,
 * `DeathLayer` enters the pose, abilities refuse through `blockedByTags`.
 */
@component({
  description:
    "Character health as a GAS attribute: seeds and clamps it, and applies the death tag at zero. Consumers subscribe to the tag rather than being driven from here.",
})
export class CharacterGASComponent extends GASComponent {
  @editor({
    description:
      'Max health at spawn. SEED ONLY: read once by getInitialAttributes to ' +
      'create the health and max_health attributes, and ignored after that. ' +
      'The live ceiling is the max_health attribute — read it with `maxHealth` ' +
      'and move it with `setMaxHealth`, so it stays replicated and every reader ' +
      'agrees.',
  })
  @property()
  public initialMaxHealth: number = 100;

  /**
   * Whether a survivable hit staggers this character: applies Durational
   * `state.staggered` (for staggerDuration) plus `cooldown.stagger` (for
   * staggerDuration + staggerCooldown, which blocks the next stagger). Off by
   * default. The tag alone refuses attacks and dodge via `blockedByTags`; the
   * body is held still only when a StaggerBehavior guard is registered (NPCs
   * via StarterHealthAndDeathComponent, which is the single writer of this
   * field on such actors: it sets it from `disableStagger` on register, so an
   * authored value on such an actor is overwritten at start). A killing blow
   * never staggers — it goes to the death tag instead.
   */
  @editor({
    description:
      'Stagger when hit: a survivable hit raises state.staggered, refusing ' +
      'attacks and dodge via blockedByTags. The body holds still only when a ' +
      'StaggerBehavior guard is registered (NPCs opt in through ' +
      'StarterHealthAndDeathComponent). Off by default.',
  })
  @property()
  public staggerOnHit: boolean = false;

  /**
   * Seconds a stagger holds. 0 (the template-instance zero-init) means the
   * default; for a stagger that holds with no visible duration use a tiny
   * value such as 0.01.
   */
  @editor({description: 'Stagger hold duration in seconds. 0 means the default.'})
  @property()
  public staggerDuration: number = DEFAULT_STAGGER_DURATION_SEC;

  /**
   * Seconds after recovery before the next stagger. 0 (the template-instance
   * zero-init) means the default.
   */
  @editor({description: 'Stagger recovery window in seconds. 0 means the default.'})
  @property()
  public staggerCooldown: number = DEFAULT_STAGGER_COOLDOWN_SEC;

  /** Effective hold, honoring the zero-init-means-default rule. */
  public get effectiveStaggerDuration(): number {
    return this.staggerDuration > 0 ? this.staggerDuration : DEFAULT_STAGGER_DURATION_SEC;
  }

  /** Effective recovery window, honoring the zero-init-means-default rule. */
  public get effectiveStaggerCooldown(): number {
    return this.staggerCooldown > 0 ? this.staggerCooldown : DEFAULT_STAGGER_COOLDOWN_SEC;
  }

  private readonly damagedListeners: Set<DamagedListener> = new Set<DamagedListener>();

  // Pending is promoted in postDamage, so an unattributed hit reports no
  // attacker rather than the previous one.
  private pendingAttacker: Entity | null = null;
  private pendingKnockbackMultiplier: number = 1;
  private lastAttacker: Entity | null = null;
  private lastKnockbackMultiplier: number = 1;

  /** Call immediately before takeDamage(), on the owner. */
  public recordAttacker(attacker: Entity, knockbackMultiplier: number = 1): void {
    this.pendingAttacker = attacker;
    this.pendingKnockbackMultiplier = knockbackMultiplier;
  }

  public getLastAttacker(): Entity | null {
    // Validity checked on read; the attacker can be destroyed before the
    // stagger polls for it.
    if (this.lastAttacker != null && !this.lastAttacker.valid) {
      this.lastAttacker = null;
      this.lastKnockbackMultiplier = 1;
    }
    return this.lastAttacker;
  }

  public getLastKnockbackMultiplier(): number {
    return this.lastKnockbackMultiplier;
  }

  public get isDead(): boolean {
    return this.hasTag(DEAD_TAG);
  }

  /** Current health, for HUD and debug. */
  public get health(): number {
    return this.getAttributeValue(HEALTH_ATTR);
  }

  protected override getInitialAttributes(): ReadonlyArray<GASAttributeData> {
    const seed = Math.max(1, this.initialMaxHealth);
    return [
      new GASAttributeData({
        attributeName: HEALTH_ATTR,
        defaultValue: seed,
        minValue: 0,
        // No declared maxValue. The ceiling moves with `max_health`, and a
        // declared bound is fixed at construction — it could not follow.
        // Both attribute hooks below clamp against the live value instead.
        description: 'Current health. Zero applies the death tag.',
      }),
      new GASAttributeData({
        attributeName: MAX_HEALTH_ATTR,
        defaultValue: seed,
        minValue: 1,
        description: 'Maximum health. THE ceiling; healing cannot exceed it.',
      }),
    ];
  }

  /**
   * The live ceiling, the pair to {@link health}. Both read the replicated GAS
   * attribute, so every client and every reader agrees. `initialMaxHealth` is
   * only the authored seed and means nothing after construction.
   */
  public get maxHealth(): number {
    const attribute = this.attributeSet.getAttribute(MAX_HEALTH_ATTR);
    // Absent only before the attribute set is seeded; fall back to the seed so
    // an early clamp cannot read 0 and kill the character on spawn.
    return attribute ? attribute.currentValue : Math.max(1, this.initialMaxHealth);
  }

  /**
   * Move the ceiling. Health already above the new ceiling is clamped down to
   * it, so the bar can never read over full.
   */
  public setMaxHealth(value: number): void {
    // Authority only, like every other mutator on GASComponent. Without this
    // the two halves below disagree on a proxy: `setAttributeBase` carries its
    // own owner guard and no-ops, while the `recompute` does not and would run
    // anyway — re-deriving health from the proxy's local base and local
    // modifiers (a proxy holds no effect modifiers) and overwriting the
    // replicated value until the next snapshot corrects it.
    if (!this.entity.isOwned()) {
      return; // only the authority mutates attributes; proxies get replicated values
    }
    const next = Math.max(1, value);
    this.setAttributeBase(MAX_HEALTH_ATTR, next);

    // Health does not follow on its own: `recompute` runs only for the
    // attribute that changed, so moving the ceiling leaves health reading its
    // old value until something else happens to write it. Push it through its
    // hooks explicitly, and do so in BOTH directions — lowering has to bring
    // health down, and raising has to release a value the old, lower ceiling
    // had clamped.
    //
    // The base is only worth rewriting when it is itself over the ceiling.
    // Everything else is a recompute, which is also the case that matters with
    // modifiers: `currentValue` is base + modifiers, so it can sit above the
    // new ceiling while the base sits below it.
    if (this.getAttributeBase(HEALTH_ATTR) > next) {
      this.setAttributeBase(HEALTH_ATTR, next);
      return;
    }
    this.attributeSet.recompute(HEALTH_ATTR);
  }

  /** Applies damage from a non-GAS source, on the health owner. */
  public takeDamage(amount: number): void {
    if (amount <= 0) {
      return;
    }
    // Routes the amount, not the effect: effect IDs resolve against a registry
    // local to each machine.
    if (this.entity.networked && !this.entity.isOwned()) {
      this.RpcTakeDamage(amount);
      return;
    }
    this.applyDamageHere(amount);
  }

  // PascalCase is the established @rpc naming idiom across the repo and in the
  // writing-multiplayer-code skill; renaming would change the replicated method
  // name and diverge from every other copy.
  @rpc({execution: ExecuteOn.Owner})
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcTakeDamage(amount: number): void {
    this.applyDamageHere(amount);
  }

  private applyDamageHere(amount: number): void {
    if (this.isDead) {
      return;
    }
    // Via an effect, not a direct write: only the effect path reaches
    // postGameplayEffectExecute.
    this.applyEffectToSelf(createDamageEffect('character.damage.' + String(amount), amount));
  }

  /**
   * Clamp health into `[0, max_health]`.
   *
   * Both hooks are needed and neither is redundant: GAS clamps `currentValue`
   * against the attribute's DECLARED bounds, and health declares none, so the
   * live ceiling has to be applied here. `preAttributeBaseChange` covers a
   * direct base write, `preAttributeChange` covers the recompute that follows a
   * modifier or an effect.
   *
   * Proxies never reach either hook — `applyReplicatedSnapshot` writes the
   * replicated values straight in — so clamping correctly on the authority is
   * what makes every client agree.
   */
  protected override preAttributeBaseChange(attributeName: string, newValue: number): number {
    return this.clampHealth(attributeName, newValue);
  }

  protected override preAttributeChange(attributeName: string, newValue: number): number {
    return this.clampHealth(attributeName, newValue);
  }

  private clampHealth(attributeName: string, newValue: number): number {
    if (attributeName !== HEALTH_ATTR) {
      return newValue;
    }
    const clamped = Math.min(Math.max(newValue, 0), this.maxHealth);
    // While state.dead is set, health never rises: a heal that lands on a corpse
    // (a periodic effect ticking on the death frame) must not leave it dead with
    // health above 0. A revive clears state.dead first, then heals.
    return this.isDead ? Math.min(clamped, this.health) : clamped;
  }

  protected override postGameplayEffectExecute(
    ctx: EffectContext,
    attribute: GASAttribute,
    magnitudeDelta: number,
  ): void {
    if (attribute.data.attributeName !== HEALTH_ATTR) {
      return;
    }
    if (magnitudeDelta >= 0) {
      return;
    }
    if (this.isDead) {
      return;
    }
    const remainingHealth = attribute.currentValue;
    // GAS weapons hit through applyEffectToTarget and never call recordAttacker;
    // their caster arrives as the effect source, also across the network. A
    // periodic effect keeps its source, so each tick is attributed to the caster.
    if (this.pendingAttacker == null && ctx.source instanceof GASComponent && ctx.source !== this) {
      this.pendingAttacker = ctx.source.entity;
      this.pendingKnockbackMultiplier = 1;
    }
    this.postDamage(-magnitudeDelta, remainingHealth);
    // Outside the hook: a subclass overriding `postDamage` without calling super
    // would otherwise silence every subscriber.
    this.emitDamaged(-magnitudeDelta, remainingHealth);
    this.logHealth(`took ${-magnitudeDelta} damage, health now ${remainingHealth} of ${this.maxHealth}`);
    if (remainingHealth <= 0) {
      this.applyDeath();
      this.logHealth('died');
      return;
    }
    this.maybeApplyStagger();
  }

  /**
   * `[CharacterHealth]` line for eval judges reading worlds.log, written where
   * the damage is applied (the authority; proxies never reach this), so once
   * per hit. Names the character by `Name(Id: <id> NetId: <netId>)`, as the
   * `[ActorBehavior]`, `[GotoTrace]` and `[ScriptEntitySpawn]` lines do, and
   * ends with the world time.
   */
  private logHealth(text: string): void {
    const subject = this.entity?.valid ? `${this.entity.name}${this.entity.toString()}` : '<destroyed>';
    const worldTime = WorldService.get().getWorldTime().toFixed(3);
    console.log(`[CharacterHealth] ${subject} ${text}. worldTime=${worldTime}`);
  }

  protected applyDeath(): void {
    this.addLooseTag(DEAD_TAG);
    console.log(`[CharacterGAS] ${this.entity.name} died`);
  }

  /**
   * Staggers on a survivable hit when opted in (`staggerOnHit`). Built per
   * application so values assigned after construction apply, and never
   * registered: applied only to self on the owner, so no id crosses the wire
   * and characters with different durations cannot collide on one id.
   */
  private maybeApplyStagger(): void {
    if (!this.staggerOnHit || this.hasTag(STAGGER_COOLDOWN_TAG)) {
      return;
    }
    const duration = this.effectiveStaggerDuration;
    const cooldown = this.effectiveStaggerCooldown;
    this.applyEffectToSelf(
      new GASEffectData({
        effectId: 'character.stagger.cooldown',
        durationPolicy: DurationPolicy.Durational,
        duration: duration + cooldown,
        tagsAppliedToTarget: [STAGGER_COOLDOWN_TAG],
      }),
    );
    this.applyEffectToSelf(
      new GASEffectData({
        effectId: 'character.stagger',
        durationPolicy: DurationPolicy.Durational,
        duration,
        tagsAppliedToTarget: [STAGGERED_TAG],
      }),
    );
  }

  /** Damage only; never healing. Override to extend. */
  protected postDamage(_amount: number, _remainingHealth: number): void {
    this.lastAttacker = this.pendingAttacker;
    this.lastKnockbackMultiplier = this.pendingKnockbackMultiplier;
    this.pendingAttacker = null;
    this.pendingKnockbackMultiplier = 1;
  }

  /**
   * Subscribe to damage. Survives as `remainingHealth > 0`; a killing blow
   * reports 0 and is followed by {@link DEAD_TAG}.
   */
  public onDamaged(listener: DamagedListener): () => void {
    this.damagedListeners.add(listener);
    return (): void => {
      this.damagedListeners.delete(listener);
    };
  }

  private emitDamaged(amount: number, remainingHealth: number): void {
    for (const listener of this.damagedListeners) {
      listener(amount, remainingHealth);
    }
  }
}

/**
 * The entity's CharacterGASComponent, else its first descendant's. Recursive
 * because a character rig nests the component below the root; a shallow lookup
 * silently skips damage, or drops an attacker to an unattributed hit.
 */
export function findCharacterGAS(entity: Entity): CharacterGASComponent | null {
  return (
    entity.getComponent(CharacterGASComponent) ??
    entity.getChildrenWithComponent(CharacterGASComponent, true)[0]?.getComponent(CharacterGASComponent) ??
    null
  );
}
