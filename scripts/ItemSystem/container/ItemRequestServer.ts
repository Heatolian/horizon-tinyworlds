/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import {Component, component, NetworkingService, rpc, type Entity} from 'meta/worlds';
import {containerRegistry, ownerOfContainersIn, type ItemContainer} from './ItemContainer';
// A value import: the SDK builds a serializable args class for `@rpc` that constructs `ItemRequest` at runtime.
import {ItemRequest, ItemResult} from './ItemRequest';
import {findOnCharacter} from './CharacterLookup';
import {ItemRequestClient} from './ItemRequestClient';
import {runItemRequest} from './RequestHandlers';

function newToken(): string {
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * The only network entry point of the item system. Lives on a player's
 * server-owned container entity, so `RpcRequest` runs on the server. RPCs
 * carry no caller identity, so the server hands the owner of these containers a
 * private token (through an RPC on their own character, which only their
 * client executes) and accepts only requests that carry it. Accepted requests
 * run as the owner through `runItemRequest`, and the result goes back the same
 * way, to the `ItemRequestClient` that holds the token, under the number it
 * gave the request. A request with a stale token gets no answer: the owner's
 * client gets the token instead, and resends what it sent with another one.
 *
 * Each `ItemRequestClient` gets a token of its own, once (RPCs are reliable).
 * After that, a stale request or an ask from that client means the token is
 * still on its way, so nothing a client sends, forged or not, makes the server
 * send it again. Another owner's client, or the same character's replaced one,
 * gets a new token at once, and the old one stops passing: an accepted request
 * comes from the client its answer goes to.
 *
 * Component Attachment: the root of a player's container entity; its
 * `ItemContainer`s sit on child entities, one each.
 * Ground loot, chests, shops and NPCs do not need it.
 */
@component({
  description: 'The item system\'s single network entry point: token-checked item requests from the owner of these containers.',
})
export class ItemRequestServer extends Component {
  /** Server memory only; never a replicated property. */
  private token = '';
  /** The client the token has gone to; see the class comment. */
  private tokenSentTo: ItemRequestClient | null = null;

  @rpc()
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcRequest(token: string, id: number, request: ItemRequest): void {
    this.handleRequest(token, id, request);
  }

  /** Any client may ask; the token still only goes to the owner's client, once. */
  @rpc()
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcRequestToken(): void {
    this.issueToken();
  }

  /** Server: give the owner their token, unless their client already has it or it is on its way. Called once the containers have an owner. */
  issueToken(): void {
    const owner = this.owner();
    if (NetworkingService.get().isServerContext() && owner != null) {
      this.deliverToken(owner);
    }
  }

  private handleRequest(token: string, id: number, request: ItemRequest): void {
    const owner = this.owner();
    if (!NetworkingService.get().isServerContext() || owner == null) {
      return;
    }
    const client = this.tokenSentTo;
    if (client == null || token !== this.token) {
      // Stale or forged: drop it. The owner's client resends it once it has the token.
      this.deliverToken(owner);
      return;
    }
    void runItemRequest(owner, request).then(result => answer(client, id, result));
  }

  private owner(): Entity | null {
    return ownerOfContainersIn(this.entity);
  }

  private deliverToken(owner: Entity): void {
    const client = findOnCharacter(owner, ItemRequestClient);
    // With no client yet nothing goes out; the client asks once it sends.
    if (client == null || client === this.tokenSentTo) {
      return;
    }
    this.token = newToken();
    this.tokenSentTo = client;
    client.RpcReceiveToken(this.token);
  }
}

/**
 * Sends what request `id` did to the client that sent it. A client that has
 * gone away gets nothing: it resolved what it still waited for as `lost`.
 */
function answer(client: ItemRequestClient, id: number, result: ItemResult): void {
  if (client.entity.isDestroyed()) {
    return;
  }
  client.RpcResult(id, result);
}

/** The `ItemRequestServer` on a container's entity or one of its ancestors (containers sit on child entities). */
function doorFor(container: ItemContainer): ItemRequestServer | null {
  for (const entity of [container.entity, ...container.entity.getAncestors()]) {
    const door = entity.getComponent(ItemRequestServer);
    if (door != null) {
      return door;
    }
  }
  return null;
}

/**
 * Sends a request about `character`'s items and resolves with what the server
 * did. On the server (NPCs) it runs directly, before this returns; on a client
 * it goes through the character's `ItemRequestClient` to the
 * `ItemRequestServer` on its container entity, and resolves when the answer
 * comes back. Never rejects.
 */
export function sendItemRequest(character: Entity, request: ItemRequest): Promise<ItemResult> {
  if (NetworkingService.get().isServerContext()) {
    return runItemRequest(character, request);
  }
  const client = findOnCharacter(character, ItemRequestClient);
  if (client == null) {
    console.warn(`[ItemRequestServer] '${String(character.name)}' needs an ItemRequestClient to send item requests.`);
    return Promise.resolve(ItemResult.refused('lost'));
  }
  return client.send(
    request,
    () =>
      containerRegistry
        .all(character)
        .map(doorFor)
        .find(candidate => candidate != null) ?? null,
  );
}
