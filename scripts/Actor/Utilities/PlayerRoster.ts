/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  OnWorldUpdateEvent,
  PlayerService,
  service,
  Service,
  subscribe,
  TransformComponent,
  type Entity,
  type Vec3,
} from 'meta/worlds';
import {findCharacterGAS} from '../../Character/gas/CharacterGASComponent';

/** Which players a nearest-player query accepts beyond the standard filters. Keep one per caller: a query allocates nothing. */
export interface NearestPlayerOptions {
  /** A dead player (GAS `state.dead`) counts too. Off by default: a corpse is not a player to look at, follow or lead. */
  readonly includeDead?: boolean;
  /** Measure across the ground only, ignoring height. */
  readonly horizontal?: boolean;
  /** Extra veto, checked after the standard filters. */
  readonly filter?: ((player: Entity) => boolean) | null;
}

const STANDARD: NearestPlayerOptions = {};
const NO_PLAYERS: readonly Entity[] = [];

/**
 * The players, for actors: one place that reads the player list and applies
 * the filters every caller needs. A player counts when it is valid, is not
 * the asking actor (bot players are in the player list) and, unless the
 * caller opts in, is alive. Actor code asks here instead of looping over
 * `PlayerService.getAllPlayers()` itself, so the filters cannot drift apart.
 *
 * The list is read once per frame, however many actors ask (each read
 * allocates a new array). The frame count advances on world update, so a
 * join or leave is seen at most a frame late; positions are read live. Until
 * the first world update (unit tests deliver none) every query reads the list
 * afresh.
 *
 * Reach it with `PlayerRoster.get()`; do not cache the handle.
 */
@service()
export class PlayerRoster extends Service {
  private frame = 0;
  private listFrame = -1;
  private list: readonly Entity[] = NO_PLAYERS;

  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(): void {
    this.frame++;
  }

  /** Every player this frame, unfiltered. Do not keep or modify the array. */
  players(): readonly Entity[] {
    if (this.frame === 0 || this.listFrame !== this.frame) {
      this.list = PlayerService.get().getAllPlayers();
      this.listFrame = this.frame;
    }
    return this.list;
  }

  /**
   * The player nearest `from` that the standard filters and `options` accept,
   * nearer than `maxDistance` (m), or null. `self` is never returned.
   */
  nearest(
    from: Vec3,
    self: Entity | null,
    maxDistance: number = Number.POSITIVE_INFINITY,
    options: NearestPlayerOptions = STANDARD,
  ): Entity | null {
    let nearest: Entity | null = null;
    let nearestDistance = maxDistance;
    for (const player of this.players()) {
      if (player == null || !player.valid || player === self) {
        continue;
      }
      if (!options.includeDead && (findCharacterGAS(player)?.isDead ?? false)) {
        continue;
      }
      if (options.filter != null && !options.filter(player)) {
        continue;
      }
      const at = player.getComponent(TransformComponent)?.worldPosition;
      if (at == null) {
        continue;
      }
      const dx = at.x - from.x;
      const dz = at.z - from.z;
      const dy = options.horizontal ? 0 : at.y - from.y;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = player;
      }
    }
    return nearest;
  }
}
