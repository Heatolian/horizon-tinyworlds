/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v5

import {TransformComponent, WorldService, type Entity, type Maybe, type RemapPageAsset, type TextureAsset, type Vec3} from 'meta/worlds';
import {HEALTH_ATTR} from '../../Character/gas/CharacterAttributes';
import {createDamageEffect} from '../../Character/gas/CharacterDamage';
import {GASComponent} from '../../gas/core/GASComponent';
import {GameplayCueContext} from '../../gas/cues/GameplayCueContext';
import {DEFAULT_MUZZLE_OFFSET, createAimProvider, type Aim, type AimProvider} from '../../gas_abilities/weapons/core/AimProvider';
import {WeaponFireAbilityBase, type WeaponConfigProvider, type WeaponFireConfigBase} from '../../gas_abilities/weapons/core/WeaponFireAbilityBase';
import type {ReloadConfig, ReloadConfigProvider} from '../../gas_abilities/weapons/core/WeaponReloadAbility';
import {hitCueTags, setupWeapon, type WeaponRuntime} from '../../gas_abilities/weapons/core/WeaponSetup';
import {WeaponTrigger, parseFireMode} from '../../gas_abilities/weapons/core/WeaponTrigger';
import {ShootingTickets} from '../../gas_abilities/weapons/targeting/ShootingTickets';
import {TargetAimProvider} from '../../gas_abilities/weapons/targeting/TargetAimProvider';
import {GASDeployable} from '../../gas_abilities/deployables/GASDeployable';
import {MovementAbility} from '../../Character/Abilities/MovementAbility';
import {findOnCharacter} from '../container/CharacterLookup';
import {addBeforeItemsLeaveListener, expendItem, reportDetonation, reportShot} from '../container/ItemCommands';
import {ItemResult, registerItemRequestHandler, type ItemRequestContext} from '../container/ItemRequest';
import {EquipmentBinder} from '../equipment/EquipmentBinder';
import {onCharacterAnimationEvent} from '../equipment/CharacterAnimationEvents';
import {Equippable} from '../equipment/EquipmentController';
import {registerEquipmentRemapper} from '../equipment/EquipmentRemappers';
import {
  EquipmentDefinition,
  type EquipContext,
  type EquipmentVisual,
  type EquipRevoker,
  type EquipSource,
} from '../equipment/EquipmentDefinition';
import {itemRegistry, type ItemRegistry} from '../items/ItemDefinition';
import {
  Magazine,
  MagazineRuntime,
  RESERVE_CAP,
  magazineLink,
  recallMagazine,
  rememberMagazine,
  type MagazineConfig,
  type MagazineLink,
} from './Magazine';
import {Expendable} from './Expendable';
import {Melee, type WeaponDelivery} from './WeaponDelivery';
import {Bloom, type BloomConfig, type RecoilConfig} from './WeaponFeel';

const FIRE_CUE_TAG = 'cue.weapon.fire';
const RELOAD_CUE_TAG = 'cue.weapon.reload';

export type WeaponAimMode = 'auto' | 'scoped' | 'manual';

