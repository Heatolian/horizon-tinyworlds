/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {Component, component, ExecuteOn, OnEntityDestroyEvent, OnEntityStartEvent, subscribe} from 'meta/worlds';
import {itemRegistry} from '../items/ItemDefinition';
import {WorldModel} from '../items/ItemFragments';
import {LocalModel} from './LocalModel';
import {ItemContainer} from './ItemContainer';

const EDITOR_PREVIEW = 'EditorPreview';

/**
 * Shows the `WorldModel` of the first item in this entity's container, locally
 * on every machine, so one loot template serves any item that is dropped.
 *
 * Component Attachment: the root of a loot entity, beside its `ItemContainer`.
 */
@component({
  description: 'Shows the world model of the first item in this entity\'s ItemContainer, locally on every machine.',
})
export class LootVisual extends Component {
  private readonly model = new LocalModel();
  private unsubscribe: (() => void) | null = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    const container = this.entity.getComponent(ItemContainer);
    if (container == null) {
      console.warn(`[LootVisual] '${String(this.entity.name)}' has no ItemContainer.`);
      return;
    }
    // An `EditorPreview` child shows the item while placing loot in the editor; at runtime the container decides.
    for (const preview of this.entity.findChildrenWithName(EDITOR_PREVIEW, false)) {
      preview.enabledSelf = false;
    }
    this.unsubscribe = container.addSlotListener(() => this.refresh(container));
    this.refresh(container);
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.model.dispose();
  }

  private refresh(container: ItemContainer): void {
    const first = container.slots().find(slot => slot != null) ?? null;
    const template = first != null ? (itemRegistry.get(first.defId)?.find(WorldModel)?.template ?? null) : null;
    this.model.show(template, this.entity);
  }
}
