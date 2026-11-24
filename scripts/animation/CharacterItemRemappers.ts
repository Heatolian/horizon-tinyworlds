/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v9

import {Component, component, editor, property, serializable, type Maybe, type RemapPageAsset} from 'meta/worlds';

/** One of this character's remap pages, played instead of the page of any held item with `animKey`. */
@serializable()
export class CharacterItemRemapper {
  @property()
  public readonly animKey: string = '';

  @property()
  public readonly remapper: Maybe<RemapPageAsset> = null;
}

/**
 * This character's own remap pages for held items. An item's page is authored
 * for the stock mannequin and cannot know who holds it, so a remixed character
 * lists pages retargeted to its own rig here, by `animKey`, and
 * `EquipmentAnimationModule` pushes those instead. A key with no entry plays the
 * item's page.
 *
 * Component Attachment: the character root, beside `CharacterAnimationController`.
 * Component Networking: none; every machine reads the authored list.
 */
@component({
  description: 'This character\'s remap pages for held items, by animKey, played instead of the items\' own pages.',
})
export class CharacterItemRemappers extends Component {
  @editor({
    description:
      'Per animKey (pistol, rifle, sword), the page to play instead of the held item\'s. ' +
      'Replace these when remixing the character.',
  })
  @property()
  public remappers: ReadonlyArray<CharacterItemRemapper> = [];

  /** This character's page for `animKey`, or null to play the item's. */
  remapperFor(animKey: string): RemapPageAsset | null {
    return this.remappers.find(entry => entry.animKey === animKey && entry.remapper != null)?.remapper ?? null;
  }
}
