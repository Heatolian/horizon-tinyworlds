/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {
  Component,
  component,
  editor,
  ExecuteOn,
  NetworkingService,
  NetworkMode,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnPlayerDestroyEvent,
  PlayerService,
  property,
  subscribe,
  WorldService,
  type Entity,
  type Maybe,
  type OnPlayerCreateEventPayload,
  type OnPlayerDestroyEventPayload,
  type TemplateAsset,
} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {allOnCharacter} from '../container/CharacterLookup';
import {containersIn} from '../container/ItemContainer';
import {ItemRequestClient} from '../container/ItemRequestClient';
import {ItemRequestServer} from '../container/ItemRequestServer';
import {EquipmentBinder} from '../equipment/EquipmentBinder';
import {ContainerAssignments} from './ContainerAssignments';

/** What the player character needs for items to work, on its root or a child; a missing one fails silently otherwise. */
const PLAYER_REQUIREMENTS: ReadonlyArray<{name: string; count: (player: Entity) => number}> = [
  {name: 'GASComponent', count: player => (player.getComponent(GASComponent) != null ? 1 : 0)},
  {name: 'EquipmentBinder', count: player => allOnCharacter(player, EquipmentBinder).length},
  {name: 'ItemRequestClient', count: player => allOnCharacter(player, ItemRequestClient).length},
];

function reportPlayerComponents(player: Entity): void {
  const counts = PLAYER_REQUIREMENTS.map(requirement => ({name: requirement.name, count: requirement.count(player)}));
  const missing = counts.filter(c => c.count === 0).map(c => c.name);
  const duplicated = counts.filter(c => c.count > 1).map(c => c.name);
  if (missing.length > 0) {
    console.warn(
      `[PlayerContainersSpawner] player '${String(player.name)}' is missing ${missing.join(', ')}: items will not equip or requests will not send.`,
    );
  }
  if (duplicated.length > 0) {
    console.warn(`[PlayerContainersSpawner] player '${String(player.name)}' has more than one ${duplicated.join(', ')}; only the first is used.`);
  }
}

/**
 * Gives every player a server-owned container entity holding their
 * containers (loadout, backpack, ...). A player's character is owned by their
 * client, so the server cannot write containers on it; the template's
 * containers point back at the player through `ownerCharacter`, and the
 * character's `EquipmentBinder` finds them through `containerRegistry`. The
 * starting kit is the template's `initialItems`. The template is game content
 * (this world's: `Templates/GameContent/PlayerContainers.hstf`), so there is no default.
 *
 * Component Attachment: one scene entity owned by the server.
 */
@component({
  description:
    'Spawns a server-owned entity holding each player\'s containers (loadout, backpack) and removes it when they leave.',
})
export class PlayerContainersSpawner extends Component {
  @editor({
    description:
      'Required. Template whose ItemContainers become each player\'s containers, e.g. Templates/GameContent/PlayerContainers.hstf. Its NetworkSettings must not be attainable.',
  })
  @property()
  public containersTemplate: Maybe<TemplateAsset> = null;

  private readonly assignments = new ContainerAssignments<Entity, Entity>();
  private missingTemplateReported = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    if (!NetworkingService.get().isServerContext()) {
      return;
    }
    for (const player of PlayerService.get().getAllPlayers()) {
      this.provide(player);
    }
  }

  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (payload.entity != null && NetworkingService.get().isServerContext()) {
      this.provide(payload.entity);
    }
  }

  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (payload.entity == null || !NetworkingService.get().isServerContext()) {
      return;
    }
    destroyIfAlive(this.assignments.release(payload.entity));
  }

  private provide(player: Entity): void {
    const template = this.containersTemplate ?? null;
    if (template == null) {
      if (!this.missingTemplateReported) {
        this.missingTemplateReported = true;
        console.error('[PlayerContainersSpawner] containersTemplate is not set; players get no containers.');
      }
      return;
    }
    if (!this.assignments.claim(player)) {
      return;
    }
    WorldService.get()
      .spawnTemplate({
        templateAsset: template,
        networkMode: NetworkMode.Networked,
        position: null,
        rotation: null,
        scale: null,
      })
      .then(holder => {
        if (!player.valid || !this.assignments.fulfil(player, holder)) {
          this.assignments.release(player);
          destroyIfAlive(holder);
          return;
        }
        const containers = containersIn(holder);
        if (containers.length === 0) {
          console.error('[PlayerContainersSpawner] template has no ItemContainer.');
        }
        for (const container of containers) {
          container.ownerCharacter = player;
        }
        const door = holder.getComponent(ItemRequestServer);
        if (door == null) {
          console.error('[PlayerContainersSpawner] template has no ItemRequestServer; players cannot send item requests.');
        } else {
          door.issueToken();
        }
        reportPlayerComponents(player);
        console.log(
          `[PlayerContainersSpawner] containers for '${String(player.name)}': ${containers.map(c => c.role).join(', ')}`,
        );
      })
      .catch((error: unknown) => {
        this.assignments.abandon(player);
        console.error(`[PlayerContainersSpawner] failed to spawn containers for '${String(player.name)}'.`, error);
      });
  }
}

function destroyIfAlive(entity: Entity | null): void {
  if (entity != null && entity.valid && !entity.isDestroyed()) {
    entity.destroy();
  }
}
