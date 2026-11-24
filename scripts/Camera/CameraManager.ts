/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v11

/**
 * CameraManager - single camera component driving every camera mode.
 *
 * Component Attachment: Scene entity (NOT on player) - must have CameraPlatformComponent
 * Component Networking: Local (camera is client-only)
 * Component Ownership: Not networked - runs on all clients locally
 *
 * Put this one component on the scene `Camera` entity and pick a mode with the
 * `cameraMode` property. It is the live mode, not a load-time seed — the update
 * loop polls it every frame, so editing it in the editor swaps camera straight
 * away. Switching from script is a method call:
 *
 *   CameraManager.get()?.setMode(CameraModeType.FirstPerson);
 *
 * Both directions stay in sync: `setMode()` writes `cameraMode` back.
 *
 * No component is added or removed to change camera, so scene wiring, editor
 * property values and the active-camera registration all stay put. It also
 * means exactly one script owns the look-input subscription and the transform
 * write, which is what prevented several camera scripts coexisting before.
 *
 * Yaw and pitch live on the shared context rather than on any one mode, so
 * switching between the aimable modes preserves the player's heading.
 *
 * A scope holds a zoom over whatever the mode is (`setZoom`): a narrower field
 * of view, optionally framed from the player's eyes by the FirstPerson mode.
 * Look input slows with the zoom; a kick (`kick`, recoil) does not.
 *
 * Camera-relative locomotion is handled by `MovementAbility`.
 */

