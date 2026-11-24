/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v29

import {
  component,
  property,
  editor,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {UseItemBehavior} from '../BaseBehaviors/UseItemBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';
import {PickupItemSlot} from 'meta/worlds';

/**
 * Walks the actor to a target while carrying a held item, then resolves the
 * item and target per the drop/destroy properties below.
 *
 * The per-use effect is NOT wired here. `UseItemBehavior` invokes it through
 * `onUseItem`, which this starter never assigns — so a component authored from
 * this starter alone carries the item over and disposes of it, and nothing
 * else. Unlike the `character_template` original, `startBehavior()` returns the
 * behavior it created, so a caller holding that instance can assign `onUseItem`
 * itself; the auto-start path in `BehaviorStarterComponent.onStart()` discards
 * the return value, so that escape hatch is unavailable to a component that
 * only inherits the starter.
 *
 * Deliberately carries no `@component` description. A description is what
 * lists a starter in the NPC behavior picker, which is the no-code surface,
 * and there is nowhere in it to supply `onUseItem` — so a creator who chose
 * this would get an item carried and dropped with no effect. Describe it once
 * the starter exposes the effect without requiring a script.
 */
@component()
export class StarterUseItemComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'The target entity to use the item on.'})
  targetEntity: Entity | null = null;

  @property()
  @editor({
    description:
      'Distance from target at which the item is used. 🚨 Template gotcha: ' +
      'zero-inits to 0 on an instance, which can never be reached — set ' +
      'explicitly.',
  })
  useRange: number = 2.0;

  @property()
  @editor({
    description:
      'Movement speed toward the target. 🚨 Template gotcha: zero-inits to 0 ' +
      'on an instance, which never moves — set explicitly.',
  })
  moveSpeed: number = 5.0;

  /**
   * Typed `number` rather than `PickupItemSlot` for the same reason as
   * `StarterSimpleFetchComponent.pickupHand`: an enum-typed `@property`
   * reflects as `NativeTypeId::Enum`, which no `.hstf` in the repo serialises,
   * so a scene-authored value never arrives.
   *
   * Previously hardcoded to RightHand, which made a left-handed item
   * unusable — `UseItemBehavior.executeUse` reads `getPickupItem(useSlot)` and
   * gives up when the slot is empty, so the actor walked to its target and
   * then silently did nothing.
   */
  @property()
  @editor({
    description:
      `Which hand holds the item to use: ${PickupItemSlot.RightHand} RightHand, ` +
      `${PickupItemSlot.LeftHand} LeftHand. 🚨 Template gotcha: stored as ` +
      `${PickupItemSlot.None} (None) on a template instance, which holds no ` +
      `item — set explicitly to ${PickupItemSlot.RightHand}.`,
  })
  useSlot: number = PickupItemSlot.RightHand;

  @property()
  @editor({
    description:
      'If true, the item is dropped after use. 🚨 Template gotcha: zero-inits ' +
      'to FALSE on an instance, so the actor keeps holding it — set explicitly.',
  })
  dropAfterUse: boolean = true;

  @property()
  @editor({description: 'If true, the item entity is destroyed after use.'})
  destroyItemAfterUse: boolean = false;

  @property()
  @editor({description: 'If true, the target entity is destroyed after use.'})
  destroyTargetAfterUse: boolean = false;

  @property()
  @editor({
    description:
      'Arbitration priority against the actor\'s other behaviors. 🚨 Template ' +
      'gotcha: zero-inits to 0 on an instance — set explicitly.',
  })
  basePriority: number = 30;

  /**
   * Sequencing a fetch and a use on one actor is done HERE, not with
   * `basePriority`. `UseItemBehavior.executeUse` gives up the instant it finds
   * an empty slot, so priority alone cannot help: whichever way the arbitration
   * falls, the use still evaluates on the first frame and finishes. Only a
   * delay keeps it dormant while the pickup starter fetches.
   */
  @property()
  @editor({
    description:
      'Seconds to wait before starting. When a pickup starter shares this ' +
      'actor, set this longer than its startDelay plus its travel time, or ' +
      'the use runs empty-handed and gives up. 🚨 Template gotcha: zero-inits ' +
      'to 0 on an instance — set explicitly.',
  })
  startDelay: number = 0;

  // UseItemBehavior walks to the target via GotoBehavior before using it.
  protected override locomotionStarterName(): string {
    return 'StarterUseItemComponent';
  }

  override startBehavior(): UseItemBehavior | void {
    if (!this.controlledActor) {
      console.warn('StarterUseItemComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('StarterUseItemComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    if (!this.targetEntity) {
      console.warn('StarterUseItemComponent: No target entity set!');
      return;
    }

    const useItemBehavior = new UseItemBehavior();
    useItemBehavior.targetEntity = this.targetEntity;
    useItemBehavior.useSlot = this.resolveHandSlot(
      this.useSlot,
      'StarterUseItemComponent',
    );
    useItemBehavior.useRange = this.useRange;
    useItemBehavior.moveSpeed = this.moveSpeed;
    useItemBehavior.dropAfterUse = this.dropAfterUse;
    useItemBehavior.destroyItemAfterUse = this.destroyItemAfterUse;
    useItemBehavior.destroyTargetAfterUse = this.destroyTargetAfterUse;
    useItemBehavior.basePriority = this.basePriority;
    useItemBehavior.startDelay = this.startDelay;

    actorLogic.addBehavior(useItemBehavior, this.removeDuplicates);
    return useItemBehavior;
  }
}