export interface WeaponConfig {
  /** Animation key, raised as `equipment.{animKey}`: 'pistol', 'rifle', 'sword'. */
  animKey: string;
  /**
   * Remap page that points the shared item layer's `idleItem` / `useItem` / `reloadItem`
   * at this weapon's clips. Registered per `animKey`: items sharing a key share its page.
   */
  remapper?: RemapPageAsset;
  /** Model shown in the hand: a pure visual template and the rig socket it attaches to (e.g. `RightHand`). */
  visual?: EquipmentVisual | null;
  /** Health removed per hit (per pellet for a shotgun). */
  damage: number;
  /** Activations per second; becomes the fire ability cooldown. */
  fireRate: number;
  /** `semi`: one shot per press. `auto`: keeps firing while held. Default `semi`. */
  fireMode?: 'semi' | 'auto';
  /**
   * `camera`: shots go through the crosshair. `forward`: along the holder's facing (melee, NPCs).
   * `muzzle`: along the crosshair but from `muzzleOffset`. `hand`: along the
   * crosshair from the hand socket of `visual` (`RightHand` without one), clear of
   * the body, for throws; `muzzleOffset` when the rig has no such socket. Default `camera`.
   */
  aimSource?: 'camera' | 'forward' | 'muzzle' | 'hand';
  /**
   * How the player's `CrosshairTrigger` fires it: `auto` while the crosshair is on a target,
   * `manual` only from the Use button, `scoped` from Use too, and Aim looks through its sight
   * (a sniper). Default `manual`.
   */
  aimMode?: WeaponAimMode;
  /** Field of view in degrees while a `scoped` weapon is aimed. Default 25. */
  scopeFov?: number;
  /** How the camera kicks per shot while a player fires it. None by default. */
  recoil?: RecoilConfig;
  /** How spread grows per shot and while moving, while a player fires it. None by default. */
  bloom?: BloomConfig;
  /** Shot origin relative to the holder for `forward` and `muzzle` aim, and `hand` aim without a hand socket. Default (0, 1, 0.33). */
  muzzleOffset?: Vec3;
  /** GAS attribute the damage drains. Default `health`. */
  healthAttribute?: string;
  /** Only targets carrying this GAS tag take damage. Empty hits anything with GAS. */
  targetTag?: string;
  /** Cue raised on the victim each time the damage lands (e.g. a fireball's impact VFX). */
  hitCueTag?: string;
  /** Touch HUD Use icon while this weapon is in hand. */
  fireButtonIcon?: TextureAsset;
  /** How a shot lands: `Hitscan`, `Melee`, `Projectile`, `Throw`. */
  delivery: WeaponDelivery;
}

export interface ItemWeaponInit {
  holder: Entity;
  gas: GASComponent;
  weapon: Weapon;
  /** Namespaces the granted ability and attribute ids. */
  weaponKey: string;
  /** The item's `Magazine`, the rounds to load and its server link; null for a weapon without one (melee). */
  magazine: {config: MagazineConfig; rounds: number; link: MagazineLink} | null;
  /** Runs once per round fired, on the holder's owner, with where it left and which way (an `Expendable` spends one of its stack; a loud round may be reported). */
  onRound?: ((origin: Vec3, direction: Vec3) => void) | null;
  /** Runs when a thrown shot goes off, on the holder's owner, with the deployable that did. */
  onDetonation?: ((deployable: Entity) => void) | null;
}

/**
 * One equipped weapon on its holder's owner. Grants the delivery's fire
 * ability (and reload, when the item has a `Magazine`) through `setupWeapon`
 * and answers their config callbacks, so shots, cooldown, ammo cost and reload
 * behave exactly like the component-based weapons -- without a weapon entity
 * in the world. The magazine, if any, is its `MagazineRuntime`.
 */
export class ItemWeapon implements WeaponConfigProvider<WeaponFireConfigBase>, ReloadConfigProvider {
  /** The weapon's magazine; null for a weapon without one (melee). */
  readonly magazine: MagazineRuntime | null;
  private readonly holder: Entity;
  private readonly gas: GASComponent;
  private readonly weapon: Weapon;
  private readonly trigger: WeaponTrigger;
  private readonly defaultAim: AimProvider;
  private aim: AimProvider;
  private readonly runtime: WeaponRuntime;
  private readonly onRound: ((origin: Vec3, direction: Vec3) => void) | null;
  private readonly onDetonation: ((deployable: Entity) => void) | null;
  private readonly bloom: Bloom | null;
  private rounds = 0;
  /** The aim whose shooting ticket the shot being fired claimed, until that shot leaves or is cancelled. */
  private shotClaimed: TargetAimProvider | null = null;
  private lastTickSec: number | null = null;
  private lastPosition: Vec3 | null = null;
  /** The holder's horizontal speed as a fraction of its `MovementAbility.moveSpeed`, for bloom. */
  private movement = 0;
  private movementAbility: MovementAbility | null | undefined = undefined;
  private disposed = false;
  /** Spread grows with `bloom` while true; a player's driver (`CrosshairTrigger`) turns it on, NPC aim keeps its own error. */
  bloomActive = false;
  /** Set by the driver while a scoped weapon is aimed; multiplies the bloom by its `steadyFactor`. */
  steadied = false;

