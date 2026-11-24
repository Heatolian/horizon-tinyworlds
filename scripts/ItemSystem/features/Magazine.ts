/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v3

import type {Entity, TextureAsset} from 'meta/worlds';
import type {GASComponent} from '../../gas/core/GASComponent';
import type {ReloadConfig} from '../../gas_abilities/weapons/core/WeaponReloadAbility';
import {refillStat, spendStat} from '../container/ItemCommands';
import {containerRegistry} from '../container/ItemContainer';
import type {EquipSource} from '../equipment/EquipmentDefinition';
import {ItemFragment, type StatLimit} from '../items/ItemDefinition';
import {getStat, type ItemStack, type ItemStatsBuilder} from '../items/ItemStack';

/** Rounds left in a gun's magazine. Lives on the stack so it survives drops and swaps. */
export const MAGAZINE_STAT = 'weapon.magazine';

/** Upper bound for the reserve attribute; the real count comes from the containers. */
export const RESERVE_CAP = 1_000_000;

export interface MagazineConfig {
  /** Rounds per magazine; a new gun starts full. */
  size: number;
  /** Reloads take items with this tag (or a child tag) from the holder's containers. Omit for infinite ammo. */
  ammoTag?: string;
  /** Seconds a reload blocks firing. Default 1.5. */
  reloadTimeSec?: number;
  /** Reload by itself when empty. Default true. */
  autoReload?: boolean;
  /** Touch HUD Reload icon while the weapon is in hand. */
  reloadButtonIcon?: TextureAsset;
}

/**
 * A weapon fires from a magazine and reloads from carried ammo. Add it beside
 * `Weapon` on guns; melee weapons have none. The rounds left are the stack's
 * `MAGAZINE_STAT`, spent by firing and refilled one-for-one from `ammoTag` items.
 */
export class Magazine extends ItemFragment {
  constructor(readonly config: MagazineConfig) {
    super();
  }

  override onInstanceCreated(stats: ItemStatsBuilder): void {
    stats.set(MAGAZINE_STAT, this.config.size);
  }

  override statLimit(key: string): StatLimit | null {
    return key === MAGAZINE_STAT ? {max: this.config.size, refillTag: this.config.ammoTag} : null;
  }

  override validate(): string[] {
    const {size} = this.config;
    return Number.isInteger(size) && size >= 1 ? [] : [`size must be an integer >= 1, got ${String(size)}`];
  }
}

/** How an equipped magazine reaches the server-side item state it came from. */
export interface MagazineLink {
  /** Matching rounds in the holder's containers, as replicated to this machine. */
  reserve(): number;
  /** `loaded` rounds went from the containers into this magazine. */
  commitReload(loaded: number): void;
  /** This magazine now holds `rounds`. */
  reportRounds(rounds: number): void;
}

/** The magazine is a generic refillable stat on the server; the runtime only maps its events onto stat commands. */
export function magazineLink(character: Entity, uid: string, ammoTag: string | undefined): MagazineLink {
  return {
    reserve: () =>
      ammoTag == null ? 0 : containerRegistry.all(character).reduce((sum, c) => sum + c.countWithTag(ammoTag), 0),
    commitReload: loaded => {
      void refillStat(character, uid, MAGAZINE_STAT, loaded);
    },
    reportRounds: rounds => {
      void spendStat(character, uid, MAGAZINE_STAT, rounds);
    },
  };
}

export interface MagazineRuntimeInit {
  gas: GASComponent;
  config: MagazineConfig;
  /** GAS attributes `setupWeapon` created for this weapon. */
  ammoAttr: string;
  reserveAttr: string | undefined;
  reloadAbilityId: string;
  rounds: number;
  link: MagazineLink;
}

/**
 * The magazine of one equipped weapon, on its owner. Firing spends rounds
 * locally (the weapon's ammo attribute); reloads draw on a reserve attribute
 * mirrored from the holder's containers; the server is told what was loaded
 * and what is left, and bounds both.
 */
export class MagazineRuntime {
  readonly config: MagazineConfig;
  private readonly gas: GASComponent;
  private readonly ammoAttr: string;
  private readonly reserveAttr: string | undefined;
  private readonly reloadAbilityId: string;
  private readonly link: MagazineLink;
  /** Rounds loaded here that the server has not yet taken out of the containers. */
  private unconfirmedLoaded = 0;
  private lastObservedReserve = 0;

  constructor(init: MagazineRuntimeInit) {
    this.config = init.config;
    this.gas = init.gas;
    this.ammoAttr = init.ammoAttr;
    this.reserveAttr = init.reserveAttr;
    this.reloadAbilityId = init.reloadAbilityId;
    this.link = init.link;
    this.gas.setAttributeBase(this.ammoAttr, Math.max(0, Math.min(init.rounds, this.config.size)));
    this.lastObservedReserve = this.link.reserve();
    this.syncReserve();
  }

