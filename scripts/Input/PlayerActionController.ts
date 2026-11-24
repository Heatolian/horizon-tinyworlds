/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v17

/**
 * PlayerActionController
 *
 * Component Attachment: a scene service entity (`PlayerInputServices` in space.hstf)
 * Component Networking: Everywhere — each client binds to its own local player
 *   and ignores the server context, so the callbacks only ever reach a character
 *   that client owns.
 *
 * The character's input surface. Native `PlayerInputAction` bindings and
 * project-defined `InputActionsManager` actions are both subscribed here. This
 * component owns no gameplay state; it resolves the components that do and
 * routes every input source to the same character seams.
 *
 * Facing mode is independent of input routing: on the owned character root,
 * `AutoFaceRotationAbility.strafeMode` is a runtime-changeable switch. false faces travel;
 * true faces camera-forward while moving or idle and allows strafing/backpedalling.
 * GAS/pickup/weapon integrations should drive that flag from held/aimed weapon state,
 * not only from the fire button; restore the intended mode after drop or melee switch.
 * Do not add another writer of the character's worldRotation here.
 *
 * Native and custom paths both write the same latched movement input, so the
 * engine axis yields when another source is steering (see
 * {@link engineAxisYields}).
 *
 * WHY THIS LIVES IN THE SCENE, NOT ON THE CHARACTER:
 *   Input outlives any one character. Hosted on the PlayerCharacter template
 *   this component was created and destroyed with the body, so every
 *   subscription was torn down and rebuilt on each respawn. On a scene service
 *   entity the subscriptions are made once at world load and simply re-point at
 *   whatever character the local player currently has.
 *
 *   The cost is that ONE component drives ONE character. Extra spawned
 *   characters get no input; that is the intended trade — they are dummies.
 *
 * WHAT THE TEMPLATE BINDS
 *
 * Movement, custom actions and held-weapon use. Movement always works because
 * the axis subscription needs no config asset; ranged attack binds from its
 * assigned input config on the scene entity. Custom Move/Jump/Look/Dodge actions
 * are wired through `InputActionsManager` below, and the touch Dodge button shows
 * while the character's `DodgeRollAbility` has a dodge input config. Item actions
 * (Use, Reload, Drop, SwitchWeapon) and their touch buttons belong to
 * `PlayerItemInput`.
 *
 * To add an action: add a row to {@link defineActions}, add a matching
 * `*InputConfig` property, author an `.inputconfig` asset and assign it. An
 * action whose property is left unassigned is skipped, so a row costs nothing
 * until it is wired up. The engine permits a single subscriber per action
 * (T216638120), which is why every binding is declared in this one table rather
 * than spread across components that would silently contend for the same action.
 */

