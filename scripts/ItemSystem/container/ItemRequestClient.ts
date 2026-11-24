/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import {Component, component, ExecuteOn, OnEntityDestroyEvent, rpc, subscribe} from 'meta/worlds';
// A value import: the SDK builds a serializable args class for `@rpc` that constructs `ItemResult` at runtime.
import {ItemResult, type ItemRequest} from './ItemRequest';

/** The server end a client talks to: the `ItemRequestServer` on its container entity. */
export interface ItemRequestDoor {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcRequest(token: string, id: number, request: ItemRequest): void;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcRequestToken(): void;
}

/** A request this client sent and has no answer for yet. */
interface Waiting {
  readonly request: ItemRequest;
  /** Looked up at each send: the container entity can be replaced while a request waits. */
  readonly findDoor: () => ItemRequestDoor | null;
  readonly resolve: (result: ItemResult) => void;
  /** The token it last went out with; '' while it waits for one. */
  sentWith: string;
}

/**
 * The player's side of the request channel. Holds the private token the
 * server gives only to this character's owner, sends every request with it and
 * a number of its own, and resolves the request's promise when the server
 * answers that number.
 *
 * Every request is answered once:
 * - The server answers each request it accepts, a failed one included.
 * - A request sent with a stale token gets no answer of its own (one would let
 *   a client that forges requests make this one resend real ones). The server
 *   sends its token instead, and whatever went out with another token goes out
 *   again with this one.
 * - Requests sent before any token wait here and go out, in order, once it
 *   arrives. The client asks for it once; the server also sends it by itself
 *   as soon as these containers have an owner.
 * - When this component goes away, whatever still waits resolves `lost`.
 *
 * Component Attachment: the player character root or a child of it (e.g. an
 * `ItemSystem` child). NPCs do not need it.
 */
@component({
  description: 'Receives the private request token for this player, sends their item requests to the server and hands back its answers.',
})
export class ItemRequestClient extends Component {
  private token = '';
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private askedForToken = false;

  /** Sent by the server to this character's owner only. */
  @rpc()
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcReceiveToken(token: string): void {
    this.receiveToken(token);
  }

  /** Sent by the server to this character's owner only: what request `id` did. */
  @rpc()
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcResult(id: number, result: ItemResult): void {
    this.receiveResult(id, result);
  }

  /** Sends `request` through the door `findDoor` finds, and resolves with the server's answer. */
  send(request: ItemRequest, findDoor: () => ItemRequestDoor | null): Promise<ItemResult> {
    return new Promise<ItemResult>(resolve => {
      const id = this.nextId++;
      const entry: Waiting = {request, findDoor, resolve, sentWith: ''};
      this.waiting.set(id, entry);
      this.dispatch(id, entry);
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    const unanswered = [...this.waiting.values()];
    this.waiting.clear();
    for (const entry of unanswered) {
      entry.resolve(ItemResult.refused('lost'));
    }
  }

  private receiveToken(token: string): void {
    this.token = token;
    for (const [id, entry] of [...this.waiting]) {
      if (entry.sentWith !== token) {
        this.dispatch(id, entry);
      }
    }
  }

  private receiveResult(id: number, result: ItemResult): void {
    const entry = this.waiting.get(id);
    // Already answered, or a number this client never sent.
    if (entry == null) {
      return;
    }
    this.waiting.delete(id);
    entry.resolve(result);
  }

  private dispatch(id: number, entry: Waiting): void {
    const door = entry.findDoor();
    if (door == null) {
      console.warn(
        `[ItemRequestClient] '${String(this.entity.name)}' has no container entity with an ItemRequestServer to send its '${entry.request.kind}' request to.`,
      );
      this.waiting.delete(id);
      entry.resolve(ItemResult.refused('lost'));
      return;
    }
    if (this.token === '') {
      this.askForToken(door);
      return;
    }
    entry.sentWith = this.token;
    door.RpcRequest(this.token, id, entry.request);
  }

  private askForToken(door: ItemRequestDoor): void {
    if (!this.askedForToken) {
      this.askedForToken = true;
      door.RpcRequestToken();
    }
  }
}
