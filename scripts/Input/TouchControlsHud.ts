/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v19

import {
  component,
  Component,
  property,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  CustomUiComponent,
  ExecuteOn,
  NetworkingService,
  Vec2,
  uiViewModel,
  UiViewModel,
  CameraService,
} from 'meta/worlds';
import type {Maybe, TextureAsset} from 'meta/worlds';
import {InputActionsManager} from './InputActionsManager';
import {getTouchMovementScheme, TouchMovementScheme} from './TouchMovementScheme';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// Design resolution (matches the XAML authoring resolution). Selected by
// `landscape` and used to convert button geometry to a runtime hit rect.
const DESIGN_WIDTH_PORTRAIT = 1080;
const DESIGN_HEIGHT_PORTRAIT = 2340;
const DESIGN_WIDTH_LANDSCAPE = 2340;
const DESIGN_HEIGHT_LANDSCAPE = 1080;
/** Radius, in design units, of the crosshair ring at scale 1: the XAML ring is 44 across. */
export const CROSSHAIR_RING_RADIUS = 22;

/**
 * The crosshair ring's scale that frames a cone of half-angle `spreadDeg` as a
 * camera with vertical field of view `fovDeg` projects it onto a HUD
 * `designHeight` units tall; never below 1, the ring at rest.
 */
export function crosshairScale(spreadDeg: number, fovDeg: number, designHeight: number): number {
  const toRad = Math.PI / 180;
  const halfFov = Math.min(179, Math.max(1, fovDeg)) * toRad * 0.5;
  const radius = (Math.tan(Math.min(89, Math.max(0, spreadDeg)) * toRad) / Math.tan(halfFov)) * (designHeight / 2);
  return Math.max(1, radius / CROSSHAIR_RING_RADIUS);
}

// ============================================================================
// ViewModel — per-button visibility, enabled, and pressed flags.
//
// Buttons no longer use Noesis <Button> Command bindings. Touch is delivered by
// the shared TouchRouter, so each XAML button is a display-only visual: its
// pressed look binds to a `*Pressed` flag the router handlers set, and its
// Visibility / IsEnabled bind to the existing `*Visible` / `*Enabled` flags.
// ============================================================================

@uiViewModel()
export class TouchControlsHudViewModel extends UiViewModel {
  override readonly events = {};

  // Per-button visibility (bound to Button.Visibility in the XAML).
  jumpVisible: boolean = false;

  // Per-button enabled state (bound to Button.IsEnabled in the XAML).
  jumpEnabled: boolean = true;

  // Per-button pressed state (bound to a scale change in the XAML).
  jumpPressed: boolean = false;

  // Contextual: InteractionControlsBridge shows this only while the interactor
  // has a WSDK candidate, so it starts hidden.
  interactVisible: boolean = false;
  interactEnabled: boolean = true;
  interactPressed: boolean = false;

  // Contextual: PlayerItemInput shows this only while the local player holds
  // an item, so it starts hidden.
  dropVisible: boolean = false;
  dropEnabled: boolean = true;
  dropPressed: boolean = false;

  useVisible: boolean = false;
  useEnabled: boolean = true;
  usePressed: boolean = false;
  useIcon: Maybe<TextureAsset> = null;

  reloadVisible: boolean = false;
  reloadEnabled: boolean = true;
  reloadPressed: boolean = false;
  reloadIcon: Maybe<TextureAsset> = null;

  // Contextual: PlayerItemInput shows this only while switching would pick
  // another equippable item.
  switchWeaponVisible: boolean = false;
  switchWeaponEnabled: boolean = true;
  switchWeaponPressed: boolean = false;
  // Contextual: PlayerItemInput shows this only while the weapon in hand is scoped.
  aimVisible: boolean = false;
  aimEnabled: boolean = true;
  aimPressed: boolean = false;
  // Contextual: DodgeRollAbility shows this only on a local player that can roll.
  dodgeVisible: boolean = false;
  dodgeEnabled: boolean = true;
  dodgePressed: boolean = false;
  // The screen-centre crosshair: CrosshairTrigger shows it while a weapon that fires by
  // itself is in hand, and flags it while it is on a target.
  crosshairVisible: boolean = false;
  crosshairOnTarget: boolean = false;
  // Grows with the weapon's spread, so the ring shows where shots can land.
  crosshairScale: number = 1;
  // The view through a scoped weapon's sight: CrosshairTrigger shows it while one is aimed.
  scopeVisible: boolean = false;
}

