/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import {
  Component,
  component,
  editor,
  ExecuteOn,
  isMyInteractionTarget,
  OnInteractionEvent,
  property,
  subscribe,
  type Entity,
  type OnInteractionEventPayload,
} from 'meta/worlds';
import {characterOf} from '../container/CharacterLookup';
import {interact} from '../container/ItemCommands';
import {findItemRequestHandler, ItemResult, registerItemRequestHandler, type ItemRequestContext} from '../container/ItemRequest';
import {distanceBetween} from '../container/RequestHandlers';

/** Handles an action on the interacting player's own machine instead of sending a request (e.g. opening a search window). */
export type LocalInteraction = (character: Entity, target: Entity) => void;

const localInteractions = new Map<string, LocalInteraction>();

/** Routes `action` to `handler` on the interacting client; no request is sent for it. Returns an unregister function. */
export function registerLocalInteraction(action: string, handler: LocalInteraction): () => void {
  localInteractions.set(action, handler);
  return () => {
    if (localInteractions.get(action) === handler) {
      localInteractions.delete(action);
    }
  };
}

/**
 * Makes an entity do `action` when a character interacts with it. Pure data
 * plus a client hook: detection, prompt and the button stay with the WSDK
 * interaction target on a child sensor; when the local player interacts, an
 * `interact` request goes through the character's normal request channel.
 * The server checks range and the offered action, then runs the handler
 * registered as `interact.{action}` (e.g. `interact.take`). An action with a
 * `registerLocalInteraction` handler (e.g. `search`, which opens a window)
 * runs on the client instead. This entity has no RPC of its own.
 *
 * NPC AI sends the same request on the server: `interact(npc, target, 'take')`.
 *
 * Component Attachment: the root of a server-owned interactable, with an
 * `InteractionTargetComponent` on a child sensor.
 */
@component({
  description:
    'On interaction, sends an "interact" request; the server checks range and runs the handler registered for this action (e.g. "take").',
})
export class Interactable extends Component {
  @editor({description: 'Action to run; the server looks up the handler "interact.<action>", e.g. "take".'})
  @property()
  public action: string = 'take';

  @editor({description: 'Meters. The server refuses characters farther than this from the entity.'})
  @property({minValue: 0})
  public maxDistance: number = 3;

  @subscribe(OnInteractionEvent, {execution: ExecuteOn.Everywhere})
  private onInteraction(payload: OnInteractionEventPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) {
      return;
    }
    const interactor = payload.interactor;
    if (interactor == null || !interactor.isOwned()) {
      return;
    }
    const character = characterOf(interactor);
    if (character == null || !character.isOwned()) {
      return;
    }
    const local = localInteractions.get(this.action);
    if (local != null) {
      local(character, this.entity);
      return;
    }
    void interact(character, this.entity, this.action);
  }
}

/** Server: when the target offers this action and the character is in range, run `interact.{action}` and return its result. */
function handleInteract(ctx: ItemRequestContext): ItemResult | Promise<ItemResult> {
  const {request, character} = ctx;
  const target = request.other?.valid === true ? request.other : null;
  const interactable = target?.getComponent(Interactable) ?? null;
  if (target == null || interactable == null) {
    return ItemResult.refused('missing');
  }
  if (request.key !== interactable.action) {
    return ItemResult.refused('notAllowed');
  }
  if (distanceBetween(target, character) > interactable.maxDistance) {
    return ItemResult.refused('outOfReach');
  }
  const handler = findItemRequestHandler(`interact.${interactable.action}`);
  if (handler == null) {
    console.warn(`[Interactable] no handler registered for 'interact.${interactable.action}'.`);
    return ItemResult.refused('unhandled');
  }
  return handler(ctx);
}

registerItemRequestHandler('interact', handleInteract);