  /** Rounds in the magazine. */
  get rounds(): number {
    return this.gas.getAttributeValue(this.ammoAttr);
  }

  get size(): number {
    return this.config.size;
  }

  /** Tells the server the rounds left now, e.g. right before the weapon leaves the holder. */
  report(): void {
    this.link.reportRounds(this.rounds);
  }

  reload(): boolean {
    return this.gas.tryActivateAbility(this.reloadAbilityId);
  }

  /** Every frame on the owner: mirror the reserve, and reload when empty if `autoReload`. */
  tick(): void {
    this.syncReserve();
    if (this.config.autoReload !== false && this.rounds <= 0) {
      this.reload();
    }
  }

  /** `onStarted` runs as the reload begins (the weapon's reload cue). */
  buildReloadConfig(onStarted: () => void): ReloadConfig {
    return {
      ammoAttr: this.ammoAttr,
      reserveAttr: this.reserveAttr,
      magazineSize: this.config.size,
      reloadTimeSec: this.config.reloadTimeSec ?? 1.5,
      onReloadStarted: () => {
        // Shots are spent locally; the server bounds a refill by the magazine it knows, so report first.
        this.report();
        onStarted();
      },
      onReloaded: (loaded: number) => {
        if (loaded > 0 && this.reserveAttr !== undefined) {
          this.unconfirmedLoaded += loaded;
          this.link.commitReload(loaded);
        }
      },
    };
  }

  /**
   * Mirrors the containers into the reserve attribute, minus rounds already
   * loaded here but not yet removed by the server, so one box of ammo cannot
   * be loaded twice while the removal replicates.
   */
  private syncReserve(): void {
    const reserveAttr = this.reserveAttr;
    if (reserveAttr === undefined) {
      return;
    }
    const observed = this.link.reserve();
    if (observed < this.lastObservedReserve) {
      this.unconfirmedLoaded = Math.max(0, this.unconfirmedLoaded - (this.lastObservedReserve - observed));
    }
    this.lastObservedReserve = observed;
    const reserve = Math.min(RESERVE_CAP, Math.max(0, observed - this.unconfirmedLoaded));
    if (this.gas.getAttributeValue(reserveAttr) !== reserve) {
      this.gas.setAttributeBase(reserveAttr, reserve);
    }
  }
}

/**
 * A gun's magazine as this machine left it, by stack uid, with the stack's
 * stat as seen at that moment. Re-equipping before the server's update arrives
 * would otherwise read that stale stat (a refill or spend still in flight).
 * Only the replication window needs covering, so entries expire.
 */
const leftMagazines = new Map<string, LeftMagazine>();

/** Far longer than a round trip; past it the stack's stat is the server's word. */
export const LEFT_MAGAZINE_TTL_MS = 5000;

export interface LeftMagazine {
  readonly rounds: number;
  readonly seenStat: number | undefined;
  readonly leftAt: number;
}

/** Rounds to load on equip: what this machine recently left in the gun, unless the stack's stat changed since (then the server's value wins). */
export function magazineOnEquip(left: LeftMagazine | undefined, stat: number | undefined, size: number, now: number): number {
  const fresh = left != null && now - left.leftAt <= LEFT_MAGAZINE_TTL_MS;
  return fresh && left.seenStat === stat ? left.rounds : (stat ?? size);
}

/** Rounds to load when `source` is equipped by this machine, consuming what it remembered for it. */
export function recallMagazine(source: EquipSource, size: number): {rounds: number; stat: number | undefined} {
  const stat = 'stats' in source ? getStat(source as ItemStack, MAGAZINE_STAT) : undefined;
  const left = leftMagazines.get(source.uid);
  leftMagazines.delete(source.uid);
  return {rounds: magazineOnEquip(left, stat, size, Date.now()), stat};
}

/** Remembers the rounds left in `uid` as it is unequipped; `fallbackStat` covers a stack briefly in neither container mid-move. */
export function rememberMagazine(character: Entity, uid: string, rounds: number, fallbackStat: number | undefined): void {
  const now = Date.now();
  for (const [key, entry] of leftMagazines) {
    if (now - entry.leftAt > LEFT_MAGAZINE_TTL_MS) {
      leftMagazines.delete(key);
    }
  }
  leftMagazines.set(uid, {rounds, seenStat: magazineStatIn(character, uid) ?? fallbackStat, leftAt: now});
}

function magazineStatIn(character: Entity, uid: string): number | undefined {
  for (const container of containerRegistry.all(character)) {
    const stack = container.getSlot(container.findUid(uid));
    if (stack != null) {
      return getStat(stack, MAGAZINE_STAT);
    }
  }
  return undefined;
}
