/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v14

import {PlayerService, Service, service, TransformComponent, WorldService, type Entity, type Maybe} from 'meta/worlds';

/** Tuning shared by every target's ticket pool. */
export interface ShootingTicketSettings {
  /** Off: every shot may hit, as if there were no tickets. */
  enabled: boolean;
  /** Shooters whose shots may hit one target at the same time, counted as their shots leave. 0: none may. */
  ticketsPerTarget: number;
  /** Seconds a ticket lets its holder's shots hit, from the shot that took it leaving. */
  ticketSeconds: number;
  /** Least seconds between two tickets for one target, so hits arrive spaced rather than together. */
  grantIntervalSeconds: number;
  /** Seconds after a ticket ends before the same shooter may hold one again, so hits rotate between shooters. */
  shooterCooldownSeconds: number;
  /** How far (m) beside its target a ticketless shot is aimed, so it visibly flies past. */
  nearMissMeters: number;
}

export const DEFAULT_SHOOTING_TICKET_SETTINGS: Readonly<ShootingTicketSettings> = {
  enabled: true,
  ticketsPerTarget: 2,
  ticketSeconds: 0.5,
  grantIntervalSeconds: 0.25,
  shooterCooldownSeconds: 1.0,
  nearMissMeters: 1.0,
};

/**
 * A shooter that has not fired at a target for this long (s), or for twice
 * its own time between shots if that is longer, has stopped: when it fires
 * again it joins the back of the line, and the pause is not taken as its
 * pace.
 */
const STALE_MIN_SECONDS = 1.5;
/** A shooter quiet this long (s) is forgotten. */
const FORGET_SECONDS = 10;
/**
 * A free ticket waits for the shooter first in line to fire again: for its
 * own time between shots (this until known, in s), plus
 * {@link OVERDUE_SLACK_SECONDS}. A shooter overdue past that (reloading, lost
 * sight) is passed over for the next. No gap over
 * {@link MAX_RESERVE_SECONDS} is taken as a pace.
 */
const DEFAULT_GAP_SECONDS = 0.5;
const MAX_RESERVE_SECONDS = 3.0;
const OVERDUE_SLACK_SECONDS = 0.1;
/** Shooters within this half-angle (degrees) of a target's facing are in its view, and are served first. */
const VIEW_HALF_ANGLE_DEG = 60;
const VIEW_COS = Math.cos((VIEW_HALF_ANGLE_DEG * Math.PI) / 180);
/** Ancestors walked from a hit collider to the player or marked root it belongs to. */
const ROOT_WALK_MAX_DEPTH = 32;
/** Seconds the player list is reused: every NPC shot asks, and the list allocates. */
const PLAYER_LIST_SECONDS = 0.5;

interface Held {
  shooter: Entity;
  /** World seconds the hit window ends. */
  until: number;
}

/** A shooter firing at the target: its place in line and its pace. */
interface Shooter {
  shooter: Entity;
  /** World seconds the shooter joined the line, which orders it; null while it holds or rests after a ticket. */
  since: number | null;
  lastShot: number;
  /** The shooter's pace: seconds between its shots while it keeps firing; 0 while unknown. */
  gap: number;
  /** How to undo the shooter's latest shot if it never fires ({@link ShootingTickets.releaseShot}). */
  undo: ShotUndo | null;
}

/** What one shot changed, so a shot cancelled before it left can give it back. */
interface ShotUndo {
  lastShot: number;
  gap: number;
  since: number | null;
  /** The pool's latest grant before the shot. */
  lastGrantAt: number;
  lastGrant: Held | null;
  /** The ticket the shot took, if it took one. */
  took: Held | null;
  /** A held ticket the shot stretched to cover its burst, and its end before. */
  stretched: {ticket: Held; until: number} | null;
  /** The shot was the shooter's first at this target. */
  joined: boolean;
}

/** Fired within twice its own pace (or {@link STALE_MIN_SECONDS}), so it keeps its place in line. */
function keepsPlace(s: Shooter, now: number): boolean {
  return now - s.lastShot <= Math.max(STALE_MIN_SECONDS, 2 * s.gap);
}

/** Missed its next shot by its own pace, so a free ticket stops waiting for it. */
function overdue(s: Shooter, now: number): boolean {
  return now - s.lastShot > Math.max(s.gap, DEFAULT_GAP_SECONDS) + OVERDUE_SLACK_SECONDS;
}

