/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v25

/**
 * SimpleInteractableToggle -- an on/off switch for an interactable object:
 * each interaction flips the state for every player and turns a pivot between
 * its off and on rotations. A lever, a door, a valve, a hatch.
 *
 * Copy one of the example templates rather than assembling the object by hand:
 *
 * - `Templates/Interaction/InteractableLever.hstf`: a lever whose handle tilts.
 * - `Templates/Interaction/InteractableDoor.hstf`: a door that swings 90 degrees
 *   on its hinge and blocks the player while closed.
 *
 * Both carry the full interaction stack, already wired and verified against the
 * install rules in `scripts/Interaction/README.md`: the sensor child, the
 * prompt and highlight, and this component. To make a new interactable, copy the
 * closer template, swap its meshes, and set `onRotation`. To react to the switch
 * from game code, call `addListener` (see the README).
 *
 * Networking: the interaction arrives only on the interacting player's client,
 * so this sends `RpcToggle` to the object's owner (the server for a placed
 * object), which flips the replicated `on`. The object root must be networked
 * (`NetworkableTemplateEntityAttribute` with `isNetworkable: true` in the
 * template, as both examples have); a local-only root has no owner to receive
 * the RPC, so the toggle flips locally instead, for this player only, and warns
 * once. The pivot is a plain (local-only) child in both examples, so every
 * machine turns its own copy when it sees `on` change; if the pivot is itself
 * networked, only its owner turns it and the transform replicates (writing a
 * transform needs ownership). Every machine, the server included, calls
 * listeners when it sees `on` change.
 *
 * Component Attachment: the object root, alongside
 * `SimpleInteractablePromptComponent`, with an `InteractionTargetComponent` on a
 * sensor child below it.
 */

import {
  Component,
  component,
  editor,
  type Entity,
  ExecuteOn,
  isMyInteractionTarget,
  type Maybe,
  OnEntityStartEvent,
  OnInteractionEvent,
  type OnInteractionEventPayload,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  property,
  Quaternion,
  rpc,
  subscribe,
  TransformComponent,
  Vec3,
} from 'meta/worlds';

/** Called with the new state whenever the switch flips. */
export type ToggleListener = (on: boolean) => void;

@component({
  description:
    'On/off switch for an interactable (lever, door): each interaction flips a replicated state and turns a pivot between its authored rotation and onRotation. Copy Templates/Interaction/InteractableLever.hstf or InteractableDoor.hstf.',
})
export class SimpleInteractableToggle extends Component {
  @editor({
    description:
      'Entity to turn: the lever handle or door hinge. Its authored rotation is the off rotation.',
  })
  @property()
  pivot: Maybe<Entity> = null;

  @editor({
    description:
      "The pivot's local rotation when on, in degrees (X, Y, Z). A door hinge uses (0, 90, 0).",
  })
  @property()
  onRotation: Vec3 = new Vec3(0, 90, 0);

  @editor({description: 'Seconds to turn between off and on. 0 snaps.'})
  @property({minValue: 0})
  turnSeconds: number = 0.4;

  @editor({description: 'State when the world starts. Replicated: the owner writes it.'})
  @property({isNetworked: true})
  on: boolean = false;

  private pivotTransform: Maybe<TransformComponent> = null;
  private offRotationQ: Quaternion = Quaternion.identity;
  private onRotationQ: Quaternion = Quaternion.identity;
  /** 0 = at the off rotation, 1 = at the on rotation. */
  private turned = 0;
  private lastSeenOn = false;
  private listeners: ToggleListener[] = [];
  private warnedLocalOnly = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    this.lastSeenOn = this.on;
    this.pivotTransform = this.pivot?.getComponent(TransformComponent) ?? null;
    if (this.pivotTransform == null) {
      console.warn(`[SimpleInteractableToggle] ${this.entity.name}: set pivot to the entity to turn.`);
      return;
    }
    this.offRotationQ = this.pivotTransform.localRotation;
    this.onRotationQ = Quaternion.fromEuler(this.onRotation);
    this.turned = this.on ? 1 : 0;
    if (this.on && this.pivot?.isOwned() === true) {
      this.pivotTransform.localRotation = this.onRotationQ;
    }
  }

  /** Flip the switch from game code, on any machine. */
  public toggle(): void {
    this.requestToggle();
  }

  /**
   * Call `listener` with the new state each time the switch flips, on every
   * machine (the server and each client). Gate shared changes on
   * `NetworkingService.get().isServerContext()`. Returns an unsubscribe function.
   */
  public addListener(listener: ToggleListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) {
        this.listeners.splice(at, 1);
      }
    };
  }

  // PascalCase is the @rpc naming idiom across this world.
  @rpc({execution: ExecuteOn.Owner})
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcToggle(): void {
    this.on = !this.on;
  }

  @subscribe(OnInteractionEvent, {execution: ExecuteOn.Everywhere})
  private onInteract(payload: OnInteractionEventPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) {
      return;
    }
    this.requestToggle();
  }

  private requestToggle(): void {
    if (this.entity.networked) {
      this.RpcToggle();
      return;
    }
    if (!this.warnedLocalOnly) {
      this.warnedLocalOnly = true;
      console.warn(
        `[SimpleInteractableToggle] ${this.entity.name} is not networked, so it toggles for this player only. ` +
          'Give the object root NetworkableTemplateEntityAttribute { isNetworkable: true }, as the Templates/Interaction examples do.',
      );
    }
    this.on = !this.on;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.on !== this.lastSeenOn) {
      this.lastSeenOn = this.on;
      for (const listener of this.listeners.slice()) {
        listener(this.on);
      }
    }
    const transform = this.pivotTransform;
    const target = this.on ? 1 : 0;
    if (transform == null || this.turned === target || this.pivot?.isOwned() !== true) {
      return;
    }
    const step = this.turnSeconds > 0 ? payload.deltaTime / this.turnSeconds : 1;
    this.turned =
      target > this.turned ? Math.min(this.turned + step, 1) : Math.max(this.turned - step, 0);
    // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- one Quaternion per frame, only while the pivot is turning
    transform.localRotation = Quaternion.slerp(this.offRotationQ, this.onRotationQ, this.turned);
  }
}
