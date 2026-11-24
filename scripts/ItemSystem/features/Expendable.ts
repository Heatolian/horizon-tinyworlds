/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import {ItemResult, registerItemRequestHandler, type ItemRequestContext} from '../container/ItemRequest';
import {ItemFragment, itemRegistry} from '../items/ItemDefinition';

/**
 * Each shot of this weapon spends one of its stack: grenades, molotovs, throwing
 * knives. Throwing the last one empties the hand. Give the item a `Stackable`
 * beside it, or it holds a single shot.
 */
export class Expendable extends ItemFragment {}

/** Server: spend one of the character's stack `uid`, if it really is expendable. `amount` 1 when spent. */
function expend({request, findStack}: ItemRequestContext): ItemResult {
  const found = findStack(request.uid);
  if (found == null) {
    return ItemResult.refused('missing');
  }
  if (itemRegistry.get(found.stack.defId)?.find(Expendable) == null) {
    return ItemResult.refused('invalid');
  }
  return ItemResult.done(found.container.removeItems(stack => stack.uid === request.uid, 1));
}

registerItemRequestHandler('expend', expend);
