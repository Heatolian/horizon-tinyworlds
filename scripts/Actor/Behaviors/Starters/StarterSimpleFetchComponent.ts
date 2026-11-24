/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v34

import {
  component,
  property,
  editor,
  Vec3,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SimpleFetchBehavior} from '../BaseBehaviors/SimpleFetchBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';
import {PickupItemSlot} from 'meta/worlds';

/**
 * Automatically starts a simple fetch behavior for a given Actor.
 * The Actor will walk to the item, pick it up, and deliver it to the drop-off point.
 */
@component({
  description:
    'Walks to an item, picks it up, and carries it to a drop-off point. Set Entity to fetch or Fetch tag (entity wins); with both empty the NPC idles.',
})
export class StarterSimpleFetchComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Entity to fetch.'})
  itemToPickUp: Entity | null = null;

  @property()
  @editor({
    label: 'Fetch tag',
    description:
      'Tag of the item to fetch when Entity to fetch is empty: the nearest ' +
      'tagged entity becomes the target. For loot spawned at runtime, which ' +
      'no authored entity reference can name. Name take-loot (an ItemSystem ' +
      'container). A delivered hand prop keeps its tag but is remembered and ' +
      'skipped on later cycles while it stays where it was dropped. Dead ' +
      'characters are never fetched; their dropped loot resolves separately. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  itemToPickUpTag: string = '';

  @property()
  @editor({
    label: 'Skip tags',
    description:
      'Comma-separated tags whose carriers tag-resolution never fetches ' +
      '(e.g. "opened"). A world tags looted crates and the fetch walks past ' +
      'them to unopened loot. Empty skips nothing. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  fetchExcludedTags: string = '';

  @property({minValue: 0, maxValue: 360})
  @editor({
    label: 'Fetch view angle',
    description:
      'Horizontal view angle (degrees) tag-resolved loot must fall inside to ' +
      'be noticed. 0 keeps omniscient resolution. Facing only; walls do not ' +
      'block it. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  fetchViewAngleDeg: number = 0;

  @property()
  @editor({description: 'Where the item is carried to and dropped.'})
  itemDropOffPoint: Entity | null = null;

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.5, maxValue: 5})
  @editor({
    label: 'Pickup range',
    description:
      'Distance (m) at which pickup triggers. 🚨 Template gotcha: zero-inits ' +
      'to 0 on an instance, which can never be reached — set explicitly. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  itemPickupRange: number = 1.0;

  @property({minValue: 0.5, maxValue: 8})
  @editor({
    label: 'Move speed',
    description:
      'Walk speed (m/s). 🚨 Template gotcha: zero-inits to 0 on an instance, ' +
      'which never moves — set explicitly. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  moveSpeed: number = 5.0;

  /**
   * Typed `number` rather than `PickupItemSlot` on purpose. An enum-typed
   * `@property` reflects as `NativeTypeId::Enum`, which no `.hstf` in the repo
   * serialises and the live-property codec does not handle, so a scene-authored
   * value never reaches this field and the slot stays `None` — which
   * `ActorPickupItemComponent.pickupItem` rejects outright. A plain number
   * reflects as `Flt64`. Same workaround as `CameraManager.cameraMode`.
   */
  @property()
  @editor({
    description:
      `Which hand to use for pickup: ${PickupItemSlot.RightHand} RightHand, ` +
      `${PickupItemSlot.LeftHand} LeftHand. 🚨 Template gotcha: stored as ` +
      `${PickupItemSlot.None} (None) on a template instance, which pickupItem ` +
      `rejects — set explicitly to ${PickupItemSlot.RightHand}.`,
  })
  pickupHand: number = PickupItemSlot.RightHand;

  @property({minValue: 1, maxValue: 99})
  @editor({
    label: 'Priority',
    description:
      'When two behaviors on this actor want the same control (moving, turning, ' +
      'attacking), the higher priority wins; give them different values, as a tie ' +
      'picks one by load order. Death and stagger always win. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  basePriority: number = 20;

  @property({minValue: 0, maxValue: 10})
  @editor({
    label: 'Start delay',
    description:
      'Seconds to wait before starting the fetch cycle. Prevents instant ' +
      'completion during scene loading. 🚨 Template gotcha: zero-inits to 0 ' +
      'on an instance, removing that protection — set explicitly. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  startDelay: number = 2.0;

  protected override locomotionStarterName(): string {
    return 'StarterSimpleFetchComponent';
  }

  /**
   * Props this actor has delivered mapped to where each was dropped,
   * remembered across behavior-loop restarts so a restarted fetch never
   * re-fetches the prop it just delivered (a delivered hand prop keeps its
   * tag). Internal plumbing, not creator surface.
   */
  private readonly deliveredFromFetch: Map<Entity, Vec3> = new Map<Entity, Vec3>();

  override startBehavior(): SimpleFetchBehavior | void {
    if (!this.controlledActor) {
      console.warn('StarterSimpleFetchComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('StarterSimpleFetchComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    const fetchBehavior = new SimpleFetchBehavior();
    fetchBehavior.itemToPickUp = this.itemToPickUp;
    fetchBehavior.itemToPickUpTag = this.itemToPickUpTag;
    fetchBehavior.fetchExcludedTags = this.fetchExcludedTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    fetchBehavior.fetchViewAngleDeg = this.fetchViewAngleDeg;
    fetchBehavior.itemDropOffPoint = this.itemDropOffPoint;
    fetchBehavior.itemPickupRange = this.itemPickupRange;
    fetchBehavior.moveSpeed = this.moveSpeed;
    fetchBehavior.pickupSlot = this.resolveHandSlot(
      this.pickupHand,
      'StarterSimpleFetchComponent',
    );
    fetchBehavior.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, 20);
    fetchBehavior.startDelay = this.startDelay;
    fetchBehavior.deliveredSink = this.deliveredFromFetch;
    fetchBehavior.seedDelivered(this.deliveredFromFetch);

    actorLogic.addBehavior(fetchBehavior, this.removeDuplicates);
    return fetchBehavior;
  }
}
