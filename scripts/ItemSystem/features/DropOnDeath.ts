/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v4

import {
  Component,
  component,
  editor,
  ExecuteOn,
  NetworkingService,
  NetworkMode,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  property,
  subscribe,
  TransformComponent,
  WorldService,
  type Entity,
  type Maybe,
  type TemplateAsset,
} from 'meta/worlds';
import {DEAD_TAG} from '../../Character/gas/CharacterTags';
import {GASComponent} from '../../gas/core/GASComponent';
import {containersIn, ItemContainer, ownerOfContainersIn} from '../container/ItemContainer';

/**
 * When the character these containers belong to dies, moves every item into a
 * bag spawned where it died, so others can search it. Server only; the death
 * is the character's `deathTag` GAS tag, which replicates from the owner.
 *
 * Component Attachment: the entity holding the containers: a player's
 * container entity (`PlayerContainers.hstf`), or an NPC with
 * `ownedByCharacter` containers.
 */
@component({
  description: 'Server: when the owning character dies, moves all of these containers\' items into a spawned bag (searchable loot).',
})
export class DropOnDeath extends Component {
  @editor({description: 'Loot to spawn on death: an ItemContainer on its root (e.g. Templates/GameContent/DeathBag.hstf).'})
  @property()
  public bagTemplate: Maybe<TemplateAsset> = null;

  @editor({description: 'GAS tag that means the character died.'})
  @property()
  public deathTag: string = DEAD_TAG;

  /** The bag this death produced, once spawned (replicated, e.g. for a map marker). */
  @editor({show: false})
  @property()
  public bag: Maybe<Entity> = null;

  private watching: Entity | null = null;
  private unsubscribe: (() => void) | null = null;
  private dropped = false;

  /** Polls because a player's containers get their owner after spawning. */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(): void {
    if (this.watching != null || this.dropped || !NetworkingService.get().isServerContext()) {
      return;
    }
    const character = ownerOfContainersIn(this.entity);
    const gas = character?.getComponent(GASComponent) ?? null;
    if (character == null || gas == null) {
      return;
    }
    this.watching = character;
    this.unsubscribe = gas.onTagAdded(tag => {
      if (tag === this.deathTag) {
        this.drop(character);
      }
    });
    if (gas.hasTag(this.deathTag)) {
      this.drop(character);
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private drop(character: Entity): void {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const sources = containersIn(this.entity);
    const items = sources.reduce((sum, container) => sum + container.slots().filter(slot => slot != null).length, 0);
    const template = this.bagTemplate ?? null;
    if (items === 0 || template == null) {
      if (template == null) {
        console.warn(`[DropOnDeath] '${String(this.entity.name)}' has no bagTemplate; items stay where they are.`);
      }
      return;
    }
    WorldService.get()
      .spawnTemplate({
        templateAsset: template,
        networkMode: NetworkMode.Networked,
        position: character.getComponent(TransformComponent)?.worldPosition ?? null,
        rotation: null,
        scale: null,
      })
      .then(bag => this.fill(bag, sources, items))
      .catch((error: unknown) => {
        console.warn(`[DropOnDeath] failed to spawn the bag for '${String(character.name)}'.`, error);
      });
  }

  private fill(bag: Entity, sources: readonly ItemContainer[], items: number): void {
    const target = containersIn(bag)[0] ?? null;
    if (target == null || !target.setSlotCount(items)) {
      console.warn('[DropOnDeath] the bag template needs an ItemContainer on its root.');
      bag.destroy();
      return;
    }
    target.spawnedAtRuntime = true;
    for (const source of sources) {
      for (let index = 0; index < source.slotCount; index++) {
        if (source.getSlot(index) != null) {
          ItemContainer.transferToAny(source, index, target);
        }
      }
    }
    if (target.count(() => true) === 0) {
      bag.destroy();
      return;
    }
    this.bag = bag;
  }
}