  constructor(init: ItemWeaponInit) {
    const {holder, gas, weapon, weaponKey, magazine} = init;
    this.onRound = init.onRound ?? null;
    this.onDetonation = init.onDetonation ?? null;
    this.bloom = weapon.config.bloom != null ? new Bloom(weapon.config.bloom) : null;
    this.holder = holder;
    this.gas = gas;
    this.weapon = weapon;
    const {config} = weapon;
    this.trigger = new WeaponTrigger(parseFireMode(config.fireMode ?? 'semi'));
    this.defaultAim = createAimProvider(config.aimSource ?? 'camera', this.muzzleOffset, config.visual?.socket);
    this.aim = this.defaultAim;
    this.runtime = setupWeapon(
      {
        gas,
        provider: this,
        weaponKey,
        magazineSize: magazine?.config.size ?? 1,
        // 0 means no reserve attribute, which the reload ability reads as infinite.
        reserveAmmo: magazine?.config.ammoTag != null ? RESERVE_CAP : 0,
        reloadable: magazine != null,
        fireRate: config.fireRate,
        damage: config.damage,
        damageEffectId: weapon.damageEffectId,
        healthAttribute: weapon.healthAttribute,
        hitCueTag: config.hitCueTag,
      },
      config.delivery.abilities,
    );
    this.magazine =
      magazine != null
        ? new MagazineRuntime({
            gas,
            config: magazine.config,
            ammoAttr: this.runtime.ammoAttr,
            reserveAttr: this.runtime.reserveAttr,
            reloadAbilityId: this.runtime.reloadAbilityId,
            rounds: magazine.rounds,
            link: magazine.link,
          })
        : null;
  }

  get config(): WeaponConfig {
    return this.weapon.config;
  }

  /** Where each shot starts and points. A driver (auto-targeting, an NPC) may swap in its own; null restores the `aimSource` aim. */
  get aimProvider(): AimProvider {
    return this.aim;
  }

  set aimProvider(provider: AimProvider | null) {
    this.aim = provider ?? this.defaultAim;
  }

  get muzzleOffset(): Vec3 {
    return this.weapon.config.muzzleOffset ?? DEFAULT_MUZZLE_OFFSET;
  }

  get reach(): number {
    return this.weapon.config.delivery.reach;
  }

  get targetTag(): string {
    return this.weapon.config.targetTag ?? '';
  }

  get fireRate(): number {
    return this.weapon.config.fireRate;
  }

  get aimMode(): WeaponAimMode {
    return this.weapon.config.aimMode ?? 'manual';
  }

  get scopeFov(): number {
    return this.weapon.config.scopeFov ?? 25;
  }

  /** Rounds fired since equipped; a driver compares it to see new shots (camera recoil). */
  get roundsFired(): number {
    return this.rounds;
  }

  /** Bloom spread in degrees right now, added to the delivery's own on every shot; 0 while inactive. */
  get spreadDeg(): number {
    return this.bloom != null && this.bloomActive ? this.bloom.spreadDeg(this.movement, this.steadied) : 0;
  }

  /** The whole cone a shot leaves in now, for the crosshair: the delivery's own spread plus the bloom. */
  get crosshairSpreadDeg(): number {
    return (this.weapon.config.delivery.spreadDeg ?? 0) + this.spreadDeg;
  }

  /** A melee hit lands on any collider surface within reach, so drivers do not measure its reach root to root. */
  get isMelee(): boolean {
    return this.weapon.config.delivery instanceof Melee;
  }

  /** Reports the magazine, then revokes both abilities. The attributes stay, keyed per item definition. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.magazine?.report();
    this.disposed = true;
    this.trigger.reset();
    this.gas.removeAbility(this.runtime.fireAbilityId);
    this.gas.removeAbility(this.runtime.reloadAbilityId);
  }

  pullTrigger(): void {
    if (!this.disposed && this.trigger.pull()) {
      this.gas.tryActivateAbility(this.runtime.fireAbilityId);
    }
  }

  releaseTrigger(): void {
    this.trigger.release();
  }

  /** One activation without touching the held-trigger state; for AI drivers. */
  fireOnce(): boolean {
    return !this.disposed && this.gas.tryActivateAbility(this.runtime.fireAbilityId);
  }