// ============================================================================
// Button config — the tunable table a creator edits to add or shape a button.
//
// Each button carries its DESIGN-space geometry for both orientations: `geom`
// (portrait) and `geomLandscape`. Geometry is bottom-right anchored (matching
// the built-in GameplayControls and the Canvas.Right/Canvas.Bottom in the XAML):
// `right`/`bottom` are the design-px insets from the bottom-right corner and
// `w`/`h` are the button size. effectiveConfigs() selects one by `this.landscape`
// (set it to match the copied XAML build: TouchControlsHud.portrait.xaml /
// .landscape.xaml), and rectFor() converts it to a normalized (0..1) hit rect at
// touch time using the panel's ACTUAL logical size (logicalDims), so the hit
// zone tracks the visible button on any device aspect. A statically-normalized
// rect (design / 1920) is right on x but offset on y on a non-design aspect,
// because the fill Canvas overscans and the button is bottom-anchored.
//
// Eight buttons ship: Jump starts hidden, the rest are contextual. Add others
// only when the prompt asks for them. A new button needs all of these to agree
// (details in "Add a button" in scripts/Input/README.md):
//   1. InputActionsManager.ts: defineAction('<Action>', ActionType.Button).
//   2. TouchControlsHudViewModel above: <action>Visible, <action>Enabled and
//      <action>Pressed flags.
//   3. BUTTON_CONFIGS: a row naming the action, the three flag keys, `geom`
//      (portrait) and `geomLandscape`, and its touch fields (below); add the
//      rects to the tables below.
//   4. A display-only <Button> (no Command) bound to those flags in
//      UI/TouchControlsHud.portrait.xaml, UI/TouchControlsHud.xaml (keep it
//      identical to portrait) and UI/TouchControlsHud.landscape.xaml, with
//      Width, Height, Canvas.Right and Canvas.Bottom identical to geom /
//      geomLandscape. The router hit-tests BUTTON_CONFIGS, not the XAML.
//   5. A white-on-transparent icon in UI/icons/, built with build_assets and
//      with premultiplyAlpha set on the texture.
// Touch fields: `momentary` (tap vs hold), `passThrough` and `holdMode`, with
// optional landscape overrides. The default claims the press and lets go when
// the finger slides off, so a drag that starts on a button never turns the
// camera. A fire button in the camera zone (portrait top half, landscape right
// half) needs momentary false, passThrough true and HoldUntilRelease to fire
// and aim with one finger; Use ships that way in landscape only, because its
// portrait rect is below the camera zone. Copy Use's row for a new fire or
// attack button. Outside the camera zone pass-through hands the drag to the
// joystick instead, which moves the player.
// Sizes follow the priority tiers in the README's "Size and placement rules":
// primary 195, jump 160, ability/special 135,
// secondary/utility 132. No button is smaller than 132 or closer than 24 to
// another: on a phone of at least 360x780 pt a design px is at least 1/3 pt, so
// 132 px meets Apple's 44 pt minimum tap target and 24 px is an 8 pt gap.
// Shorter screens scale lower (37.6 pt on a 375x667 pt phone); Android asks
// for 48 dp.
// Portrait geometry (design 1080x2340, 19.5:9 matching the Figma frame):
//   Jump:     W160 H160 Canvas.Right 88  Canvas.Bottom 654
//   Interact: W132 H132 Canvas.Right 79  Canvas.Bottom 249
//   Drop:     W132 H132 Canvas.Right 238 Canvas.Bottom 95
//   Use:      W195 H195 Canvas.Right 165 Canvas.Bottom 415
//   Reload:   W132 H132 Canvas.Right 384 Canvas.Bottom 447
//   SwitchWeapon: W132 H132 Canvas.Right 393 Canvas.Bottom 289
//   Aim:      W132 H132 Canvas.Right 384 Canvas.Bottom 603
//   Dodge:    W135 H135 Canvas.Right 100 Canvas.Bottom 838
// Landscape geometry (design 2340x1080, Jump from Figma node 1065-20660):
//   Jump:     W160 H160 Canvas.Right 153 Canvas.Bottom 383
//   Interact: W132 H132 Canvas.Right 289 Canvas.Bottom 129
//   Drop:     W132 H132 Canvas.Right 167 Canvas.Bottom 570
//   Use:      W195 H195 Canvas.Right 380 Canvas.Bottom 383
//   Reload:   W132 H132 Canvas.Right 599 Canvas.Bottom 415
//   SwitchWeapon: W132 H132 Canvas.Right 609 Canvas.Bottom 259
//   Aim:      W132 H132 Canvas.Right 599 Canvas.Bottom 571
//   Dodge:    W135 H135 Canvas.Right 128 Canvas.Bottom 224
// Move or resize a button in a build -> update that orientation's geom here to
// match the Canvas.Right/Canvas.Bottom/size in the matching XAML.
// ============================================================================

