/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v41

import {
  component,
  property,
  editor,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';
import {
  SearchAndPickupBehavior,
  type EmptyHandedWarningLatch,
} from '../CompositeBehaviors/Tagging/SearchAndPickupBehavior';
import {PickupItemSlot} from 'meta/worlds';

/**
 * Automatically starts a SearchAndPickupBehavior for a given Actor.
 * The Actor will find the closest entity with the specified tag,
 * walk toward it, and pick it up when in range.
 */
@component({
  description: 'Finds the closest entity carrying a matching tag, walks to it, and picks it up. Collects one item per run, even with Persistent on — see that option. targetTags must be set — it is empty by default, and an actor with no tags logs an error and picks nothing up.',
})
export class StarterSearchAndPickupComponent extends BehaviorStarterComponent {
  @property()
  @editor({label: 'Item tags', description: 'Comma-separated tags to search for (e.g. "sword", "sword, key"). Read when the behavior starts; edits apply on restart.'})
  targetTags: string = '';

  // minValue/maxValue clamp every TypeScript write (the platform setter), not just the
  // slider. Authored and template values load natively and are not clamped.
  // Number defaults stay literal: the editor reads an unset property's default from the
  // initializer text and cannot resolve a constant, so a constant there reads as 0.
  @property({minValue: 0.5, maxValue: 5})
  @editor({
    label: 'Pickup range',
    description:
      'Distance (meters) at which pickup is triggered. 🚨 Template gotcha: ' +
      'zero-inits to 0 on an instance, which can never be reached — set ' +
      'explicitly. Loot takes need this within the loot’s 3D reach: the take ' +
      'fires at this XZ range, but the server refuses past the loot’s ' +
      'Interactable maxDistance (default 3m), so a larger value only burns ' +
      'retries on outOfReach. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  pickupRange: number = 2.0;

  @property({minValue: 0.5, maxValue: 8})
  @editor({
    label: 'Move speed',
    description:
      'Movement speed in m/s. 🚨 Template gotcha: zero-inits to 0 on an ' +
      'instance, which never moves — set explicitly. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  followSpeed: number = 5.0;

  @property()
  @editor({
    label: 'Skip tags',
    description:
      'Comma-separated tags whose carriers are never pursued (e.g. "opened"). ' +
      'A world tags looted chests and the actor walks past them. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  excludedTags: string = '';

  @property()
  @editor({
    description:
      'Registered candidate-filter name whose veto the search obeys ' +
      '(CandidateFilterRegistry.register). A world script registers game notions ' +
      'of "useful" (skip downgrades, skip full ammo) under a name and sets it ' +
      'here. Empty uses no registry filter. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  candidateFilterKey: string = '';

  @property({minValue: 0, maxValue: 60})
  @editor({
    label: 'Give up after',
    description:
      'Seconds without a pickup before the run retires its current target and ' +
      'moves on (or finishes, when not Persistent). 0 pursues forever. ' +
      'When nothing resolves for a full window, the memory lifts and the ' +
      'search retries retired targets, up to 3 fruitless rounds. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  giveUpSeconds: number = 0;

  @property({minValue: 0, maxValue: 360})
  @editor({
    label: 'Search view angle',
    description:
      'Horizontal view angle (degrees) loot must fall inside to be noticed. ' +
      '0 keeps the omniscient search. Facing only; walls do not block it. ' +
      'A non-zero angle needs another behavior that turns the body (patrol, ' +
      'attention), or loot outside the cone is never noticed. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  searchViewAngleDeg: number = 0;

  /**
   * Typed `number` rather than `PickupItemSlot` for the same reason as
   * `StarterSimpleFetchComponent.pickupHand`: an enum-typed `@property`
   * reflects as `NativeTypeId::Enum`, which no `.hstf` in the repo serialises,
   * so a scene-authored value never arrives and the slot stays `None` — which
   * `ActorPickupItemComponent.pickupItem` rejects. A plain number reflects as
   * `Flt64`. The field keeps its name; only the type changes.
   */
  @property()
  @editor({
    description:
      `Which hand to use for pickup: ${PickupItemSlot.RightHand} RightHand, ` +
      `${PickupItemSlot.LeftHand} LeftHand. 🚨 Template gotcha: stored as ` +
      `${PickupItemSlot.None} (None) on a template instance, which pickupItem ` +
      `rejects — set explicitly to ${PickupItemSlot.RightHand}.`,
  })
  pickupSlot: number = PickupItemSlot.RightHand;

  @property()
  @editor({
    description:
      'If true, keeps searching for more items after pickup. 🚨 Template ' +
      'gotcha: this still collects only one item per run — the next pickup is ' +
      'refused while the hand is full, which ends the search. To collect ' +
      'several, sequence this after a behavior that empties the hand and let ' +
      'the sequence repeat.',
  })
  persistent: boolean = false;

  @property({minValue: 0, maxValue: 10})
  @editor({
    label: 'Start delay',
    description:
      'Seconds to wait before starting. 🚨 Template gotcha: zero-inits to 0 ' +
      'on an instance, so the search runs before the scene has settled — set ' +
      'explicitly. ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  startDelay: number = 2.0;

  @property({minValue: 0, maxValue: 5})
  @editor({
    description:
      'Seconds to stand still after each pickup before chasing the next ' +
      'target. 0 or unset means the 1 s default (a template instance ' +
      'zero-inits this, so 0 cannot opt out here — use Never pause instead). ' +
      'Read when the behavior starts; edits apply on restart.',
  })
  postPickupDwellSec: number = 1.0;

  @property()
  @editor({label: 'Never pause', description: 'Skip the post-pickup dwell and chase the next target at once.'})
  disablePostPickupDwell: boolean = false;

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

  /**
   * Handed to every behavior this starter builds, so the empty-handed
   * diagnostic names its misconfiguration once per actor instead of once per
   * loop cycle. It lives here because a loop resolves its
   * steps to the starter COMPONENTS once and re-calls `startBehavior()` on the
   * same instances, so this component spans the cycles while each behavior does
   * not. Not a `@property` — internal state, never scene-authored.
   */
  private readonly emptyHandedWarningLatch: EmptyHandedWarningLatch = {
    warned: false,
  };

  /**
  /**
   * Give-up memory shared across loop cycles (same lifetime argument as
   * `emptyHandedWarningLatch` above): each behavior seeds from it at start
   * and writes its give-ups back through `giveUpSink`, so a restarted
   * one-shot search does not chase what an earlier cycle already retired. A
   * successful pickup clears it. Not a `@property` — internal state.
   */
  private readonly retiredFromGiveUp: Set<Entity> = new Set<Entity>();

  /**
   * Fruitless-give-up count shared across loop cycles (same lifetime as
   * `retiredFromGiveUp` above): each behavior reads and writes the count
   * through this object, so a looped one-shot search reaches the recovery
   * cap instead of restarting it every cycle. A successful pickup resets it.
   * Not a `@property` — internal state.
   */
  private readonly sharedFruitlessGiveUps: {count: number} = {count: 0};

  /**
   * 'missing' loot with its re-check time (world seconds), handed to every behavior this
   * starter builds so loop cycles skip merely-empty containers for a while
   * instead of burning every cycle on them. Same ownership story as above.
   */
  private readonly missingLootCooldowns: Map<Entity, number> = new Map<Entity, number>();

  /**
   * Retryable-refusal reasons already warned about, handed to every behavior
   * this starter builds so a looped actor names each once instead of once per
   * cycle. Same ownership story as the latch above.
   */
  private readonly warnedTakeRefusals: Set<string> = new Set<string>();

  protected override locomotionStarterName(): string {
    return 'StarterSearchAndPickupComponent';
  }

  override startBehavior(): SearchAndPickupBehavior | void {
    if (!this.controlledActor) {
      console.warn('StarterSearchAndPickupComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.warn('StarterSearchAndPickupComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    if (!this.targetTags || this.targetTags.length === 0) {
      console.warn('StarterSearchAndPickupComponent: No targetTags specified!');
      return;
    }

    const behavior = new SearchAndPickupBehavior();
    behavior.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    behavior.pickupRange = this.pickupRange;
    behavior.followSpeed = this.followSpeed;
    behavior.pickupSlot = this.resolveHandSlot(
      this.pickupSlot,
      'StarterSearchAndPickupComponent',
    );
    behavior.persistent = this.persistent;
    behavior.startDelay = this.startDelay;
    behavior.postPickupDwellSec = this.disablePostPickupDwell
      ? 0
      : this.postPickupDwellSec > 0
        ? this.postPickupDwellSec
        : 1.0;
    behavior.searchViewAngleDeg = this.searchViewAngleDeg;
    behavior.excludedTags = this.excludedTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    behavior.candidateFilterKey = this.candidateFilterKey.trim();
    behavior.giveUpSeconds = Math.max(0, this.giveUpSeconds);
    behavior.basePriority = BehaviorStarterComponent.resolvePriority(this.basePriority, 20);
    behavior.emptyHandedWarningLatch = this.emptyHandedWarningLatch;
    behavior.giveUpSink = this.retiredFromGiveUp;
    behavior.fruitlessCounter = this.sharedFruitlessGiveUps;
    behavior.missingLootCooldowns = this.missingLootCooldowns;
    behavior.warnedTakeRefusals = this.warnedTakeRefusals;

    // Registered, not just added: notifyExternalTake forwards through the
    // running handle, which only registerBehavior records.
    this.registerBehavior(actorLogic, behavior);
    // No give-ups, no memory: with the timer off there is nothing to retire,
    // so seeding would only exclude targets that can never be forgiven.
    if (this.giveUpSeconds > 0) {
      behavior.seedRetired(this.retiredFromGiveUp);
    }
    return behavior;
  }

  /**
   * Demo drivers call this when the actor takes out of band — e.g. Station 18's
   * proximity-container takes, which never pass through the hand slot. Forwards
   * to the running behavior's pause (no-op when none is running).
   */
  public notifyExternalTake(): void {
    this.pushToRunning<SearchAndPickupBehavior>(behavior => behavior.notifyExternalTake());
  }
}