  /** Whether GAS would accept a fire activation now, with the current aim. */
  canFire(): boolean {
    return !this.disposed && this.gas.canActivateAbility(this.runtime.fireAbilityId);
  }

  /** Every gate `canFire` checks except the aim: cooldown, a shot in flight, required and blocking tags, a loaded round. */
  isReadyToFire(): boolean {
    const {gas} = this;
    const id = this.runtime.fireAbilityId;
    const data = this.disposed ? null : gas.getAbility(id)?.data;
    return (
      data != null &&
      !gas.isAbilityOnCooldown(id) &&
      !gas.isAbilityActive(id) &&
      gas.hasAllTags(data.requiredTags) &&
      !gas.hasAnyTag(data.blockedByTags) &&
      (this.magazine == null || gas.getAttributeValue(this.runtime.ammoAttr) > 0)
    );
  }

  /** Ends a shot still before its contact or release; true when one was cut off. */
  interrupt(): boolean {
    const id = this.runtime.fireAbilityId;
    const ability = this.disposed ? null : this.gas.getAbility(id);
    if (!(ability instanceof WeaponFireAbilityBase) || !ability.isPreDelivery) {
      return false;
    }
    this.gas.endAbility(id);
    return true;
  }

  /** The holder's animation event, for a shot whose wind-up waits on one (`windupEndEvent`). */
  handleAnimationEvent(name: string): void {
    const ability = this.disposed ? null : this.gas.getAbility(this.runtime.fireAbilityId);
    if (ability instanceof WeaponFireAbilityBase) {
      ability.handleAnimationEvent(name);
    }
  }

  /** Ends the fire ability in any phase. */
  cancel(): void {
    const id = this.runtime.fireAbilityId;
    if (!this.disposed && this.gas.isAbilityActive(id)) {
      this.gas.endAbility(id);
    }
  }

  reload(): boolean {
    return !this.disposed && this.magazine?.reload() === true;
  }

  /** Owner, every frame: sustained automatic fire, the magazine's reserve sync and auto-reload (all gated by GAS), and bloom recovery. */
  tick(): void {
    if (this.disposed) {
      return;
    }
    this.tickBloom();
    this.magazine?.tick();
    if (this.trigger.isFiring) {
      this.gas.tryActivateAbility(this.runtime.fireAbilityId);
    }
  }

  buildFireConfig(firing: boolean = false): WeaponFireConfigBase | null {
    if (this.disposed) {
      return null;
    }
    const {config} = this.weapon;
    // An NPC's shot at a player claims a shooting ticket as it is fired (never
    // in a readiness check), which decides its aim (a ticketless shot is aimed
    // to miss) and what it may damage, fixed now so a round still in flight
    // later keeps the decision.
    const rationing = firing && this.aim instanceof TargetAimProvider && this.aim.rationsHits ? this.aim : null;
    if (firing) {
      this.shotClaimed = rationing;
    }
    const ticketed = rationing
      ? rationing.claimShot(this.holder, {
          splashRadius: config.delivery.splashRadius,
          spreadDeg: (config.delivery.spreadDeg ?? 0) + this.spreadDeg,
          windupSec: config.delivery.windupSec,
          burstSec: config.delivery.burstSec,
        })
      : true;
    const gate = rationing ? rationedGate(this.holder, rationing.getTarget(), ticketed) : null;
    const aim = this.aim.getAim(this.holder);
    if (aim == null) {
      // Nothing to fire at: the claim goes back as if the shot were cancelled.
      if (rationing) {
        this.onShotCancelled();
      }
      return null;
    }
    const damageEffect = this.runtime.damageEffect;
    const fireConfig = config.delivery.buildFireConfig({
      holder: this.holder,
      aim,
      refreshAim: (): Aim | null => this.aim.getAim(this.holder),
      targetTag: this.targetTag !== '' ? this.targetTag : undefined,
      // A ticketless round must not steer back onto the target it is aimed to miss.
      aimTarget: ticketed ? this.aimTarget() : undefined,
      mayAffect: gate ?? undefined,
      damage: (gasEntity: Entity): void => {
        const target = gasEntity.getComponent(GASComponent);
        // A projectile can land after its thrower is gone; there is no one to attribute the hit to.
        if (target == null || this.holder.isDestroyed()) {
          return;
        }
        if (gate && !gate(gasEntity)) {
          return;
        }
        this.gas.applyEffectToTarget(target, damageEffect);
      },
      detonated: (deployable: Entity): void => this.onDetonation?.(deployable),
    });
    const bloom = this.spreadDeg;
    if (bloom > 0) {
      fireConfig.spreadDeg = (fireConfig.spreadDeg ?? 0) + bloom;
    }
    return fireConfig;
  }