type ButtonRect = {x0: number; y0: number; x1: number; y1: number};

// Bottom-right-anchored button geometry in design pixels (matches the XAML
// Canvas.Right / Canvas.Bottom / Width / Height).
type ButtonGeom = {right: number; bottom: number; w: number; h: number};

export type ButtonConfig = {
  /** InputActionsManager action name driven by this button. */
  action: string;
  /** Portrait design-px geometry; MUST match the portrait XAML position + size. */
  geom: ButtonGeom;
  /** Landscape design-px geometry; MUST match the landscape XAML position + size. */
  geomLandscape: ButtonGeom;
  /** true = tap (pulse on press); false = hold (down until release). */
  momentary: boolean;
  /**
   * false = claim the press, so nothing beneath reacts. true = leave the press
   * to the controls beneath (the camera-look drag turns while the button is
   * held) and claim the touch at release instead; under HoldToMove the press is
   * still claimed (`buttonConsumesPress`). The release claim needs
   * HoldUntilRelease: a button that lets go on drag-off no longer owns the touch
   * when it lifts.
   */
  passThrough: boolean;
  /** Drag-off vs hold-until-release semantics. */
  holdMode: TouchHoldMode;
  /** Landscape override of `passThrough`. */
  passThroughLandscape?: boolean;
  /** Landscape override of `holdMode`. */
  holdModeLandscape?: TouchHoldMode;
  /** ViewModel property bound to the button's Visibility. */
  visibleKey: string;
  /** ViewModel property bound to the button's IsEnabled. */
  enabledKey: string;
  /** ViewModel property bound to the button's pressed visual. */
  pressedKey: string;
  /** Optional ViewModel TextureAsset property bound to the button's icon. */
  iconKey?: string;
};

