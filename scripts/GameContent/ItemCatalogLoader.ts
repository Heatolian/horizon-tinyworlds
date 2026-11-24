/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v1

import {Component, component} from 'meta/worlds';
import './ItemCatalog';

/**
 * Loads this game's `ItemCatalog` on every machine. The ItemSystem framework
 * never imports game content, so without this component no item is registered
 * and containers skip their `initialItems`.
 *
 * Component Attachment: one scene entity.
 */
@component({
  description: 'Registers this game\'s items (ItemCatalog) on every machine. Attach to one scene entity.',
})
export class ItemCatalogLoader extends Component {}