/** `value` when finite and positive, else 0. */
export function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

interface Resting {
  shooter: Entity;
  until: number;
  /** The ticket the shooter rests after. */
  after: Held;
}

/** One target's tickets: who holds one, who waits for one, and who just had one. */
class TicketPool {
  held: Held[] = [];
  shooters: Shooter[] = [];
  resting: Resting[] = [];
  /** World seconds the latest ticket's shot left, which spaces the next grant. */
  lastGrantAt: number = Number.NEGATIVE_INFINITY;
  lastGrant: Held | null = null;

  constructor(readonly target: Entity) {}

  holds(shooter: Entity, now: number): boolean {
    return this.held.some(h => h.shooter === shooter && h.until > now);
  }

  rests(shooter: Entity, now: number): boolean {
    return this.resting.some(r => r.shooter === shooter && r.until > now);
  }
}

/**
 * Shooting tickets: a shot from an NPC hits a player only while its shooter
 * holds one of that player's few tickets. Without one the shot is aimed to
 * miss close by, so many shooters can fire at once while hits still arrive
 * spaced out and a player has time to react and get to cover.
 *
 * Each rationed target has its own pool of `ticketsPerTarget` tickets.
 * Tickets are taken only by shots ({@link claimShot}), never by readiness
 * checks. A shot from a shooter holding a ticket may hit; otherwise the
 * shooter keeps its place in line, and takes a free ticket with this shot if
 * it is first in line: a shooter in the target's view first, then whoever
 * has waited longest, then the nearest. A free ticket waits for the shooter
 * first in line to fire again at its own pace, so slow weapons keep their
 * turn; one overdue (reloading, lost sight) is passed over for the next.
 * Tickets for one target are granted at least `grantIntervalSeconds` apart;
 * a ticket lets its holder hit for `ticketSeconds`, after which it rests
 * `shooterCooldownSeconds` and rejoins the back of the line. All of this is
 * timed from when shots leave (after a wind-up), so a slow projectile's hit
 * lands its flight time later.
 *
 * Rationed targets are players and entities marked with {@link markTarget}.
 * Only shots aimed by an NPC attack controller claim: player shots never do.
 *
 * Tickets live on the machine that fires the shots (the NPCs' owner, the
 * server for spawned NPCs) and are counted per machine. A world service, like
 * `SpawnService`: one per machine for the world's lifetime, reached with
 * `ShootingTickets.get()` (do not cache it; it does not survive a reload).
 */
@service()
export class ShootingTickets extends Service {
  /** Drops every pool, mark and setting; for tests. */
  static reset(): void {
    ShootingTickets.get().clear();
  }

  /** The settings in effect: the latest placed settings, else {@link base}. */
  private config: ShootingTicketSettings = {...DEFAULT_SHOOTING_TICKET_SETTINGS};
  /** The settings {@link configure} edits, in effect while none are placed. */
  private base: ShootingTicketSettings = {...DEFAULT_SHOOTING_TICKET_SETTINGS};
  /** Settings placed in the world ({@link applySettings}), the one applied most recently last. */
  private placed: Array<{source: object; settings: ShootingTicketSettings}> = [];
  private pools: TicketPool[] = [];
  private marked: Entity[] = [];
  private players: Entity[] = [];
  private playersAt: number = Number.NEGATIVE_INFINITY;
  /** Each shooter's latest claim that a release could undo, kept by reference so a target since destroyed or unrationed cannot strand it. */
  private lastClaim: WeakMap<Entity, {pool: TicketPool; entry: Shooter}> = new WeakMap();

  private clear(): void {
    this.config = {...DEFAULT_SHOOTING_TICKET_SETTINGS};
    this.base = {...DEFAULT_SHOOTING_TICKET_SETTINGS};
    this.placed = [];
    this.pools = [];
    this.marked = [];
    this.players = [];
    this.playersAt = Number.NEGATIVE_INFINITY;
    this.lastClaim = new WeakMap();
  }

  get settings(): Readonly<ShootingTicketSettings> {
    return this.config;
  }

  /**
   * Changes the named settings in effect while none are placed in the world
   * ({@link applySettings}); a non-finite or negative number keeps the
   * current value.
   */
  configure(settings: Partial<ShootingTicketSettings>): void {
    this.base = merged(this.base, settings);
    this.refreshSettings();
  }