import {
  CameraComponent,
  CameraMode,
  CameraService,
  Component,
  ExecuteOn,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnLateWorldUpdateEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnWorldUpdateEventPayload,
  PlayerService,
  Quaternion,
  Service,
  TransformComponent,
  Vec3,
  WorldService,
  component,
  editor,
  property,
  subscribe,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';
import {AutoFaceRotationAbility} from '../Character/Abilities/AutoFaceRotationAbility';
import {
  type CameraModeContext,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
} from './CameraModeTypes';
import {AutoFollowMode} from './modes/AutoFollowMode';
import {ChaseMode} from './modes/ChaseMode';
import {FirstPersonMode} from './modes/FirstPersonMode';
import {FollowMode} from './modes/FollowMode';
import {IsometricMode} from './modes/IsometricMode';
import {OrbitMode} from './modes/OrbitMode';
import {SideScrollMode} from './modes/SideScrollMode';
import {StaticMode} from './modes/StaticMode';
import {OverShoulderMode} from './modes/OverShoulderMode';
import {ThirdPersonMode} from './modes/ThirdPersonMode';
import {TopDownMode} from './modes/TopDownMode';

// Usable CameraComponent ranges, deliberately tighter than the WSDK API
// (nearClip 0.001-1000, FOV 20-180): a remixed world can inherit a nearClip
// that clips the whole scene and reads as the camera stuck at ground level.
const MIN_NEAR_CLIP = 0.001;
const MAX_NEAR_CLIP = 0.05;
const DEFAULT_NEAR_CLIP = 0.01;
const DEFAULT_FAR_CLIP = 500;
const MIN_FOV = 20;
const MAX_FOV = 120;

/** A zoom the camera holds over whatever its mode asks for: a scope. */
export interface CameraZoom {
  /** Vertical field of view, in degrees. */
  fov: number;
  /** Frame from the target's eyes (`FirstPersonMode`), as through a scope, whatever the mode. Default false. */
  fromEyes?: boolean;
}

/**
 * How much a zoom to `zoomFov` slows look input on a camera whose mode shows
 * `fov` (both vertical, in degrees): the ratio of the two views' widths, so a
 * drag moves the picture as far across the screen zoomed in as out.
 */
export function zoomLookScale(zoomFov: number, fov: number): number {
  const halfWidth = (degrees: number): number => Math.tan((Math.max(MIN_FOV, Math.min(MAX_FOV, degrees)) * Math.PI) / 360);
  return halfWidth(zoomFov) / halfWidth(fov);
}

@component({
  description:
    'Single camera component that switches between all camera modes via the CameraModeType enum',
})
export class CameraManager extends Component {
  private static instance: Maybe<CameraManager> = null;

  public static get(): Maybe<CameraManager> {
    return CameraManager.instance;
  }

  private playerService = Service.inject(PlayerService);
  private worldService = Service.inject(WorldService);

  // ============================================
  // Mode Selection
  // ============================================

  /**
   * The live camera mode, not just the one used on load: the update loop polls
   * this every frame, so editing it swaps camera immediately. `setMode()` writes
   * back to it, so a programmatic switch cannot be reverted by the next poll.
   *
   * Values: 0 ThirdPerson, 1 FirstPerson, 2 Follow, 3 AutoFollow, 4 Orbit,
   * 5 TopDown, 6 Isometric, 7 SideScroll, 8 Chase, 9 Static, 10 OverShoulder.
   *
   * Typed `number` rather than `CameraModeType` on purpose. An enum-typed
   * `@property` reflects as `NativeTypeId::Enum`, which the live-property codec
   * does not handle — see `HSR_FOR_EACH_LIVE_PROPERTY_TYPE` in
   * `preview/LivePropertyValueCodec.h` — so every editor and workflow-panel
   * edit is rejected before it reaches this field and the camera never changes.
   * A plain number reflects as `Flt64`, which the codec does support. Restore
   * the enum type once that list gains an `Enum` case.
   */
  @editor({show: true})
  @property()
  public cameraMode: number = CameraModeType.ThirdPerson;

  // ============================================
  // Shared Tuning
  // ============================================

  /** Distance behind the player, for the orbiting modes. */
  @editor({show: true})
  @property()
  public targetDistance: number = 8;

  /** Pivot height above the player's feet. */
  @editor({show: true})
  @property()
  public shoulderHeight: number = 2;

  /** Horizontal pivot offset for an over-the-shoulder framing. */
  @editor({show: true})
  @property()
  public shoulderOffset: number = 0;

  /** Position smoothing speed. Higher = tighter follow. */
  @editor({show: true})
  @property()
  public translationSpeed: number = 5;

  /** Automatic rotation smoothing speed. Manual look input is immediate. */
  @editor({show: true})
  @property()
  public rotationSpeed: number = 8;

  /** Follow damping for the non-orbiting modes (top-down, iso, side-scroll). */
  @editor({show: true})
  @property()
  public followSpeed: number = 5;

  @editor({show: true})
  @property()
  public minPitch: number = -80;

  @editor({show: true})
  @property()
  public maxPitch: number = 5;

  /** Resting pitch; negative looks down. */
  @editor({show: true})
  @property()
  public defaultPitch: number = -15;

  @editor({show: true})
  @property()
  public fieldOfView: number = 60;

  @editor({show: true})
  @property()
  public enableCollision: boolean = true;

  /**
   * Off: the camera snaps to the nearest obstruction and snaps back as soon as
   * it clears. Right for interiors, walls and tight spaces, where any easing
   * lets a wall cover the view.
   *
   * On: the camera still snaps in, then eases back out at `translationSpeed`
   * once the obstruction clears. Right where many small obstacles (trees,
   * poles, foliage) keep passing between camera and player, so snapping back
   * out would make the camera jump constantly.
   */
  @editor({show: true})
  @property()
  public collisionSmoothing: boolean = false;

  // ============================================
  // Auto-Rotate (one-thumb support)
  // ============================================

  /**
   * Rotate yaw back behind the direction of travel (ThirdPerson) or the
   * player's facing (Follow) after the player stops
   * touching look input. Yaw only — pitch is never touched, and the camera
   * follows the player's position either way.
   *
   * Applies to ThirdPerson and Follow. Unrelated to `CameraModeType.AutoFollow`,
   * which is a separate mode that always tracks. Suppressed while the character
   * is strafing — see `buildTuning`.
   */
  @editor({show: true})
  @property()
  public autoRotateEnabled: boolean = true;

  /** Seconds of no look input before auto-rotate re-engages. */
  @editor({show: true})
  @property()
  public autoRotateDelay: number = 2.0;

  /**
   * Auto-rotate turn rate in degrees per second. ThirdPerson only; Follow eases
   * at `FollowMode.rotationRate`.
   */
  @editor({show: true})
  @property()
  public autoRotateSpeed: number = 50.0;

  /** Heading error below which auto-rotate does nothing. ThirdPerson only. */
  @editor({show: true})
  @property()
  public autoRotateDeadZone: number = 30.0;

  /** Seconds to ramp the auto-rotate turn rate from 0 to full, and back. ThirdPerson only. */
  @editor({show: true})
  @property()
  public autoRotateRampDuration: number = 0.5;

  // ============================================
  // Over-the-Shoulder (OverShoulder mode)
  // ============================================
  // The OverShoulder mode is ThirdPerson framed with these instead of
  // `targetDistance`, `shoulderHeight` and `shoulderOffset`; every other tuning
  // value, auto-rotate included, is shared.

  /** Distance behind the shoulder pivot. */
  @editor({show: true})
  @property()
  public overShoulderDistance: number = 3;

  /** Pivot height above the player's feet: about the shoulder. */
  @editor({show: true})
  @property()
  public overShoulderHeight: number = 1.7;

  /** Pivot offset to the camera's right; positive puts the player left of the crosshair. */
  @editor({show: true})
  @property()
  public overShoulderOffset: number = 0.6;

  /** Pitch the mode starts at, before look input; negative looks down. */
  @editor({show: true})
  @property()
  public overShoulderPitch: number = -5;

  // ============================================
  // Runtime State
  // ============================================

  /** The FirstPerson mode, which also frames a zoom from the eyes over any other mode. */
  private readonly eyeView = new FirstPersonMode();

  private readonly modes: ReadonlyMap<CameraModeType, ICameraMode> = new Map<
    CameraModeType,
    ICameraMode
  >([
    [CameraModeType.ThirdPerson, new ThirdPersonMode()],
    [CameraModeType.FirstPerson, this.eyeView],
    [CameraModeType.Follow, new FollowMode()],
    [CameraModeType.AutoFollow, new AutoFollowMode()],
    [CameraModeType.Orbit, new OrbitMode()],
    [CameraModeType.TopDown, new TopDownMode()],
    [CameraModeType.Isometric, new IsometricMode()],
    [CameraModeType.SideScroll, new SideScrollMode()],
    [CameraModeType.Chase, new ChaseMode()],
    [CameraModeType.Static, new StaticMode()],
    [CameraModeType.OverShoulder, new OverShoulderMode()],
  ]);

  private activeMode: ICameraMode | null = null;
  private activeModeType: CameraModeType = CameraModeType.ThirdPerson;
  private context: CameraModeContext | null = null;

  // Re-resolved by refreshTarget() on every respawn, alongside the context.
  private strafeSource: Maybe<AutoFaceRotationAbility> = null;
  private authoredPosition: Vec3 | null = null;
  private authoredRotation: Quaternion | null = null;
  private appliedFov: number | null = null;
  private zoom: CameraZoom | null = null;
  private framedFromEyes = false;
  private pendingLookYaw: number = 0;
  private pendingLookPitch: number = 0;

  // ============================================
  // Lifecycle
  // ============================================

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    CameraManager.instance = this;
    this.activeModeType = this.cameraMode as CameraModeType;

    // Snapshot before any mode runs; Static mode frames from this pose.
    const cameraTransform = this.entity.getComponent(TransformComponent);
    if (cameraTransform) {
      this.authoredPosition = cameraTransform.worldPosition;
      this.authoredRotation = cameraTransform.worldRotation;
    }

    this.refreshTarget();
    this.activateCustomCamera();
  }

  /**
   * The engine resets camera mode when a player spawns, so re-acquire the
   * target and re-assert Custom mode. Gated on `isLocal` so a remote player
   * joining does not reset the local view.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (NetworkingService.get().isServerContext() || !payload.isLocal) {
      return;
    }

    this.refreshTarget();
    this.activateCustomCamera();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    this.activeMode?.onDeactivate?.();
    this.dropEyeView();
    this.activeMode = null;
    this.context = null;
    if (CameraManager.instance === this) {
      CameraManager.instance = null;
    }
  }

  // ============================================
  // Public API
  // ============================================

  /** Switch camera mode. No component is added or removed. */
  public setMode(mode: CameraModeType): void {
    if (mode === this.activeModeType && this.activeMode !== null) {
      return;
    }

    this.activeModeType = mode;
    // Keeps the authored property the single source of truth for "current
    // camera", so the per-frame poll below sees no divergence and cannot snap a
    // programmatic switch back to the authored value on the next frame.
    this.cameraMode = mode;

    const next = this.modes.get(mode);
    if (!next) {
      console.warn(`[CameraManager] Unknown camera mode: ${mode}`);
      return;
    }

    // With no context yet the mode is recorded and activated by refreshTarget()
    // once the local player exists.
    if (!this.context) {
      return;
    }

    this.activeMode?.onDeactivate?.();
    this.dropEyeView();
    this.activeMode = next;
    next.onActivate?.(this.context, this.buildTuning());
    this.resetFovOverride();
  }

  public getActiveModeType(): CameraModeType {
    return this.activeModeType;
  }

  /**
   * Feed a look delta in degrees: the touch `Look` drag via
   * PlayerActionController, or ClickToMoveController's drag-to-rotate. A zoom
   * slows it by `zoomLookScale`. Accumulates into pending deltas drained once
   * per frame, so a mode sees one delta per frame, and stamps
   * `lastLookInputTime` so auto-rotate stays suppressed during a drag.
   */
  public addLookDelta(deltaYaw: number, deltaPitch: number): void {
    const scale = this.zoom != null ? zoomLookScale(this.zoom.fov, this.sanitizedFieldOfView()) : 1;
    this.kick(deltaYaw * scale, deltaPitch * scale);
  }

  /** Turns the camera by exactly these degrees, as a weapon's recoil does: unlike look input, a zoom does not slow it. */
  public kick(deltaYaw: number, deltaPitch: number): void {
    this.pendingLookYaw += deltaYaw;
    this.pendingLookPitch += deltaPitch;

    if (this.context) {
      this.context.lastLookInputTime = this.worldService.getWorldTime();
    }
  }

  /** Holds `zoom` over the mode (a scope); null hands the view back to the mode. */
  public setZoom(zoom: CameraZoom | null): void {
    this.zoom = zoom;
  }

  /** The vertical field of view, in degrees, the camera is set to: a scope's zoom, else the mode's. */
  public get currentFieldOfView(): number {
    return this.appliedFov ?? this.sanitizedFieldOfView();
  }

  /** Advance to the next mode in enum order, wrapping at the end. */
  public cycleMode(): void {
    const types = Array.from(this.modes.keys());
    const index = types.indexOf(this.activeModeType);
    this.setMode(types[(index + 1) % types.length]);
  }

  /**
   * The mode instance, for tuning knobs that are specific to one mode (e.g.
   * `getMode(CameraModeType.Isometric)` exposes `orthoSize`).
   */
  public getMode(mode: CameraModeType): ICameraMode | undefined {
    return this.modes.get(mode);
  }

  // ============================================
  // Update Loop
  // ============================================

  @subscribe(OnLateWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onLateUpdate(event: OnWorldUpdateEventPayload): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    this.eyeView.retryBodyRestoration();

    // Polled rather than event-driven: an editor property write lands straight
    // on the field with no hook to subscribe to, so comparing is the only way to
    // notice one. Runs before the context guard so a mode edited while the local
    // player is still spawning is the one refreshTarget() activates.
    if (this.cameraMode !== this.activeModeType) {
      this.setMode(this.cameraMode as CameraModeType);
    }

    if (!this.context || !this.activeMode) {
      this.refreshTarget();
      return;
    }

    const ctx = this.context;

    // Guard against a destroyed target (e.g. player respawning/disconnecting)
    if (ctx.targetEntity.isDestroyed()) {
      this.activeMode?.onDeactivate?.();
      this.dropEyeView();
      this.activeMode = null;
      this.context = null;
      this.refreshTarget();
      return;
    }

    ctx.worldTime = this.worldService.getWorldTime();
    ctx.lookDeltaYaw = this.pendingLookYaw;
    ctx.lookDeltaPitch = this.pendingLookPitch;
    this.pendingLookYaw = 0;
    this.pendingLookPitch = 0;

    const result = this.framingMode(ctx, this.activeMode).update(
      ctx,
      this.buildTuning(),
      event.deltaTime,
    );

    ctx.lookDeltaYaw = 0;
    ctx.lookDeltaPitch = 0;

    if (!result) {
      return;
    }

    ctx.cameraTransform.worldPosition = result.position;
    ctx.cameraTransform.worldRotation = result.rotation;

    this.applyFov(this.zoom?.fov ?? result.fov);
  }

  // ============================================
  // Internals
  // ============================================

  /**
   * The eye view while a zoom looks from the eyes and the active mode is not
   * already there, else the active mode. Whichever takes over is activated, so
   * it starts from the shared yaw and pitch; the active mode comes back framing
   * from where it would have been.
   */
  private framingMode(ctx: CameraModeContext, active: ICameraMode): ICameraMode {
    const fromEyes = this.zoom?.fromEyes === true && this.activeModeType !== CameraModeType.FirstPerson;
    if (fromEyes !== this.framedFromEyes) {
      this.framedFromEyes = fromEyes;
      const [leaving, taking] = fromEyes ? [active, this.eyeView] : [this.eyeView, active];
      leaving.onDeactivate?.();
      taking.onActivate?.(ctx, this.buildTuning());
    }
    return fromEyes ? this.eyeView : active;
  }

  /** Before the active mode is (re)activated: a zoom still from the eyes takes the next frame over again from it. */
  private dropEyeView(): void {
    if (this.framedFromEyes) {
      this.framedFromEyes = false;
      this.eyeView.onDeactivate?.();
    }
  }

  /**
   * Auto-rotate and strafe are mutually exclusive. Strafing faces the character
   * at camera-forward, so letting auto-rotate chase the movement direction turns
   * the two into a feedback loop: the camera swings toward the strafe, the
   * character re-faces the new camera-forward, and the strafe direction moves
   * with it. Gated here rather than in the modes so they stay unaware of
   * gameplay, and per-frame so a strafe toggled at runtime is picked up.
   */
  private buildTuning(): CameraTuning {
    const strafing = this.strafeSource?.strafeMode ?? false;
    return {
      targetDistance: this.targetDistance,
      shoulderHeight: this.shoulderHeight,
      shoulderOffset: this.shoulderOffset,
      translationSpeed: this.translationSpeed,
      rotationSpeed: this.rotationSpeed,
      followSpeed: this.followSpeed,
      defaultPitch: this.defaultPitch,
      minPitch: this.minPitch,
      maxPitch: this.maxPitch,
      fieldOfView: this.sanitizedFieldOfView(),
      enableCollision: this.enableCollision,
      collisionSmoothing: this.collisionSmoothing,
      autoRotateEnabled: this.autoRotateEnabled && !strafing,
      autoRotateDelay: this.autoRotateDelay,
      autoRotateSpeed: this.autoRotateSpeed,
      autoRotateDeadZone: this.autoRotateDeadZone,
      autoRotateRampDuration: this.autoRotateRampDuration,
      overShoulderDistance: this.overShoulderDistance,
      overShoulderHeight: this.overShoulderHeight,
      overShoulderOffset: this.overShoulderOffset,
      overShoulderPitch: this.overShoulderPitch,
    };
  }

  private refreshTarget(): void {
    const localPlayer: Entity | null = this.playerService.getLocalPlayer();
    if (!localPlayer) {
      return;
    }

    const targetTransform = localPlayer.getComponent(TransformComponent);
    const cameraTransform = this.entity.getComponent(TransformComponent);
    if (!targetTransform || !cameraTransform) {
      return;
    }

    this.strafeSource = localPlayer.getComponent(AutoFaceRotationAbility);

    const previous = this.context;
    this.context = {
      cameraEntity: this.entity,
      cameraTransform,
      cameraComponent: this.entity.getComponent(CameraComponent),
      targetEntity: localPlayer,
      targetTransform,
      authoredPosition: this.authoredPosition ?? cameraTransform.worldPosition,
      authoredRotation: this.authoredRotation ?? cameraTransform.worldRotation,
      yaw: previous?.yaw ?? 0,
      pitch: previous?.pitch ?? this.defaultPitch,
      lookDeltaYaw: 0,
      lookDeltaPitch: 0,
      lastLookInputTime: 0,
      worldTime: this.worldService.getWorldTime(),
    };

    // Re-activate so the mode drops stale per-respawn state (auto-rotate
    // history, collision timers, the Static anchor).
    this.activeMode?.onDeactivate?.();
    this.dropEyeView();
    this.activeMode = this.modes.get(this.activeModeType) ?? null;
    this.activeMode?.onActivate?.(this.context, this.buildTuning());
    this.resetFovOverride();
  }

  private activateCustomCamera(): void {
    const cameraComponent = this.entity.getComponent(CameraComponent);
    if (!cameraComponent) {
      console.warn(
        '[CameraManager] CameraComponent not found. Add CameraPlatformComponent to this entity.',
      );
      return;
    }

    this.sanitizeCameraComponent(cameraComponent);

    CameraService.get().setCameraMode(CameraMode.Custom, {
      camera: cameraComponent,
      fov: this.sanitizedFieldOfView(),
      duration: 0.3,
    });
    this.appliedFov = this.sanitizedFieldOfView();
  }

  private applyFov(requested: number | undefined): void {
    const target = requested ?? this.sanitizedFieldOfView();
    const clamped = Math.max(MIN_FOV, Math.min(MAX_FOV, target));
    if (this.appliedFov !== null && Math.abs(clamped - this.appliedFov) < 0.1) {
      return;
    }
    this.appliedFov = clamped;
    CameraService.get().overrideCameraFOV({fov: clamped, duration: 0.1});
  }

  private resetFovOverride(): void {
    // Force the next applyFov to write, so a mode that drove FOV (Chase) does
    // not leave its zoom behind after a switch.
    this.appliedFov = null;
  }

  /**
   * Resets camera-component values that fall outside a viable range. Guards
   * against inherited configs (e.g. from a remixed source world) whose
   * nearClippingPlane is large enough to clip the entire scene. NaN is caught
   * two ways: the near-plane clamp uses an explicit Number.isNaN check, while
   * the far-plane reset relies on the negated comparison !(far > near), which
   * is true for NaN.
   */
  private sanitizeCameraComponent(cameraComponent: CameraComponent): void {
    const near = cameraComponent.nearClippingPlane;
    const clampedNear = Math.max(
      MIN_NEAR_CLIP,
      Math.min(MAX_NEAR_CLIP, Number.isNaN(near) ? DEFAULT_NEAR_CLIP : near),
    );
    if (clampedNear !== near) {
      console.warn(
        `[CameraManager] nearClippingPlane ${near} out of range [${MIN_NEAR_CLIP}, ${MAX_NEAR_CLIP}]; using ${clampedNear}.`,
      );
      cameraComponent.nearClippingPlane = clampedNear;
    }

    if (
      !(cameraComponent.farClippingPlane > cameraComponent.nearClippingPlane)
    ) {
      console.warn(
        `[CameraManager] farClippingPlane ${cameraComponent.farClippingPlane} <= nearClippingPlane; resetting to ${DEFAULT_FAR_CLIP}.`,
      );
      cameraComponent.farClippingPlane = DEFAULT_FAR_CLIP;
    }
  }

  private sanitizedFieldOfView(): number {
    const fov = this.fieldOfView;
    if (!(fov >= MIN_FOV) || fov > MAX_FOV) {
      return Math.max(
        MIN_FOV,
        Math.min(MAX_FOV, Number.isNaN(fov) ? 60 : fov),
      );
    }
    return fov;
  }
}