const BUTTON_CONFIGS: ButtonConfig[] = [
  {
    action: 'Jump',
    geom: {right: 88, bottom: 654, w: 160, h: 160},
    geomLandscape: {right: 153, bottom: 383, w: 160, h: 160},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'jumpVisible',
    enabledKey: 'jumpEnabled',
    pressedKey: 'jumpPressed',
  },
  {
    action: 'Interact',
    geom: {right: 79, bottom: 249, w: 132, h: 132},
    geomLandscape: {right: 289, bottom: 129, w: 132, h: 132},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'interactVisible',
    enabledKey: 'interactEnabled',
    pressedKey: 'interactPressed',
  },
  {
    action: 'Drop',
    geom: {right: 238, bottom: 95, w: 132, h: 132},
    geomLandscape: {right: 167, bottom: 570, w: 132, h: 132},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'dropVisible',
    enabledKey: 'dropEnabled',
    pressedKey: 'dropPressed',
  },
  {
    action: 'Use',
    geom: {right: 165, bottom: 415, w: 195, h: 195},
    geomLandscape: {right: 380, bottom: 383, w: 195, h: 195},
    momentary: false,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    // Landscape puts Use in the camera half: fire and aim with the same finger.
    passThroughLandscape: true,
    holdModeLandscape: TouchHoldMode.HoldUntilRelease,
    visibleKey: 'useVisible',
    enabledKey: 'useEnabled',
    pressedKey: 'usePressed',
    iconKey: 'useIcon',
  },
  {
    action: 'Reload',
    geom: {right: 384, bottom: 447, w: 132, h: 132},
    geomLandscape: {right: 599, bottom: 415, w: 132, h: 132},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'reloadVisible',
    enabledKey: 'reloadEnabled',
    pressedKey: 'reloadPressed',
    iconKey: 'reloadIcon',
  },
  {
    action: 'SwitchWeapon',
    geom: {right: 393, bottom: 289, w: 132, h: 132},
    geomLandscape: {right: 609, bottom: 259, w: 132, h: 132},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'switchWeaponVisible',
    enabledKey: 'switchWeaponEnabled',
    pressedKey: 'switchWeaponPressed',
  },
  {
    action: 'Aim',
    geom: {right: 384, bottom: 603, w: 132, h: 132},
    geomLandscape: {right: 599, bottom: 571, w: 132, h: 132},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'aimVisible',
    enabledKey: 'aimEnabled',
    pressedKey: 'aimPressed',
  },
  {
    action: 'Dodge',
    geom: {right: 100, bottom: 838, w: 135, h: 135},
    geomLandscape: {right: 128, bottom: 224, w: 135, h: 135},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'dodgeVisible',
    enabledKey: 'dodgeEnabled',
    pressedKey: 'dodgePressed',
  },
];

/**
 * `BUTTON_CONFIGS` with each row's geometry, `passThrough` and `holdMode` for the
 * given orientation.
 */
export function buttonConfigsFor(landscape: boolean): ButtonConfig[] {
  return BUTTON_CONFIGS.map(cfg =>
    landscape
      ? {
          ...cfg,
          geom: cfg.geomLandscape,
          passThrough: cfg.passThroughLandscape ?? cfg.passThrough,
          holdMode: cfg.holdModeLandscape ?? cfg.holdMode,
        }
      : {...cfg},
  );
}

/**
 * Whether a button press claims its touch at touch-down. A pass-through button
 * leaves it to the camera-look drag beneath, except under HoldToMove, which has no
 * camera drag and whose hold-to-move layer would run the player towards the button.
 */
export function buttonConsumesPress(passThrough: boolean, scheme: TouchMovementScheme): boolean {
  return !passThrough || scheme === TouchMovementScheme.HoldToMove;
}

// ============================================================================
// Component — renders the HUD and drives InputActionsManager via the router.
// ============================================================================

@component()
export class TouchControlsHud extends Component {
  public static instance: Maybe<TouchControlsHud> = null;

  /**
   * false = portrait (default), true = landscape. Selects the portrait vs
   * landscape BUTTON_CONFIGS hit rects; set it to match the copied XAML build
   * (TouchControlsHud.portrait.xaml or .landscape.xaml).
   */
  @property()
  landscape: boolean = false;

  /**
   * false = never show the held-weapon Use/Reload buttons, for a scene that
   * draws its own and would otherwise get two.
   */
  @property()
  weaponButtons: boolean = true;

  // Per-button tunables (inspector overrides of the BUTTON_CONFIGS defaults).
  // The defaults reproduce the table: tap, consume, deactivate-on-drag-off. For
  // an aim-while-fire recipe on a button that overlaps the camera zone, set that
  // button's PassThrough=true, Momentary=false, HoldUntilRelease=true so a finger
  // fires the action while it holds AND the camera-look drag underneath turns.
  // Use ships that way in landscape (`passThroughLandscape`, `holdModeLandscape`).

  @property()
  jumpPassThrough: boolean = false;
  @property()
  jumpMomentary: boolean = true;
  @property()
  jumpHoldUntilRelease: boolean = false;

  private viewModel = new TouchControlsHudViewModel();
  private customUi: Maybe<CustomUiComponent> = null;
  private registeredIds: string[] = [];
  // Active finger indices per non-momentary (hold) action. A hold button can be
  // pressed by more than one finger; the action stays down until the LAST finger
  // lifts, so releasing one finger never drops an action another still holds.
  private heldFingers: Map<string, Set<number>> = new Map();