  /**
   * Puts `source`'s settings (a settings component placed in the world) in
   * effect, over {@link configure}'s: with several sources, the one applied
   * most recently wins, and applying again (a live edit) makes it the most
   * recent. A setting it leaves out, or gives as a non-finite or negative
   * number, is the default.
   */
  applySettings(source: object, settings: Partial<ShootingTicketSettings>): void {
    this.placed = [...this.placed.filter(p => p.source !== source), {source, settings: merged(DEFAULT_SHOOTING_TICKET_SETTINGS, settings)}];
    this.refreshSettings();
  }

  /** Withdraws `source`'s settings: the latest remaining source's are in effect, else {@link configure}'s. */
  withdrawSettings(source: object): void {
    this.placed = this.placed.filter(p => p.source !== source);
    this.refreshSettings();
  }

  private refreshSettings(): void {
    const latest = this.placed.length > 0 ? this.placed[this.placed.length - 1] : null;
    this.config = latest ? latest.settings : this.base;
  }

  /** Rations hits on `entity` as on a player: an escort, a test dummy. */
  markTarget(entity: Entity): void {
    if (this.marked.indexOf(entity) < 0) {
      this.marked.push(entity);
    }
  }

  unmarkTarget(entity: Entity): void {
    this.marked = this.marked.filter(e => e !== entity);
    this.pools = this.pools.filter(p => p.target !== entity);
  }