  /** Recovers the bloom by the world time since the last tick (so a pause recovers nothing), and samples how fast the holder moves. */
  private tickBloom(): void {
    if (this.bloom == null) {
      return;
    }
    const now = WorldService.get().getWorldTime();
    const dt = this.lastTickSec != null ? now - this.lastTickSec : 0;
    this.lastTickSec = now;
    this.bloom.tick(dt);
    const position = this.holder.getComponent(TransformComponent)?.worldPosition ?? null;
    if (position != null && this.lastPosition != null && dt > 0) {
      const dx = position.x - this.lastPosition.x;
      const dz = position.z - this.lastPosition.z;
      if (this.movementAbility === undefined) {
        this.movementAbility = findOnCharacter(this.holder, MovementAbility) ?? null;
      }
      const fullSpeed = this.movementAbility?.moveSpeed ?? 0;
      this.movement = fullSpeed > 0 ? Math.sqrt(dx * dx + dz * dz) / dt / fullSpeed : 0;
    }
    this.lastPosition = position;
  }

  /** The live entity a driver's `TargetAimProvider` aims at, if any. */
  private aimTarget(): Entity | undefined {
    const target = this.aim instanceof TargetAimProvider ? this.aim.getTarget() : null;
    return target != null && !target.isDestroyed() ? target : undefined;
  }

  /** The shot never left: gives back the shooting ticket its claim took, if it claimed one. */
  onShotCancelled(): void {
    this.shotClaimed?.cancelShot(this.holder);
    this.shotClaimed = null;
  }

  onRoundFired(origin: Aim['origin'], direction: Aim['direction']): void {
    // The shot left, so its claim stands.
    this.shotClaimed = null;
    this.rounds++;
    if (this.bloomActive) {
      this.bloom?.shot();
    }
    this.onRound?.(origin, direction);
    this.gas.executeCue(
      FIRE_CUE_TAG,
      new GameplayCueContext({source: this.gas, sourceObject: this.holder, location: origin, normal: direction}),
    );
  }

  buildReloadConfig(): ReloadConfig | null {
    if (this.disposed || this.magazine == null) {
      return null;
    }
    return this.magazine.buildReloadConfig(() =>
      this.gas.executeCue(RELOAD_CUE_TAG, new GameplayCueContext({source: this.gas, sourceObject: this.holder})),
    );
  }
}

const equippedWeapons = new Map<Entity, ItemWeapon>();

/** The weapon a character currently holds on this machine (owner only), for input and AI to drive. */
export function equippedWeaponOf(character: Entity): ItemWeapon | null {
  return equippedWeapons.get(character) ?? null;
}

/** Whether `character` can be armed through its containers (it has an `EquipmentBinder`), even before anything is equipped. */
export function canEquipWeapon(character: Entity): boolean {
  return findOnCharacter(character, EquipmentBinder) != null;
}

addBeforeItemsLeaveListener(character => equippedWeaponOf(character)?.magazine?.report());

/** A loud weapon going off, as the server accepted it: a round leaving the weapon, or a thrown one detonating. */
export interface WeaponNoise {
  readonly kind: 'shot' | 'detonation';
  /** Who fired or threw. */
  readonly character: Entity;
  /** Where, as the server has it: the shooter, or the deployable that went off. */
  readonly position: Vec3;
  /** A round's path as its holder reported it: where it left (the muzzle, or a player's camera) and which way; null for a detonation. */
  readonly ray: {readonly origin: Vec3; readonly direction: Vec3} | null;
  /** The delivery's `loudness`, or its `detonationLoudness`; above 0. */
  readonly loudness: number;
}

