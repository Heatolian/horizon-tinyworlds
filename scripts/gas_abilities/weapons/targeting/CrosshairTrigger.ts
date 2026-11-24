/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v14

import {
  CameraService,
  CastMode,
  CollisionLayerMask,
  Component,
  component,
  editor,
  ExecuteOn,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  PhysicsService,
  PlayerService,
  property,
  subscribe,
  type EventSubscription,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {CameraManager} from '../../../Camera/CameraManager';
import {AutoFaceRotationAbility} from '../../../Character/Abilities/AutoFaceRotationAbility';
import {InputActionsManager, type InputActionChangeEvent} from '../../../Input/InputActionsManager';
import {TouchControlsHud} from '../../../Input/TouchControlsHud';
import {equippedWeaponOf, type ItemWeapon} from '../../../ItemSystem/features/Weapon';
import {Recoil} from '../../../ItemSystem/features/WeaponFeel';
import {firstTargetHit, type TargetFilter} from './Targeting';

/** Hits read per probe; the player's own colliders come first and are skipped. */
const MAX_PROBE_HITS = 16;

/** Whether the HUD crosshair shows for `weapon` outside a scope: an `auto` weapon, or a `manual` one aimed along the camera. */
export function showsCrosshair(weapon: Pick<ItemWeapon, 'aimMode' | 'config'>): boolean {
  return weapon.aimMode === 'auto' || (weapon.aimMode === 'manual' && (weapon.config.aimSource ?? 'camera') === 'camera');
}

/**
 * The simple aiming mode: fires the weapon in hand while the crosshair is on a
 * target. Every frame, with one query in flight at a time, it casts the ray a
 * shot along the camera travels (the screen centre, `CameraAimProvider`) out to
 * the weapon's reach, and fires when the first thing past the player belongs to
 * a target: it has GAS, carries the weapon's `targetTag` (or
 * `fallbackTargetTag` when the weapon has none) and not `blockedTargetTag`.
 * The weapon's fire ability still owns cooldown, ammo and reload, so this only
 * decides when to pull the trigger.
 *
 * The weapon's `aimMode` decides whether it does: `auto` fires on sight;
 * `scoped` and `manual` (the default, and melee) leave firing to the Use
 * button. Each press of the `Aim` action looks through a `scoped` weapon's
 * sight, or back out: the camera zooms to its `scopeFov` from the player's
 * eyes and the HUD shows the scope overlay instead of the crosshair. Through
 * the scope the shot is the player's to take. While firing or scoped, the body
 * turns to the camera's heading so the gun points where the shots go. The HUD
 * crosshair shows for an `auto` weapon and for a `manual` one aimed along the
 * camera, and turns red while it is on a target.
 *
 * It also gives the player's shots their feel, however they were fired: each
 * round kicks the camera by the weapon's `recoil` and lets it settle back, and
 * the weapon's `bloom` spreads the shots (the crosshair ring frames the whole spread as it shows on screen). A kick
 * can lift the crosshair off a target; `targetGraceSec` keeps an automatic
 * weapon firing through that.
 *
 * Component Attachment: the player character root, beside
 * `AutoFaceRotationAbility`.
 * Component Networking: owner only; shots go through the weapon's GAS ability.
 */
@component({
  description: "Fires the weapon in hand while the screen-centre crosshair is on a target, for weapons whose aimMode is auto; Aim looks through a scoped weapon's sight.",
})
export class CrosshairTrigger extends Component {
  @editor({description: 'Target tag for a weapon with no targetTag of its own. With neither, it never fires.'})
  @property()
  public fallbackTargetTag: string = 'enemy';

  @editor({description: 'Targets carrying this tag are never fired at.'})
  @property()
  public blockedTargetTag: string = 'state.dead';

  @editor({description: 'Turn the body to the camera heading while firing.'})
  @property()
  public faceAimWhileFiring: boolean = true;

  @editor({description: 'Seconds it keeps firing after the crosshair leaves a target, so recoil does not stutter an automatic weapon.'})
  @property()
  public targetGraceSec: number = 0.15;

  @editor({description: 'Seconds the crosshair ring takes to follow most of a change in spread, so it eases rather than jumps. 0 snaps.'})
  @property()
  public crosshairEaseSec: number = 0.08;

  private facing: Maybe<AutoFaceRotationAbility> = null;
  private onTarget: boolean = false;
  private probing: boolean = false;
  private facingOverridden: boolean = false;
  private destroyed: boolean = false;
  /** Set on the first update that runs: this is the local player's trigger. */
  private local: boolean = false;
  private warnedNoTargetTag: boolean = false;
  private warnedProbeFailed: boolean = false;
  private shownCrosshair: string = '';
  private displayedSpreadDeg: number = 0;
  private aiming: boolean = false;
  private aimedWeapon: ItemWeapon | null = null;
  private scopedFov: number | null = null;
  private aimSubscription: EventSubscription | null = null;
  private sinceOnTargetSec: number = Number.POSITIVE_INFINITY;
  private feltWeapon: ItemWeapon | null = null;
  private recoil: Recoil | null = null;
  private feltRounds: number = 0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  private onStart(): void {
    this.facing = this.entity.getComponent(AutoFaceRotationAbility);
  }

  /** Input is local and may start after this component; subscribed on the first update that finds it. */
  private subscribeAim(): void {
    const manager = InputActionsManager.instance;
    if (this.aimSubscription != null || manager == null) {
      return;
    }
    this.aimSubscription = manager.subscribeAction('Aim', (event: InputActionChangeEvent): void => {
      if (event.newValue as boolean) {
        this.aiming = !this.aiming;
      }
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  private onDestroy(): void {
    this.destroyed = true;
    this.aimSubscription?.disconnect();
    this.aimSubscription = null;
    // The HUD and camera are the local player's; a trigger that never ran must not reset them.
    if (!this.local) {
      return;
    }
    this.releaseFacing();
    this.scope(null);
    this.showCrosshair(false, false, 0);
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  private onUpdate(payload: OnWorldUpdateEventPayload): void {
    // Input, camera and HUD are the local player's. A bot player is built from the
    // same template but owned by the server, where this would aim with the server's camera.
    if (PlayerService.get().getLocalPlayer() !== this.entity) {
      return;
    }
    this.local = true;
    this.subscribeAim();
    const weapon = equippedWeaponOf(this.entity);
    if (weapon !== this.aimedWeapon) {
      // A swap or drop ends the aim: the next scoped weapon needs its own press.
      this.aimedWeapon = weapon;
      this.aiming = false;
    }
    const scoped = weapon?.aimMode === 'scoped' && this.aiming;
    this.scope(scoped && weapon != null ? weapon.scopeFov : null);
    this.feel(weapon, scoped, payload.deltaTime);
    if (scoped) {
      this.onTarget = false;
      this.sinceOnTargetSec = Number.POSITIVE_INFINITY;
      this.showCrosshair(false, false, 0);
      this.faceCamera();
      return;
    }
    if (weapon == null || !showsCrosshair(weapon)) {
      this.onTarget = false;
      this.sinceOnTargetSec = Number.POSITIVE_INFINITY;
      this.releaseFacing();
      this.showCrosshair(false, false, 0);
      return;
    }
    this.showCrosshair(true, this.onTarget, weapon.crosshairSpreadDeg, payload.deltaTime);
    if (!this.probing) {
      void this.probe(weapon).catch((error: unknown): void => {
        // A failed probe has seen nothing: fail closed, or a run of failures keeps firing.
        this.onTarget = false;
        if (!this.warnedProbeFailed) {
          this.warnedProbeFailed = true;
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- latched: warns on the first failed probe only.
          console.warn(`[CrosshairTrigger] crosshair probe failed: ${String(error)}`);
        }
      });
    }
    if (!this.armed(weapon)) {
      this.sinceOnTargetSec = Number.POSITIVE_INFINITY;
      this.releaseFacing();
      return;
    }
    this.sinceOnTargetSec = this.onTarget ? 0 : this.sinceOnTargetSec + payload.deltaTime;
    if (this.sinceOnTargetSec > Math.max(0, this.targetGraceSec)) {
      this.releaseFacing();
      return;
    }
    this.faceCamera();
    weapon.fireOnce();
  }

  /** Recoil and bloom for the weapon in hand: kicks for the rounds fired since last frame, then settles. */
  private feel(weapon: ItemWeapon | null, scoped: boolean, dt: number): void {
    if (weapon !== this.feltWeapon) {
      this.feltWeapon = weapon;
      this.recoil = weapon?.config.recoil != null ? new Recoil(weapon.config.recoil) : null;
      this.feltRounds = weapon?.roundsFired ?? 0;
    }
    if (weapon == null) {
      return;
    }
    weapon.bloomActive = true;
    weapon.steadied = scoped;
    const camera = CameraManager.get();
    const recoil = this.recoil;
    if (recoil == null || camera == null) {
      this.feltRounds = weapon.roundsFired;
      return;
    }
    for (; this.feltRounds < weapon.roundsFired; this.feltRounds++) {
      const kick = recoil.kick();
      camera.kick(kick.yaw, kick.pitch);
    }
    const settle = recoil.recover(dt);
    if (settle !== 0) {
      camera.kick(0, settle);
    }
  }

  /** Whether the weapon in hand fires by itself. */
  private armed(weapon: ItemWeapon): boolean {
    return weapon.aimMode === 'auto';
  }

  /** Looks through a scope (the camera zoomed from the eyes, the HUD's scope overlay), or back out; writes only on a change. */
  private scope(fov: number | null): void {
    if (fov === this.scopedFov) {
      return;
    }
    this.scopedFov = fov;
    CameraManager.get()?.setZoom(fov != null ? {fov, fromEyes: true} : null);
    TouchControlsHud.instance?.setScopeVisible(fov != null);
  }

  private async probe(weapon: ItemWeapon): Promise<void> {
    const filter = this.filterFor(weapon);
    if (filter == null) {
      this.onTarget = false;
      return;
    }
    this.probing = true;
    try {
      const camera = CameraService.get();
      const origin = camera.position;
      // The camera sits behind the player, so the ray must also cover the gap to the body.
      const body = this.entity.getComponent(TransformComponent)?.worldPosition ?? origin;
      const result = await PhysicsService.get().rayCast({
        mode: CastMode.UnsortedHits,
        origin,
        dir: camera.forward,
        distance: weapon.reach + body.distance(origin),
        collisionLayerMask: CollisionLayerMask.AllLayers,
        includeTriggers: false,
        excludeEntities: [this.entity] as [Entity],
        maxUnsortedHits: MAX_PROBE_HITS,
      });
      if (this.destroyed || equippedWeaponOf(this.entity) !== weapon) {
        this.onTarget = false;
        return;
      }
      this.onTarget = firstTargetHit(result.hits ?? [], this.entity, filter) != null;
    } finally {
      this.probing = false;
    }
  }

  /** Null with no target tag at all: firing at anything with GAS would hit teammates, so it does not fire. */
  private filterFor(weapon: ItemWeapon): TargetFilter | null {
    const required = weapon.targetTag.trim() || this.fallbackTargetTag.trim();
    if (required === '') {
      if (!this.warnedNoTargetTag) {
        this.warnedNoTargetTag = true;
        console.warn('[CrosshairTrigger] no weapon targetTag and an empty fallbackTargetTag; not firing, to avoid friendly fire.');
      }
      return null;
    }
    const blocked = this.blockedTargetTag.trim();
    return {required: [required], blocked: blocked !== '' ? [blocked] : undefined};
  }

  private faceCamera(): void {
    if (!this.faceAimWhileFiring || this.facing == null) {
      return;
    }
    const forward = CameraService.get().forward;
    this.facing.setFacingOverride(new Vec3(forward.x, 0, forward.z));
    this.facingOverridden = true;
  }

  /** Eases the ring toward `spreadDeg` and writes the HUD only on a change; it binds straight to the view model. */
  private showCrosshair(visible: boolean, onTarget: boolean, spreadDeg: number, dt: number = 0): void {
    const ease = this.crosshairEaseSec > 0 ? 1 - Math.exp(-Math.max(0, dt) / this.crosshairEaseSec) : 1;
    this.displayedSpreadDeg = visible ? this.displayedSpreadDeg + (spreadDeg - this.displayedSpreadDeg) * ease : spreadDeg;
    const spread = Math.round(this.displayedSpreadDeg * 100) / 100;
    const fov = Math.round((CameraManager.get()?.currentFieldOfView ?? 60) * 10) / 10;
    const state = `${String(visible)}:${String(onTarget)}:${String(spread)}:${String(fov)}`;
    const hud = TouchControlsHud.instance;
    if (hud == null || state === this.shownCrosshair) {
      return;
    }
    this.shownCrosshair = state;
    hud.setCrosshair(visible, onTarget, spread, fov);
  }

  private releaseFacing(): void {
    if (this.facingOverridden) {
      this.facingOverridden = false;
      this.facing?.setFacingOverride(null);
    }
  }
}