import {
  CameraService,
  Component,
  component,
  editor,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  NetworkingService,
  ExecuteOn,
  PlayerInputService,
  PlayerInputAction,
  PlayerInputAxis,
  PlayerInputState,
  PlayerInputActionCallbackPayload,
  PlayerInputAxisCallbackPayload,
  PlayerService,
  InputVisualConfigAsset,
  property,
  Vec2,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {
  InputActionsManager,
  InputActionChangeEvent,
} from './InputActionsManager';
import {TouchControlsHud} from './TouchControlsHud';
import {DodgeRollAbility} from '../Character/Abilities/DodgeRollAbility';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';
import {CameraManager} from '../Camera/CameraManager';
import {equippedWeaponOf} from '../ItemSystem/features/Weapon';
import {
  JumpClickEvent,
  JumpReleaseEvent,
} from '../Character/State/ActionEvents';

/**
 * One row of the action table: the engine action, the config asset that gives it
 * an on-screen button, and what to do with its state changes.
 */
type ActionBinding = {
  /** Used only in the log line when a binding is skipped. */
  label: string;
  action: PlayerInputAction;
  config: Maybe<InputVisualConfigAsset>;
  onState: (state: PlayerInputState) => void;
};

type Disconnectable = {
  disconnect(): void;
};

// WHY: the camera zone must turn as it did when the engine's
// TouchInputCameraProcessor drove CameraManager, so this mirrors that curve at
// default user settings. 'Look' is in TouchCameraLook units (3 per screen).
// The engine assumes a landscape 1280x720 reference in every orientation, which
// makes portrait horizontal look ~1.8x too strong, so portrait swaps the axes.
const LOOK_UNITS_PER_SCREEN = 3;
const LOOK_REFERENCE_LONG_SIDE_PX = 1280;
const LOOK_REFERENCE_SHORT_SIDE_PX = 720;
const LOOK_GAIN = 0.048;
const LOOK_MAX_TURN = 6;
const LOOK_OUTPUT_SCALE = 6;
const LOOK_ACCEL_MIN_SPEED_PX = 1;
const LOOK_ACCEL_MAX_SPEED_PX = 77.5;
const LOOK_ACCEL_PEAK = 20;
const LOOK_ACCEL_STRENGTH = 0.5;

/** One frame of 'Look' delta to degrees, using the engine touch-look curve. */
function lookDeltaToDegrees(dx: number, dy: number): Vec2 {
  const aspect = CameraService.get().aspectRatio;
  const portrait = aspect > 0 && Number.isFinite(aspect) && aspect < 1;
  const refWidth = portrait
    ? LOOK_REFERENCE_SHORT_SIDE_PX
    : LOOK_REFERENCE_LONG_SIDE_PX;
  const refHeight = portrait
    ? LOOK_REFERENCE_LONG_SIDE_PX
    : LOOK_REFERENCE_SHORT_SIDE_PX;
  const px = (dx / LOOK_UNITS_PER_SCREEN) * refWidth;
  const py = (dy / LOOK_UNITS_PER_SCREEN) * refHeight;
  const speed = Math.sqrt(px * px + py * py);
  const f = Math.min(
    Math.max(
      (speed - LOOK_ACCEL_MIN_SPEED_PX) /
        (LOOK_ACCEL_MAX_SPEED_PX - LOOK_ACCEL_MIN_SPEED_PX),
      0,
    ),
    1,
  );
  const t = f * f * (3 - 2 * f);
  const speedFactor = LOOK_ACCEL_PEAK * t + LOOK_ACCEL_MIN_SPEED_PX * (1 - t);
  const accel = 1 + (speedFactor - 1) * LOOK_ACCEL_STRENGTH;
  let lx = px * LOOK_GAIN * accel;
  let ly = py * LOOK_GAIN * accel;
  const mag = Math.sqrt(lx * lx + ly * ly);
  if (mag > LOOK_MAX_TURN) {
    lx *= LOOK_MAX_TURN / mag;
    ly *= LOOK_MAX_TURN / mag;
  }
  return new Vec2(lx * LOOK_OUTPUT_SCALE, ly * LOOK_OUTPUT_SCALE);
}

@component({
  description:
    'Routes native and custom movement, jump, look and dodge input, and native held-weapon use, to the local character.',
})
export class PlayerActionController extends Component {
  @editor({
    description: `Held-use input config. With built-in controls suppressed, this remains available to keyboard and gamepad input.`,
  })
  @property()
  rangeAttackInputConfig: Maybe<InputVisualConfigAsset> = null;

  private stateMachine: CharacterStateMachine | null = null;
  private dodge: DodgeRollAbility | null = null;
  private dodgeHud: TouchControlsHud | null = null;
  private dodgeButtonShown: boolean = false;
  private player: Entity | null = null;
  private subscriptions: Disconnectable[] = [];
  private customActionsWired: boolean = false;
  // The curve is nonlinear in per-frame speed, so per-move adds are summed and
  // converted once per frame.
  private pendingLookX: number = 0;
  private pendingLookY: number = 0;

  /**
   * Subscribe every binding once, at world load. These are player-input
   * subscriptions rather than character ones, so they outlive any single body;
   * the handlers read the resolved state machine. Startup resolves an existing
   * local player, player-create handles a later spawn, and input callbacks retry
   * after a scene-service hot reload that does not recreate the player.
   *
   * Skipped in the server context, which has no local player to drive.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    this.resolveExistingLocalPlayer();

    for (const binding of this.defineActions()) {
      this.bind(binding);
    }

    // Movement is the one action with no config asset — the axis subscription
    // has no on-screen button to configure, so it always binds.
    this.subscriptions.push(
      PlayerInputService.get().subscribePlayerInputAxis(
        this,
        PlayerInputAxis.Left,
        (payload: PlayerInputAxisCallbackPayload) => {
          if (this.stateMachine == null) {
            this.resolveExistingLocalPlayer();
          }
          if (this.engineAxisYields(payload.value)) {
            return;
          }
          this.stateMachine?.handleMovementInput(payload.value);
        },
      ),
    );

    this.wireCustomActions();
  }

  /**
   * The custom action manager may start after this scene service. Retry until
   * its subscriptions are installed.
   */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    this.wireCustomActions();
    this.syncDodgeButton();
    this.flushLook();
  }

  /**
   * Whether the engine axis should stand down for this value.
   *
   * `MovementAbility.setInput` latches, so a zero from an idle engine axis
   * overwrites a live value published by the touch joystick or by
   * click-to-move steering. A non-zero engine value always wins; a zero only
   * reaches the character when no other source is steering.
   */
  private engineAxisYields(value: Vec2): boolean {
    if (value.x !== 0 || value.y !== 0) {
      return false;
    }
    const actions = InputActionsManager.instance;
    if (actions == null) {
      return false;
    }
    if (actions.isPressed('ClickToMove')) {
      return true;
    }
    const move = actions.getAxis2D('Move');
    return move.x !== 0 || move.y !== 0;
  }

  /**
   * Point input at the local player's character. Gated on `isLocal` so a remote
   * player spawning on this client does not steal the bindings, and on the
   * server context, which drives no input.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (!NetworkingService.get().isPlayerContext() || !payload.isLocal) {
      return;
    }
    const playerEntity: Maybe<Entity> = payload.entity;
    if (!playerEntity) {
      console.error(
        '[PlayerActionController] OnPlayerCreateEvent carried no local entity; input will be a no-op.',
      );
      return;
    }
    this.resolvePlayerEntity(playerEntity);
  }

  private resolveExistingLocalPlayer(): void {
    if (this.player != null) {
      return;
    }
    const playerEntity = PlayerService.get().getLocalPlayer();
    if (playerEntity != null) {
      this.resolvePlayerEntity(playerEntity);
    }
  }

  private resolvePlayerEntity(playerEntity: Entity): void {
    this.player = playerEntity;
    this.dodge = playerEntity.getComponent(DodgeRollAbility);
    this.stateMachine = playerEntity.getComponent(CharacterStateMachine);
    if (!this.stateMachine) {
      console.warn(
        '[PlayerActionController] CharacterStateMachine not found on the local player; movement and jump will be no-ops.',
      );
    }
  }

  /**
   * Drop the character on despawn. Without this the handlers would keep calling
   * into a destroyed entity's components until the next spawn replaced them.
   */
  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!NetworkingService.get().isPlayerContext() || !payload.isLocal) {
      return;
    }
    this.resetCharacterState();
    this.stateMachine = null;
    this.dodge = null;
    this.player = null;
  }

  /**
   * Every button the character binds, one row each. Add native actions and their
   * matching `*InputConfig` properties here.
   */
  private defineActions(): ActionBinding[] {
    return [
      {
        label: 'range attack',
        action: PlayerInputAction.SecondaryRight,
        config: this.rangeAttackInputConfig,
        onState: state => {
          this.resolveExistingLocalPlayer();
          if (state === PlayerInputState.Pressed) {
            this.use(true);
          } else if (state === PlayerInputState.Released) {
            this.use(false);
          }
        },
      },
    ];
  }

  /** Drives the ItemSystem weapon in the local player's hand. */
  private use(pressed: boolean): void {
    if (this.player == null) {
      return;
    }
    const weapon = equippedWeaponOf(this.player);
    if (pressed) {
      weapon?.pullTrigger();
    } else {
      weapon?.releaseTrigger();
    }
  }

  private wireCustomActions(): void {
    if (this.customActionsWired) {
      return;
    }
    const manager = InputActionsManager.instance;
    if (manager == null) {
      return;
    }

    this.subscriptions.push(
      manager.subscribeAction('Move', event => this.onMove(event)),
      manager.subscribeAction('Jump', event => this.onJump(event)),
      manager.subscribeAction('Look', event => this.onLook(event)),
      manager.subscribeAction('Dodge', event => this.onDodge(event)),
    );
    this.customActionsWired = true;
    console.log(
      '[PlayerActionController] Wired custom Move/Jump/Look/Dodge actions',
    );
  }

  /**
   * Shows the touch Dodge button while the local character rolls from a button:
   * its `DodgeRollAbility` has a dodge input config. Only with built-in controls
   * suppressed; otherwise the engine draws that config's own button.
   */
  private syncDodgeButton(): void {
    const hud = TouchControlsHud.instance;
    if (hud !== this.dodgeHud) {
      this.dodgeHud = hud;
      this.dodgeButtonShown = false;
    }
    if (hud == null) {
      return;
    }
    const visible =
      this.dodge?.dodgeRollInputConfig != null &&
      InputActionsManager.instance?.suppressBuiltInControls === true;
    if (visible === this.dodgeButtonShown) {
      return;
    }
    this.dodgeButtonShown = visible;
    if (visible) {
      hud.showButton('Dodge');
    } else {
      hud.hideButton('Dodge');
    }
  }

  private onDodge(event: InputActionChangeEvent): void {
    if (event.newValue as boolean) {
      this.dodge?.onDodgePressed();
    }
  }

  private onMove(event: InputActionChangeEvent): void {
    this.stateMachine?.handleMovementInput(event.newValue as Vec2);
  }

  private onJump(event: InputActionChangeEvent): void {
    if (event.newValue as boolean) {
      this.stateMachine?.handleJumpClick();
    } else {
      this.stateMachine?.handleJumpRelease();
    }
  }

  private onLook(event: InputActionChangeEvent): void {
    const oldValue = event.oldValue as Vec2;
    const newValue = event.newValue as Vec2;
    // Per-add delta extracted from the cumulative accumulator values.
    this.pendingLookX += newValue.x - oldValue.x;
    this.pendingLookY += newValue.y - oldValue.y;
  }

  private flushLook(): void {
    const dx = this.pendingLookX;
    const dy = this.pendingLookY;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      return;
    }
    const degrees = lookDeltaToDegrees(dx, dy);
    // Negate to match CameraManager's convention: +X drag yaws right, +Y looks down.
    CameraManager.get()?.addLookDelta(-degrees.x, -degrees.y);
  }

  private resetCharacterState(): void {
    this.stateMachine?.handleMovementInput(Vec2.zero);
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    if (!NetworkingService.get().isPlayerContext()) {
      return;
    }

    this.resetCharacterState();
    this.stateMachine = null;
    this.dodge = null;
    if (
      this.dodgeButtonShown &&
      this.dodgeHud != null &&
      TouchControlsHud.instance === this.dodgeHud
    ) {
      this.dodgeHud.hideButton('Dodge');
    }
    this.dodgeHud = null;
    this.dodgeButtonShown = false;
    for (const sub of this.subscriptions) {
      sub.disconnect();
    }
    this.subscriptions = [];
    this.customActionsWired = false;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
  }

  /**
   * Subscribe one row of the action table. The stable API requires a config
   * asset, so an unassigned property means the action is skipped entirely.
   */
  private bind(binding: ActionBinding): void {
    if (!binding.config) {
      console.log(
        `[PlayerActionController] ${binding.label}: no inputconfig assigned, not bound`,
      );
      return;
    }
    this.subscriptions.push(
      PlayerInputService.get().subscribePlayerInputAction(
        this,
        binding.action,
        (payload: PlayerInputActionCallbackPayload) => {
          binding.onState(payload.inputState);
        },
        binding.config,
      ),
    );
  }

  // Legacy UiEvent handlers for backward compatibility.
  @subscribe(JumpClickEvent)
  onJumpClick(): void {
    this.stateMachine?.handleJumpClick();
  }

  @subscribe(JumpReleaseEvent)
  onJumpRelease(): void {
    this.stateMachine?.handleJumpRelease();
  }
}