export type WeaponNoiseListener = (noise: WeaponNoise) => void;

const noiseListeners = new Set<WeaponNoiseListener>();

/**
 * Server: hears every loud round and detonation the server accepts, players'
 * (reported by their owners) and NPCs' (run here) alike. A listener that throws
 * is logged and skipped: the others still hear it, and the report is still
 * accepted.
 */
export function addWeaponNoiseListener(listener: WeaponNoiseListener): () => void {
  noiseListeners.add(listener);
  return () => noiseListeners.delete(listener);
}

/** Farthest (m) a round's reported path may start from its holder: a player's `camera` aim starts at the camera, behind and above. */
const ROUND_START_REACH = 10;
/**
 * Least time (s) between reported rounds, a network budget: the holder
 * reports a fast gun's rounds no more often, and the server refuses a
 * character's reports beyond it (`REPORT_BURST` early ones absorb network
 * jitter). Nothing that listens depends on it.
 */
const ROUND_REPORT_INTERVAL = 0.2;
const REPORT_BURST = 2;

function isFinitePoint(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

const reportBudgets = new WeakMap<Entity, {slots: number; atSec: number}>();

/** Server: takes one of `character`'s report slots, which refill one per `ROUND_REPORT_INTERVAL`; false when none is left. */
function takeReportSlot(character: Entity): boolean {
  const now = WorldService.get().getWorldTime();
  const budget = reportBudgets.get(character) ?? {slots: REPORT_BURST, atSec: now};
  budget.slots = Math.min(REPORT_BURST, budget.slots + Math.max(0, now - budget.atSec) / ROUND_REPORT_INTERVAL);
  budget.atSec = now;
  reportBudgets.set(character, budget);
  if (budget.slots < 1) {
    return false;
  }
  budget.slots -= 1;
  return true;
}

/** Deployables whose detonation was heard: each is heard once. */
const heardDeployables = new WeakSet<Entity>();

function tell(noise: WeaponNoise): ItemResult {
  for (const listener of [...noiseListeners]) {
    try {
      listener(noise);
    } catch (error: unknown) {
      console.warn(`[Weapon] a weapon noise listener failed on a ${noise.kind}: ${String(error)}`);
    }
  }
  return ItemResult.done(1);
}

/**
 * Server: a round from the character's stack `uid`, if it is the loud weapon in
 * the character's hand, its reported path starts at the character, and the
 * character is within its report budget. Heard where the server has the
 * character; the path only serves near misses. `amount` 1 when accepted.
 */
function acceptShot({character, request, findStack}: ItemRequestContext): ItemResult {
  const found = findStack(request.uid);
  if (found == null) {
    return ItemResult.refused('missing');
  }
  if (findOnCharacter(character, EquipmentBinder)?.hand()?.item?.uid !== found.stack.uid) {
    return ItemResult.refused('invalid');
  }
  const loudness = itemRegistry.get(found.stack.defId)?.find(Weapon)?.config.delivery.loudness ?? 0;
  const at = character.getComponent(TransformComponent)?.worldPosition;
  const {position: origin, direction} = request;
  if (
    !(loudness > 0) ||
    at == null ||
    !isFinitePoint(origin) ||
    !isFinitePoint(direction) ||
    direction.magnitude() < 1e-6 ||
    Math.hypot(origin.x - at.x, origin.y - at.y, origin.z - at.z) > ROUND_START_REACH ||
    !takeReportSlot(character)
  ) {
    return ItemResult.refused('invalid');
  }
  return tell({kind: 'shot', character, position: at, ray: {origin, direction}, loudness});
}

/**
 * Server: the deployable `other`, thrown from a weapon of definition `key`,
 * going off. Heard once per deployable, where the server has it. The stack may
 * be gone, so nothing checks the character still holds one. `amount` 1 when
 * accepted.
 */
function acceptDetonation({character, request}: ItemRequestContext): ItemResult {
  const deployable = request.other;
  if (deployable == null || deployable.isDestroyed()) {
    return ItemResult.refused('missing');
  }
  const loudness = itemRegistry.get(request.key)?.find(Weapon)?.config.delivery.detonationLoudness ?? 0;
  const at = deployable.getComponent(TransformComponent)?.worldPosition;
  if (!(loudness > 0) || at == null || deployable.getComponent(GASDeployable) == null || heardDeployables.has(deployable)) {
    return ItemResult.refused('invalid');
  }
  heardDeployables.add(deployable);
  return tell({kind: 'detonation', character, position: at, ray: null, loudness});
}

registerItemRequestHandler('weapon.shot', acceptShot);
registerItemRequestHandler('weapon.detonation', acceptDetonation);

/**
 * Prefix of a weapon's attributes and ability ids. Starts with the animation
 * key because `EquipmentAnimationModule` picks the use/reload animation by
 * ability-id prefix (`{animKey}.`).
 */
export function weaponKeyOf(defId: string, weapon: Weapon): string {
  return `${weapon.config.animKey}.item.${defId}`;
}

/**
 * One shared equipment recipe for every weapon item: the per-weapon numbers
 * come from the source item's `Weapon` fragment, its `Magazine` fragment if
 * any, and the stack's magazine stat.
 *
 * Attributes and ability ids are keyed per item definition (`weaponKeyOf`),
 * so two copies of the same weapon must not be in effect at once on one character.
 */
export class WeaponEquipment extends EquipmentDefinition {
  constructor(private readonly registry: ItemRegistry = itemRegistry) {
    super('weapon');
  }

  override onEquip(ctx: EquipContext): EquipRevoker | null {
    const {source} = ctx;
    const definition = source != null ? this.registry.get(source.defId) : null;
    const weapon = definition?.find(Weapon) ?? null;
    if (source == null || weapon == null) {
      return null;
    }
    const magazineConfig = definition?.find(Magazine)?.config ?? null;
    const recalled = magazineConfig != null ? recallMagazine(source, magazineConfig.size) : null;
    const expendable = definition?.find(Expendable) != null;
    const loud = (weapon.config.delivery.loudness ?? 0) > 0;
    let lastReportSec = Number.NEGATIVE_INFINITY;
    let reportWarned = false;
    const warnOnce = (problem: string): void => {
      if (!reportWarned) {
        reportWarned = true;
        console.warn(`[Weapon] ${problem}; NPCs will not hear it.`);
      }
    };
    // Fire-and-forget, and never fails the shot or detonation that made it; one
    // warning per equip says when reports stop getting through.
    const report = (what: string, send: () => Promise<ItemResult>): void => {
      const notSent = (error: unknown): void => warnOnce(`could not report ${what} of '${source.defId}' (${String(error)})`);
      try {
        void send().then(result => {
          if (!result.complete) {
            warnOnce(`the server refused ${what} of '${source.defId}' (${result.refusal})`);
          }
        }, notSent);
      } catch (error: unknown) {
        notSent(error);
      }
    };
    const runtime = new ItemWeapon({
      holder: ctx.character,
      gas: ctx.gas,
      weapon,
      weaponKey: weaponKeyOf(source.defId, weapon),
      magazine:
        magazineConfig != null && recalled != null
          ? {config: magazineConfig, rounds: recalled.rounds, link: magazineLink(ctx.character, source.uid, magazineConfig.ammoTag)}
          : null,
      onRound:
        expendable || loud
          ? (origin: Vec3, direction: Vec3): void => {
              if (expendable) {
                void expendItem(ctx.character, source.uid);
              }
              const now = loud ? WorldService.get().getWorldTime() : 0;
              if (loud && now - lastReportSec >= ROUND_REPORT_INTERVAL) {
                lastReportSec = now;
                report('a loud round', () => reportShot(ctx.character, source.uid, origin, direction));
              }
            }
          : null,
      onDetonation: (deployable: Entity): void => {
        // The thrower can be gone by the time it goes off.
        if (!ctx.character.isDestroyed()) {
          report('a detonation', () => reportDetonation(ctx.character, source.defId, deployable));
        }
      },
    });
    equippedWeapons.set(ctx.character, runtime);
    ctx.everyFrame(() => runtime.tick());
    const offAnimationEvents = onCharacterAnimationEvent(ctx.character, name => runtime.handleAnimationEvent(name));
    return () => {
      offAnimationEvents();
      if (runtime.magazine != null) {
        rememberMagazine(ctx.character, source.uid, runtime.magazine.rounds, recalled?.stat);
      }
      runtime.dispose();
      if (equippedWeapons.get(ctx.character) === runtime) {
        equippedWeapons.delete(ctx.character);
      }
    };
  }

  override animKeyFor(source: EquipSource | null): string {
    return this.weaponFor(source)?.config.animKey ?? '';
  }

  override visualFor(source: EquipSource | null): EquipmentVisual | null {
    return this.weaponFor(source)?.config.visual ?? null;
  }

  private weaponFor(source: EquipSource | null): Weapon | null {
    return source != null ? (this.registry.get(source.defId)?.find(Weapon) ?? null) : null;
  }
}

export const weaponEquipment = new WeaponEquipment();

/**
 * A weapon: what every weapon has -- damage, fire rate, aim, hand model and a
 * delivery (`Hitscan`, `Melee`, ...). Also makes the item equippable through
 * the shared `weaponEquipment`. Guns add a `Magazine` fragment beside it.
 */
export class Weapon extends Equippable {
  constructor(readonly config: WeaponConfig) {
    super(weaponEquipment);
  }

  get healthAttribute(): string {
    return this.config.healthAttribute ?? HEALTH_ATTR;
  }

  /** Same tuning, same id: a remote target resolves the effect from this id alone. */
  get damageEffectId(): string {
    const hitCue = this.config.hitCueTag?.trim() ?? '';
    return `itemsystem.damage.${this.healthAttribute}:${String(this.config.damage)}${hitCue !== '' ? `:${hitCue}` : ''}`;
  }

  override onDefinitionRegistered(): void {
    const {config} = this;
    createDamageEffect(this.damageEffectId, config.damage, this.healthAttribute, hitCueTags(config.hitCueTag));
    config.delivery.onRegistered?.();
    if (config.remapper != null && !registerEquipmentRemapper(config.animKey, config.remapper)) {
      console.error(`[Weapon] animKey '${config.animKey}' already plays a different remapper; items sharing an animKey share its remapper.`);
    }
  }

  override validate(): string[] {
    const {config} = this;
    const errors: string[] = [];
    if (config.animKey === '') {
      errors.push('animKey must not be empty');
    }
    if (!(config.fireRate > 0)) {
      errors.push(`fireRate must be > 0, got ${String(config.fireRate)}`);
    }
    if (!(config.damage >= 0)) {
      errors.push(`damage must be >= 0, got ${String(config.damage)}`);
    }
    return [...errors, ...config.delivery.validate().map(error => `delivery: ${error}`)];
  }
}

/**
 * What a rationed shot (an NPC's, see {@link ShootingTickets}) aimed at
 * `aimedAt` may affect, decided as it is fired with `ticketed`:
 * - aimed at something no ticket protects: everything (fire at another NPC
 *   that strays onto a player is not rationed);
 * - aimed at a protected target without its ticket: nothing, the shot is a
 *   deliberate near miss and must not hurt whoever stands there either (its
 *   aim stays a near miss even if retargeted mid-shot);
 * - aimed at a protected target with its ticket: that target and anything no
 *   ticket protects; another protected target its splash or a pass-through
 *   reaches only while the shooter holds that one's ticket too.
 */
function rationedGate(holder: Entity, aimedAt: Maybe<Entity>, ticketed: boolean): (hit: Entity) => boolean {
  const tickets = ShootingTickets.get();
  const aimedRoot = tickets.rationedRootOf(aimedAt);
  return (hit: Entity): boolean => {
    if (aimedRoot == null) {
      return true;
    }
    if (!ticketed) {
      return false;
    }
    const root = tickets.rationedRootOf(hit);
    return root == null || root === aimedRoot || tickets.holds(holder, root);
  };
}