  /** The player or marked entity that `entity` is or sits under, when tickets are on; else null. */
  rationedRootOf(entity: Maybe<Entity>, now: number = worldTime()): Entity | null {
    if (!this.config.enabled || entity == null || entity.isDestroyed()) {
      return null;
    }
    if (now - this.playersAt >= PLAYER_LIST_SECONDS || now < this.playersAt) {
      this.players = PlayerService.get().getAllPlayers();
      this.playersAt = now;
    }
    const players = this.players;
    let current: Maybe<Entity> = entity;
    for (let depth = 0; current != null && depth < ROOT_WALK_MAX_DEPTH; depth++) {
      if (this.marked.indexOf(current) >= 0 || players.indexOf(current) >= 0) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * `shooter` fires at `target` now; its shot leaves `releaseDelay` seconds
   * from now (a wind-up), and its last round `burstSeconds` after that. True
   * when the shot may hit: the target is not rationed, or the shooter holds
   * its ticket, taken earlier or with this shot, and the ticket still runs
   * when the shot leaves. The ticket is kept until the shot's last round
   * leaves, and one taken now runs from the release. Call once per shot
   * fired, never for a readiness check. A shooter has one shot in hand at a
   * time: a shot still in its wind-up is released ({@link releaseShot}) or
   * has left before its shooter's next claim, which replaces what a release
   * would undo (the fire ability releases an unfired shot before it claims
   * the next).
   */
  claimShot(
    shooter: Entity,
    target: Maybe<Entity>,
    now: number = worldTime(),
    shot: {releaseDelay?: number; burstSeconds?: number} = {},
  ): boolean {
    this.lastClaim.delete(shooter);
    const root = this.rationedRootOf(target, now);
    if (root == null) {
      return true;
    }
    const release = now + nonNegative(shot.releaseDelay);
    const lastRound = release + nonNegative(shot.burstSeconds);
    const pool = this.poolFor(root);
    this.expire(pool, now);
    const entry = this.recordShot(pool, shooter, now);
    this.lastClaim.set(shooter, {pool, entry});
    const held = pool.held.find(h => h.shooter === shooter && h.until > now);
    if (held) {
      // A ticket that ends before this shot leaves does not cover it; the
      // shooter rests after it as usual.
      if (held.until <= release) {
        return false;
      }
      if (held.until < lastRound) {
        if (entry.undo) {
          entry.undo.stretched = {ticket: held, until: held.until};
        }
        held.until = lastRound;
      }
      return true;
    }
    if (entry.since == null) {
      entry.since = now;
    }
    if (!this.mayTake(pool, entry, now, release)) {
      return false;
    }
    const ticket = {shooter, until: Math.max(release + this.config.ticketSeconds, lastRound)};
    pool.held.push(ticket);
    if (entry.undo) {
      entry.undo.took = ticket;
    }
    entry.since = null;
    pool.lastGrantAt = release;
    pool.lastGrant = ticket;
    return true;
  }

  /**
   * `shooter`'s latest shot never left (cancelled in its wind-up): gives back
   * what it took, the ticket included, so the shooter keeps its place and the
   * grant interval it used is restored (unless another ticket was granted
   * since, which then spaces the next). Works even if the target has since
   * been destroyed or tickets turned off. Does nothing for a shot already
   * given back, or one that took nothing from a pool. Housekeeping its claim
   * ran on the way (ending lapsed tickets, forgetting quiet shooters) was due
   * by time alone, would have run at the next claim anyway, and stays done.
   */
  releaseShot(shooter: Entity): void {
    const claim = this.lastClaim.get(shooter);
    this.lastClaim.delete(shooter);
    const undo = claim?.entry.undo;
    if (!claim || !undo) {
      return;
    }
    const {pool, entry} = claim;
    entry.undo = null;
    if (undo.stretched) {
      undo.stretched.ticket.until = undo.stretched.until;
    }
    const took = undo.took;
    if (took) {
      pool.held = pool.held.filter(h => h !== took);
      pool.resting = pool.resting.filter(r => r.after !== took);
      if (pool.lastGrant === took) {
        pool.lastGrantAt = undo.lastGrantAt;
        pool.lastGrant = undo.lastGrant;
      }
    }
    if (undo.joined) {
      pool.shooters = pool.shooters.filter(s => s !== entry);
      return;
    }
    entry.lastShot = undo.lastShot;
    entry.gap = undo.gap;
    entry.since = undo.since;
  }

  /**
   * Whether a shot from `shooter` at `target` may hit it right now, without
   * taking anything: the target is not rationed, or the shooter holds its
   * ticket.
   */
  holds(shooter: Entity, target: Maybe<Entity>, now: number = worldTime()): boolean {
    const root = this.rationedRootOf(target, now);
    if (root == null) {
      return true;
    }
    const pool = this.pools.find(p => p.target === root);
    return pool != null && pool.holds(shooter, now);
  }

  /**
   * Notes the shot's pace, keeping how to undo it. A shooter that had stopped
   * firing loses its place in line, and the pause is not its pace: only a
   * shooter whose pace is still unknown takes its first gap as its pace, so a
   * slow weapon learns its own.
   */
  private recordShot(pool: TicketPool, shooter: Entity, now: number): Shooter {
    let entry = pool.shooters.find(s => s.shooter === shooter);
    if (!entry) {
      entry = {shooter, since: null, lastShot: now, gap: 0, undo: null};
      entry.undo = {
        lastShot: now,
        gap: 0,
        since: null,
        lastGrantAt: pool.lastGrantAt,
        lastGrant: pool.lastGrant,
        took: null,
        stretched: null,
        joined: true,
      };
      pool.shooters.push(entry);
      return entry;
    }
    entry.undo = {
      lastShot: entry.lastShot,
      gap: entry.gap,
      since: entry.since,
      lastGrantAt: pool.lastGrantAt,
      lastGrant: pool.lastGrant,
      took: null,
      stretched: null,
      joined: false,
    };
    const gap = now - entry.lastShot;
    const learns = gap <= MAX_RESERVE_SECONDS;
    if (keepsPlace(entry, now)) {
      entry.gap = learns ? gap : 0;
    } else {
      entry.since = null;
      entry.gap = entry.gap === 0 && learns ? gap : 0;
    }
    entry.lastShot = now;
    return entry;
  }

  /** Shooters holding `target`'s tickets now, for logs and tests. */
  holdersOf(target: Entity, now: number = worldTime()): Entity[] {
    const root = this.rationedRootOf(target, now);
    const pool = root != null ? this.pools.find(p => p.target === root) : undefined;
    return pool ? pool.held.filter(h => h.until > now).map(h => h.shooter) : [];
  }

  private poolFor(root: Entity): TicketPool {
    this.pools = this.pools.filter(p => !p.target.isDestroyed());
    let pool = this.pools.find(p => p.target === root);
    if (!pool) {
      pool = new TicketPool(root);
      this.pools.push(pool);
    }
    return pool;
  }

  /**
   * Ends lapsed tickets, sending their holders to rest, and forgets shooters
   * that are gone or long quiet.
   */
  private expire(pool: TicketPool, now: number): void {
    const ended = pool.held.filter(h => h.until <= now || h.shooter.isDestroyed());
    for (const h of ended) {
      // The rest runs from the ticket's end, in world time: a holder quiet
      // since then has already rested. Turns rotate by the line, not the
      // rest: the holder left the line when it took the ticket and rejoins
      // at the back with its next shot, behind every shooter still waiting.
      if (!h.shooter.isDestroyed()) {
        pool.resting.push({shooter: h.shooter, until: h.until + this.config.shooterCooldownSeconds, after: h});
      }
    }
    pool.held = pool.held.filter(h => ended.indexOf(h) < 0);
    pool.resting = pool.resting.filter(r => r.until > now);
    pool.shooters = pool.shooters.filter(s => !s.shooter.isDestroyed() && now - s.lastShot <= FORGET_SECONDS);
  }

  /**
   * Whether `entry`'s shooter takes a free ticket with its shot now: one is
   * free and due, the shooter is not resting, and it is first in line.
   */
  private mayTake(pool: TicketPool, entry: Shooter, now: number, release: number): boolean {
    const {ticketsPerTarget, grantIntervalSeconds} = this.config;
    if (pool.held.length >= ticketsPerTarget || release - pool.lastGrantAt < grantIntervalSeconds) {
      return false;
    }
    if (pool.rests(entry.shooter, now)) {
      return false;
    }
    return this.firstInLine(pool, now) === entry;
  }

  /**
   * Among shooters in line, neither resting nor overdue: in the target's view
   * first, then waited longest, then nearest.
   */
  private firstInLine(pool: TicketPool, now: number): Shooter | null {
    const target = pool.target.getComponent(TransformComponent);
    let best: {w: Shooter; inView: boolean; distance: number} | null = null;
    for (const w of pool.shooters) {
      if (w.since == null || pool.rests(w.shooter, now) || overdue(w, now)) {
        continue;
      }
      const at = w.shooter.getComponent(TransformComponent)?.worldPosition ?? null;
      const from = target?.worldPosition ?? null;
      const distance = at != null && from != null ? at.sub(from).magnitude() : Number.POSITIVE_INFINITY;
      const candidate = {w, inView: target != null && at != null && inView(target, at), distance};
      if (best == null || ahead(candidate, best)) {
        best = candidate;
      }
    }
    return best?.w ?? null;
  }
}

function ahead(
  a: {w: Shooter; inView: boolean; distance: number},
  b: {w: Shooter; inView: boolean; distance: number},
): boolean {
  if (a.inView !== b.inView) {
    return a.inView;
  }
  const aSince = a.w.since ?? Number.POSITIVE_INFINITY;
  const bSince = b.w.since ?? Number.POSITIVE_INFINITY;
  if (aSince !== bSince) {
    return aSince < bSince;
  }
  return a.distance < b.distance;
}

/** Whether `point` lies within the view half-angle of `target`'s horizontal facing. */
function inView(target: TransformComponent, point: {x: number; z: number}): boolean {
  const forward = target.worldForward;
  const from = target.worldPosition;
  const fx = forward.x;
  const fz = forward.z;
  const dx = point.x - from.x;
  const dz = point.z - from.z;
  const lengths = Math.hypot(fx, fz) * Math.hypot(dx, dz);
  return lengths > 0 && (fx * dx + fz * dz) / lengths >= VIEW_COS;
}

/** `onto` with the valid settings of `settings` applied: a non-finite or negative number is left out. */
function merged(onto: Readonly<ShootingTicketSettings>, settings: Partial<ShootingTicketSettings>): ShootingTicketSettings {
  return {
    enabled: settings.enabled ?? onto.enabled,
    ticketsPerTarget: Math.floor(validOr(settings.ticketsPerTarget, onto.ticketsPerTarget)),
    ticketSeconds: validOr(settings.ticketSeconds, onto.ticketSeconds),
    grantIntervalSeconds: validOr(settings.grantIntervalSeconds, onto.grantIntervalSeconds),
    shooterCooldownSeconds: validOr(settings.shooterCooldownSeconds, onto.shooterCooldownSeconds),
    nearMissMeters: validOr(settings.nearMissMeters, onto.nearMissMeters),
  };
}

function validOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function worldTime(): number {
  return WorldService.get().getWorldTime();
}
