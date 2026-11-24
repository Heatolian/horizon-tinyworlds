/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v14

import {
  Component,
  component,
  editor,
  ExecuteOn,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  property,
  subscribe,
  subscribePropertyChange,
} from 'meta/worlds';
import {DEFAULT_SHOOTING_TICKET_SETTINGS, ShootingTickets, type ShootingTicketSettings} from './ShootingTickets';

/** The component's knobs as authored. */
export interface ShootingTicketSettingsValues {
  pacingOff: boolean;
  ticketsPerTarget: number;
  ticketSeconds: number;
  grantIntervalSeconds: number;
  shooterCooldownSeconds: number;
  nearMissMeters: number;
}

/**
 * The settings the knobs stand for. A template instance zero-inits every
 * property its delta leaves out, so false and 0 mean the default: the switch
 * turns pacing off, and a knob at 0 (or below, or not a number) keeps its
 * default.
 */
export function effectiveShootingTicketSettings(values: ShootingTicketSettingsValues): ShootingTicketSettings {
  const d = DEFAULT_SHOOTING_TICKET_SETTINGS;
  return {
    enabled: !values.pacingOff,
    ticketsPerTarget: positiveOr(values.ticketsPerTarget, d.ticketsPerTarget),
    ticketSeconds: positiveOr(values.ticketSeconds, d.ticketSeconds),
    grantIntervalSeconds: positiveOr(values.grantIntervalSeconds, d.grantIntervalSeconds),
    shooterCooldownSeconds: positiveOr(values.shooterCooldownSeconds, d.shooterCooldownSeconds),
    nearMissMeters: positiveOr(values.nearMissMeters, d.nearMissMeters),
  };
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Tunes shooting tickets ({@link ShootingTickets}) for the whole world. One
 * is enough; without one the defaults below apply. With several, the last to
 * start or change wins; removing it hands over to the one applied most
 * recently, and removing the last restores the defaults (the service keeps
 * that order: {@link ShootingTickets.applySettings}). A knob a template
 * instance leaves at 0 keeps its default ({@link effectiveShootingTicketSettings}).
 */
@component({
  description:
    'Paces how often NPC shooters land hits on each player: a few shooters at a time fire shots that can hit, each for a short turn, and the rest fire close misses, so the player has time to react and reach cover. Turns are counted as shots leave, so a slow projectile lands its hit its flight time later. Place one in the world to tune it; without one these defaults apply.',
})
export class ShootingTicketSettingsComponent extends Component {
  @property()
  @editor({label: 'Turn off hit pacing', description: 'On: every NPC shot may hit, however many NPCs fire at once.'})
  pacingOff: boolean = false;

  @property({minValue: 1, maxValue: 8})
  @editor({label: 'Shooters on target at once', description: 'How many NPCs may fire shots that can hit one player at the same time, counted as their shots leave. 0 keeps the default.'})
  ticketsPerTarget: number = 2;

  @property({minValue: 0.1, maxValue: 3})
  @editor({label: 'Turn length (s)', description: 'Seconds the shots of an NPC may hit once its turn starts, from the first shot of the turn leaving. 0 keeps the default.'})
  ticketSeconds: number = 0.5;

  @property({minValue: 0.05, maxValue: 2})
  @editor({label: 'Turn spacing (s)', description: 'Least seconds between two NPCs getting a turn on the same player, so hits arrive spaced out rather than together. 0 keeps the default.'})
  grantIntervalSeconds: number = 0.25;

  @property({minValue: 0.1, maxValue: 5})
  @editor({label: 'Rest between turns (s)', description: 'Seconds an NPC waits after its turn before it may have another, so turns rotate between NPCs. 0 keeps the default.'})
  shooterCooldownSeconds: number = 1.0;

  @property({minValue: 0.3, maxValue: 3})
  @editor({label: 'Miss distance (m)', description: 'How far beside the player an NPC without a turn aims, so its shots visibly fly past. 0 keeps the default.'})
  nearMissMeters: number = 1.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    this.apply();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    ShootingTickets.get().withdrawSettings(this);
  }

  @subscribePropertyChange('pacingOff')
  private onPacingOffChanged(): void {
    this.apply();
  }

  @subscribePropertyChange('ticketsPerTarget')
  private onTicketsPerTargetChanged(): void {
    this.apply();
  }

  @subscribePropertyChange('ticketSeconds')
  private onTicketSecondsChanged(): void {
    this.apply();
  }

  @subscribePropertyChange('grantIntervalSeconds')
  private onGrantIntervalSecondsChanged(): void {
    this.apply();
  }

  @subscribePropertyChange('shooterCooldownSeconds')
  private onShooterCooldownSecondsChanged(): void {
    this.apply();
  }

  @subscribePropertyChange('nearMissMeters')
  private onNearMissMetersChanged(): void {
    this.apply();
  }

  private apply(): void {
    ShootingTickets.get().applySettings(this, effectiveShootingTicketSettings(this));
  }
}