  private designWidth = DESIGN_WIDTH_PORTRAIT;
  private designHeight = DESIGN_HEIGHT_PORTRAIT;

  // --------------------------------------------------------------------------
  // Lifecycle
  //
  // Use OnEntityStartEvent (not OnEntityCreateEvent): CustomUiComponent is not
  // fully ready at create time, so dataContext must be set on start.
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    TouchControlsHud.instance = this;
    this.designWidth = this.landscape
      ? DESIGN_WIDTH_LANDSCAPE
      : DESIGN_WIDTH_PORTRAIT;
    this.designHeight = this.landscape
      ? DESIGN_HEIGHT_LANDSCAPE
      : DESIGN_HEIGHT_PORTRAIT;

    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi != null) {
      this.customUi.dataContext = this.viewModel;
    } else {
      console.error('TouchControlsHud: CustomUiComponent not found on entity');
    }

    // Register each button with the router at the HUD band (zPriority 100,
    // above the joystick and camera-look). hitTest converts the button's design
    // geometry to a normalized rect at touch time (rectFor) so it tracks the
    // visible button on any device aspect.
    this.registeredIds = [];
    for (const cfg of this.effectiveConfigs()) {
      const id = `btn:${cfg.action}`;
      TouchRouter.register({
        id,
        zPriority: 100,
        holdMode: cfg.holdMode,
        hitTest: (pos: Vec2) =>
          this.isButtonInteractable(cfg) &&
          this.pointInRect(pos, this.rectFor(cfg.geom)),
        handlers: {
          // handleButtonStart returns whether the press is claimed
          // (`buttonConsumesPress`).
          onStart: (index: number) => this.handleButtonStart(cfg, index),
          // A pass-through button claims the touch at release instead, so a tap
          // on it is not also a world tap (tap-to-interact, tap-to-move).
          onEnd: (index: number) => {
            this.handleButtonEnd(cfg, index);
            return cfg.passThrough;
          },
        },
      });
      this.registeredIds.push(id);
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    // Release any HELD action before unregistering, or a hold button torn down
    // mid-press (scene reload, entity removed) leaves the action stuck down.
    // releaseHeld only publishes for actions with tracked fingers, so a
    // never-pressed button emits no redundant false-to-false release.
    for (const cfg of this.effectiveConfigs()) {
      this.releaseHeld(cfg.action);
    }
    this.heldFingers.clear();
    for (const id of this.registeredIds) {
      TouchRouter.unregister(id);
    }
    this.registeredIds = [];
    this.customUi = null;
    if (TouchControlsHud.instance === this) {
      TouchControlsHud.instance = null;
    }
  }

  // --------------------------------------------------------------------------
  // Router handlers — pressed visual plus the action drive.
  // --------------------------------------------------------------------------

  private handleButtonStart(cfg: ButtonConfig, index: number): boolean {
    this.setPressedVisual(cfg, true);
    if (cfg.momentary) {
      // Tap: pulse the action press + release on touch-down.
      InputActionsManager.instance?.triggerInputAction(cfg.action);
      return buttonConsumesPress(cfg.passThrough, getTouchMovementScheme());
    }
    // Hold: track this finger. Two fingers can press one hold button; publish the
    // press only on the empty->non-empty transition so a second finger does not
    // re-publish a redundant press (InputActionsManager notifies on every write).
    let fingers = this.heldFingers.get(cfg.action);
    if (fingers == null) {
      fingers = new Set<number>();
      this.heldFingers.set(cfg.action, fingers);
    }
    const wasEmpty = fingers.size === 0;
    fingers.add(index);
    if (wasEmpty) {
      InputActionsManager.instance?.setButtonState(cfg.action, true);
    }
    // A pass-through press goes on to the camera-look drag beneath; onEnd claims
    // its release instead.
    return buttonConsumesPress(cfg.passThrough, getTouchMovementScheme());
  }

  private handleButtonEnd(cfg: ButtonConfig, index: number): void {
    if (cfg.momentary) {
      this.setPressedVisual(cfg, false);
      return;
    }
    const fingers = this.heldFingers.get(cfg.action);
    if (fingers == null) {
      return; // already released (e.g. via releaseHeld); nothing to publish
    }
    fingers.delete(index);
    if (fingers.size > 0) {
      return; // another finger still holds this button
    }
    // Last finger lifted: clear state and publish the release exactly once.
    this.heldFingers.delete(cfg.action);
    this.setPressedVisual(cfg, false);
    InputActionsManager.instance?.setButtonState(cfg.action, false);
  }

  // --------------------------------------------------------------------------
  // Wrapper API — clean show/hide/enable control over individual buttons
  // --------------------------------------------------------------------------

  /** Show a single button by its action name (e.g. `'Jump'`). */
  public showButton(action: string): void {
    this.setButtonVisible(action, true);
  }

  /** Hide a single button by its action name. */
  public hideButton(action: string): void {
    this.setButtonVisible(action, false);
    this.releaseHeld(action);
  }

  /** Enable or grey-out a single button by its action name. */
  public setButtonEnabled(action: string, enabled: boolean): void {
    const cfg = this.findConfig(action);
    if (cfg != null) {
      this.setViewModelFlag(cfg.enabledKey, enabled);
      if (!enabled) {
        this.releaseHeld(action);
      }
    }
  }

  /** Set a button's bound icon from an authored TextureAsset property. */
  public setButtonIcon(action: string, icon: Maybe<TextureAsset>): void {
    const cfg = this.findConfig(action);
    if (cfg?.iconKey != null) {
      (
        this.viewModel as unknown as Record<string, Maybe<TextureAsset>>
      )[cfg.iconKey] = icon;
    }
  }

  /**
   * Show or hide the screen-centre crosshair and whether it is on a target. Its
   * ring frames a spread of `spreadDeg` (cone half-angle) as the camera's
   * vertical field of view `fovDeg` puts it on screen (`crosshairScale`).
   */
  public setCrosshair(visible: boolean, onTarget: boolean, spreadDeg: number = 0, fovDeg: number = 60): void {
    this.viewModel.crosshairVisible = visible;
    this.viewModel.crosshairOnTarget = visible && onTarget;
    this.viewModel.crosshairScale = crosshairScale(spreadDeg, fovDeg, this.designHeight);
  }

  /** Show or hide the scope overlay: the mask, lens and reticle of a scoped weapon's sight, under the buttons. */
  public setScopeVisible(visible: boolean): void {
    this.viewModel.scopeVisible = visible;
  }

  /** Show the entire HUD. */
  public showAll(): void {
    if (this.customUi != null) {
      this.customUi.isVisible = true;
    }
  }

  /** Hide the entire HUD. */
  public hideAll(): void {
    if (this.customUi != null) {
      this.customUi.isVisible = false;
    }
    // Release any held action, or a hold button hidden mid-press stays down (the
    // router does not re-run hit testing for a HoldUntilRelease finger).
    for (const cfg of this.effectiveConfigs()) {
      this.releaseHeld(cfg.action);
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Select each button's orientation config (portrait vs landscape) and apply
   * the per-button inspector overrides onto the config table. The router hitTest
   * converts the returned `geom` to a hit rect via rectFor, so selecting it here
   * is what makes `landscape` switch the hit regions to match the copied XAML.
   *
   * Inspector overrides (jump*) apply ONLY to the shipped `Jump` button. Buttons
   * you ADD have no inspector fields, so set their momentary/passThrough/holdMode
   * directly in their `BUTTON_CONFIGS` row (which this method preserves).
   */
  private effectiveConfigs(): ButtonConfig[] {
    return buttonConfigsFor(this.landscape).map(cfg => {
      if (cfg.action === 'Jump') {
        return {
          ...cfg,
          passThrough: this.jumpPassThrough,
          momentary: this.jumpMomentary,
          holdMode: this.jumpHoldUntilRelease
            ? TouchHoldMode.HoldUntilRelease
            : TouchHoldMode.DeactivateOnDragOff,
        };
      }
      return cfg;
    });
  }

  // The buttons live in a fill Canvas inside the LayoutScaler, which overscans
  // the non-limiting axis. The router pos is physical-normalized (0..1 of the
  // screen), so convert each button's bottom-right-anchored design geometry to a
  // normalized rect through the panel's ACTUAL logical size, derived from the
  // runtime viewport aspect, not the fixed design constants. Without it a
  // bottom-anchored button's hit zone is offset from the visible button on any
  // off-design aspect (x correct, y wrong on a taller phone). Mirrors the
  // joystick and the engine's built-in controls.
  private logicalDims(): {w: number; h: number} {
    const refW = this.designWidth;
    const refH = this.designHeight;
    const aspect = CameraService.get().aspectRatio;
    if (!(aspect > 0) || !Number.isFinite(aspect)) {
      return {w: refW, h: refH};
    }
    if (aspect < refW / refH) {
      // Viewport taller than the design: width pins, height overscans.
      return {w: refW, h: refW / aspect};
    }
    // Viewport wider than the design: height pins, width overscans.
    return {w: refH * aspect, h: refH};
  }

  private rectFor(geom: ButtonGeom): ButtonRect {
    const {w: lw, h: lh} = this.logicalDims();
    return {
      x0: (lw - geom.right - geom.w) / lw,
      x1: (lw - geom.right) / lw,
      y0: (lh - geom.bottom - geom.h) / lh,
      y1: (lh - geom.bottom) / lh,
    };
  }

  private pointInRect(pos: Vec2, rect: ButtonRect): boolean {
    return (
      pos.x >= rect.x0 &&
      pos.x <= rect.x1 &&
      pos.y >= rect.y0 &&
      pos.y <= rect.y1
    );
  }

  private setPressedVisual(cfg: ButtonConfig, pressed: boolean): void {
    this.setViewModelFlag(cfg.pressedKey, pressed);
  }

  private setButtonVisible(action: string, visible: boolean): void {
    const cfg = this.findConfig(action);
    if (cfg != null) {
      this.setViewModelFlag(cfg.visibleKey, visible);
    }
  }

  private setViewModelFlag(key: string, value: boolean): void {
    (this.viewModel as unknown as Record<string, boolean>)[key] = value;
  }

  private getViewModelFlag(key: string): boolean {
    return (this.viewModel as unknown as Record<string, boolean>)[key];
  }

  /**
   * A button only takes touches when the whole HUD is visible and the button's
   * own visible + enabled flags are set. The router hit rect is pure geometry,
   * so without this a hidden or greyed-out button still intercepts taps and
   * fires its action.
   */
  private isButtonInteractable(cfg: ButtonConfig): boolean {
    // Fail closed: a missing CustomUiComponent (HUD not set up) or a hidden HUD
    // means the button is not on screen, so it must not take touches.
    if (this.customUi == null || !this.customUi.isVisible) {
      return false;
    }
    return (
      this.getViewModelFlag(cfg.visibleKey) &&
      this.getViewModelFlag(cfg.enabledKey)
    );
  }

  // Release a currently-held (non-momentary) action when its button is hidden or
  // disabled. The router does not re-run hit testing for a HoldUntilRelease finger
  // already owning the button, so without this a hidden/disabled hold button keeps
  // its action true until the finger physically lifts. No-op for a tap button or
  // one that is not currently held.
  private releaseHeld(action: string): void {
    const fingers = this.heldFingers.get(action);
    if (fingers == null || fingers.size === 0) {
      return;
    }
    this.heldFingers.delete(action);
    const cfg = this.findConfig(action);
    if (cfg != null) {
      this.setPressedVisual(cfg, false);
    }
    InputActionsManager.instance?.setButtonState(action, false);
  }

  // Search effectiveConfigs() (not raw BUTTON_CONFIGS) so a config resolved here
  // matches the set the registration loop and releaseHeld iterate, including any
  // subclass-injected button; otherwise releaseHeld could publish an action false
  // yet skip its pressed-visual clear, leaving a hidden button visually stuck.
  private findConfig(action: string): Maybe<ButtonConfig> {
    for (const cfg of this.effectiveConfigs()) {
      if (cfg.action === action) {
        return cfg;
      }
    }
    console.error(`TouchControlsHud: no button bound to action '${action}'`);
    return null;
  }
}
