/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v13

import {Component, component, ExecuteOn, OnEntityDestroyEvent, OnEntityStartEvent, subscribe} from 'meta/worlds';
import {ShootingTickets} from './ShootingTickets';

/** Rations NPC hits on this entity with shooting tickets, as on a player ({@link ShootingTickets}). */
@component({
  description:
    'Paces NPC hits on this entity the way they are paced on players: only a few NPCs at a time may land hits, and the rest fire close misses. For an escort, an ally or a test dummy.',
})
export class ShootingTicketTargetComponent extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    ShootingTickets.get().markTarget(this.entity);
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    ShootingTickets.get().unmarkTarget(this.entity);
  }
}
