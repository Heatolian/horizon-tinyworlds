# On-screen controls

How the touch controls in `scripts/Input/` work, and how to change them. The
controls replace the engine's built-in joystick and gameplay buttons; turning
them off leaves a touch player with no way to move.

## What is in the scene

| Entity in `space.hstf` | Component | Does |
|---|---|---|
| `PlayerInputServices` | `InputActionsManager` | The action bus every control writes and gameplay reads. Hides the engine's built-in controls while `suppressBuiltInControls` is on. |
| `PlayerInputServices` | `PlayerActionController` | Sends `Move`, `Jump`, `Look` and `Dodge` to the local player's character and camera. Also owns keyboard and gamepad bindings. |
| `TouchRouter` | `TouchRouter` | Owns the one touch subscription and hands each touch to the controls in priority order. |
| `TouchControlsHud` | `TouchControlsHud` + CustomUi (`UI/TouchControlsHud.xaml`) | The buttons. |
| `TouchJoystick` | `TouchJoystick` + CustomUi (`UI/TouchJoystick.xaml`) | Movement stick in the movement zone (floating by default; see "Joystick modes"); drives `Move`. |
| `TouchCameraLook` | `TouchCameraLook` | Invisible drag in the camera zone; drives `Look`. |
| `TouchTapTarget` | `TouchTapTarget` | Raycasts a clean tap on the world that no control above claimed and passes the hit to `subscribeTap` listeners; tap-to-interact and tap-to-move use it. Does nothing with no listeners. |
| `TouchHoldToMove` | `TouchHoldToMove` | Hold-to-move; does nothing unless the movement scheme is HoldToMove. |

Keep exactly one of each. The touch controls register with the router under
fixed ids, so a second copy replaces the first one's registration.

## Actions

Every action is one line in `InputActionsManager.defineActions()`:

| Action | Type | Driven by | Read by |
|---|---|---|---|
| `Move` | `Axis2D` | `TouchJoystick`, `ClickToMoveController` or `TouchHoldToMove`, by movement scheme | `PlayerActionController` |
| `Look` | `Delta` | `TouchCameraLook` | `PlayerActionController`, which converts it to degrees and calls `CameraManager.addLookDelta` |
| `Jump` | `Button` | Jump button (hidden by default) | `PlayerActionController` |
| `Interact` | `Button` | Interact button | `InteractionControlsBridge` |
| `Use`, `Reload`, `Drop`, `SwitchWeapon` | `Button` | Their buttons | `PlayerItemInput` |
| `Dodge` | `Button` | Dodge button, shown while the character's `DodgeRollAbility` has a dodge input config and built-in controls are suppressed | `PlayerActionController`, which starts the roll |
| `Dash` | `Button` | Nothing | Nothing. Defined for a dash button; the character has no dash ability yet. |
| `ClickToMove` | `Button` | `ClickToMoveController` | True while click-to-move is steering. |

Read an action from game code with
`InputActionsManager.instance?.subscribeAction('Jump', event => ...)` (keep the
returned handle and call `disconnect()` on it in `onDestroy`), or poll with
`isPressed`, `getAxis2D` and `getActionDelta`. Driving an action that is not
defined, or with the wrong setter for its type, is ignored with a warning.

Keyboard and gamepad come through `PlayerActionController`. Movement always works;
other keys need a row in its `defineActions()` plus an assigned `.inputconfig`.
The engine allows one subscriber per native action (T216638120), so keep each in
that one table. Space to jump and right-drag to look were removed on purpose
because the engine input API behind them is deprecated; a preview-only keyboard
path is T291214377.

## How a touch is routed

Each control registers with `TouchRouter` and a touch is offered to every control
whose hit area contains the touch-down point, highest `zPriority` first:

| Control | `zPriority` | Claims the touch |
|---|---|---|
| HUD button | 100 | On press; a pass-through button on release |
| `TouchJoystick` | 50 | On release, only if the finger moved the stick |
| `TouchHoldToMove` | 45 | On release, only for a hold (not a quick tap) |
| `TouchTapTarget` | 40 | On a clean tap it handles |
| `TouchCameraLook` | 0 | Never |

Every control still sees the touch; one below a claiming control is told
`alreadyConsumed` and stands down. A button press therefore never also moves the
stick or turns the camera, unless the button is pass-through.

- A finger belongs to the controls it started on. Dragging onto another control
  does not hand it over.
- Buttons stop when the finger slides off them (`DeactivateOnDragOff`). The stick
  and the camera drag keep the finger until it lifts (`HoldUntilRelease`).
- Each finger is tracked separately, so moving and looking work at the same time,
  and a hold button stays down while any finger is on it.
- A tap button (`momentary: true`) sends a press and release on touch-down. A hold
  button (`momentary: false`, like `Use`) is down until the last finger lifts.
- To fire while still turning the camera with the same finger, make the button
  pass-through, non-momentary and hold-until-release. `Use` ships this way in
  landscape, where it sits in the camera half (`passThroughLandscape` and
  `holdModeLandscape` in its `BUTTON_CONFIGS` row). Jump has inspector
  properties for this (`jumpPassThrough`, `jumpMomentary`,
  `jumpHoldUntilRelease`); for other buttons set the fields in their
  `BUTTON_CONFIGS` row.
- A pass-through button claims its touch at release, so a tap on it is not also
  a world tap. That needs `HoldUntilRelease`: a pass-through button that lets go
  on drag-off no longer owns the touch, so a tap that slips off its edge can
  still reach the world. Under `HoldToMove` a pass-through button claims the
  press as usual, since there is no camera drag to share it with.

## Show, hide or change a button at runtime

Call these on `TouchControlsHud.instance` with the button's action name:

| Method | Effect |
|---|---|
| `showButton(action)`, `hideButton(action)` | One button. Hiding releases it if held. |
| `setButtonEnabled(action, enabled)` | Grey a button out. |
| `setButtonIcon(action, texture)` | Swap the icon of a button with an icon binding (`Use`, `Reload`). |
| `showAll()`, `hideAll()` | The whole HUD. |

`Jump` starts hidden. When the game needs jumping, enable the existing button
with `TouchControlsHud.instance?.showButton('Jump')` after the HUD starts. Keep
its existing portrait and landscape geometry; do not recreate or reposition it.
The action, button, icon and character jump logic are already wired.

`Interact`, `Drop`, `Use`, `Reload`, `SwitchWeapon` and `Dodge` are already
shown and hidden by `InteractionControlsBridge`, `PlayerItemInput` and
`PlayerActionController`; do not fight them from other code.

## Add a button

A button lives in five places that must agree:

1. `InputActionsManager.ts`: `this.defineAction('Dash', ActionType.Button);` (skip
   if the action exists).
2. `TouchControlsHud.ts`, the ViewModel: `dashVisible`, `dashEnabled` and
   `dashPressed` flags.
3. `TouchControlsHud.ts`, `BUTTON_CONFIGS`: a row with the action, a portrait
   `geom`, a landscape `geomLandscape`, `momentary`, `passThrough`, `holdMode` and
   the three flag keys. Add the same rects to the two geometry comment tables above
   it.
4. The XAML builds `UI/TouchControlsHud.portrait.xaml`, `UI/TouchControlsHud.xaml`
   (the one the scene loads; keep it identical to the portrait build) and
   `UI/TouchControlsHud.landscape.xaml`: copy an existing `<Button>` and set its
   `Width`, `Height`, `Canvas.Right` and `Canvas.Bottom` to the row's rect, and its
   bindings to the new flags. Buttons have no `Command`; the router handles touch.
5. An icon in `UI/icons/`, a white glyph on a transparent background. Shipped
   glyphs: `icn_Jump`, `icn_Interact`, `icn_Drop`, `icn_Fire`, `icn_Reload`,
   `icn_SwingWeapon`, `icn_DodgeRoll`. More `icn_*.png` glyphs ship in the SDK
   packages: find them with a recursive file search that includes dependencies,
   and copy one into `UI/icons/`. Build a new icon with `build_assets`, then set
   `premultiplyAlpha` to true on its texture settings (`modify_asset_properties`);
   without it the icon's edges fringe. Reference it from the button's
   `<Image Source="UI/icons/<file>">`.

Then read the action in game code. Show only the buttons the game asked for.

The router hit-tests `BUTTON_CONFIGS`, not the XAML, so a rect that differs from
its XAML gives a button that draws in one place and responds in another.

A free slot for one more ability button (135 px), clear of the eight shipped
buttons: portrait `Canvas.Right 394`, `Canvas.Bottom 95`; landscape
`Canvas.Right 446`, `Canvas.Bottom 95`.

## Size and placement rules

Design space is 1080 x 2340 in portrait and 2340 x 1080 in landscape. Positions
are bottom-right anchored: `Canvas.Right` and `Canvas.Bottom` are the insets from
that corner, and `BUTTON_CONFIGS` uses the same numbers.

| Tier | Size (px) | For |
|---|---|---|
| Primary | 195 | The main action (`Use`) |
| Jump | 160 | Jump |
| Ability | 135 | Dash, sprint, specials |
| Utility | 132 | Interact, Drop, Reload, SwitchWeapon |

- At least 132 px and at most 360 px. 132 px is Apple's 44 pt minimum tap target
  on a phone of 360 x 780 pt or larger.
- At least 24 px between any two buttons, and at least 95 px above the bottom
  edge (clear of the home indicator).
- Keep the cluster in the bottom-right, the most used button nearest the corner,
  and leave the bottom-left (portrait) or left half (landscape) clear for the
  stick.
- Each CustomUi panel must keep `width` and `height` at 0. Any other value scales
  the controls twice: buttons draw at the wrong size and the stick ring sits away
  from the finger.

## Movement schemes

`locomotionMode` on `LocomotionSettingsComponent` (the `PlayerInputServices`
entity) picks how a touch player moves, and the touch controls switch with it
through `TouchMovementScheme.ts`. It is read once at start.

| `locomotionMode` | Moves the player | Turns the camera | Notes |
|---|---|---|---|
| `Joystick` (shipped) | `TouchJoystick` in the movement zone | A drag in the other half | |
| `ClickToMove` | A tap on the world walks there, pathfinding on the navmesh | A drag anywhere | `ClickToMoveController` gets taps from `TouchTapTarget`; set `destinationMarkerTemplate` for a marker at the destination. |
| `HoldToMove` | The player runs towards a finger held on screen, slowing within 200 design px and stopping within 60 | Nothing | Pair with a TopDown or Isometric camera, or turn off `CameraManager.autoRotateEnabled`, which otherwise swings the camera while the finger holds still. |

In all three, HUD buttons still claim their own touches, and a quick tap still
reaches `TouchTapTarget`, so tap-to-interact keeps working. In `ClickToMove` the
player also walks to the tapped point.

## Joystick modes

Set on the `TouchJoystick` component; no code needed.

| `mode` | Behaviour |
|---|---|
| 0 Floating (shipped) | Appears where the thumb lands in the movement zone and stays there until release. |
| 1 Fixed | Always drawn at a home position; the thumb must start on or near it. Home is `fixedLeft` / `fixedBottom` in design px (portrait) and `fixedLeftLandscape` / `fixedBottomLandscape` (landscape). |
| 2 Follow | Appears where the thumb lands and is dragged along when the thumb leaves the ring. |

`directions` turns any mode into a D-pad: 0 is analog (shipped), 8 is eight-way,
4 is four-way. A D-pad moves at full speed in the nearest direction as soon as the
thumb leaves the deadzone, and the knob shows the chosen direction.

## Orientation

| Orientation | Movement zone (`TouchJoystick`) | Camera zone (`TouchCameraLook`) |
|---|---|---|
| Portrait (shipped) | Bottom half | Top half |
| Landscape | Left half | Right half |

To switch to landscape, change all four together:

1. The project's screen orientation (`screenOrientation` in the `.hzproject`).
2. `landscape = true` on `TouchControlsHud`, `TouchJoystick` and
   `TouchCameraLook`.
3. The `xaml` of the `TouchControlsHud` panel to `UI/TouchControlsHud.landscape.xaml`.
4. The `xaml` of the `TouchJoystick` panel to `UI/TouchJoystick.landscape.xaml`.

A partial switch leaves hit areas that do not match what is drawn.

## Tuning

- Stick, in `TouchJoystick.ts`: `TOUCH_RADIUS` (finger travel for full
  deflection, 0.12 of the screen width in every direction, so 130 design px in
  portrait) and `TOUCH_DEADZONE` (0.08 of full deflection). Output ramps from 0 at
  the deadzone edge to 1 at full deflection. `RING_SIZE` must match the ring in
  the joystick XAML.
- Camera drag: `LOOK_SENSITIVITY` in `TouchCameraLook.ts`, then the
  degrees-per-drag curve in `PlayerActionController`, which matches the engine's
  own touch-look feel. Camera limits (pitch range, distance) are properties on
  `CameraManager`.
- Tap on the world: `TAP_MAX_TRAVEL` in `TouchTapTarget.ts` (0.03); a press that
  moves further is a drag.
- Hold-to-move, in `TouchHoldToMove.ts`: `HOLD_STOP_RADIUS_PX` (60) and
  `HOLD_RAMP_PX` (140); speed ramps from 0 at the stop radius to full 140 px
  beyond it.

## When something is wrong

| Symptom | Check |
|---|---|
| A button draws but does nothing, or responds beside where it draws | Its `BUTTON_CONFIGS` rect matches its XAML rect for the current orientation; its action is defined. |
| Buttons the wrong size, stick ring away from the finger | Panel `width` and `height` are 0; orientation, `landscape` flags and XAML builds agree. |
| Engine joystick or buttons show as well | `InputActionsManager` is on `PlayerInputServices` with `suppressBuiltInControls` on. |
| Pressing a button also turns the camera | The button is pass-through. |
| Dragging from the fire button does not aim | For this orientation the button is not pass-through, non-momentary and `HoldUntilRelease`, or (Joystick scheme) it sits outside the camera zone: the top half in portrait, the right half in landscape. |
| Icon blank or with dark fringes | The icon path is project-relative (`UI/icons/...`) and the texture has premultiplied alpha. |
| A held action stays down | Hide or disable the button with `hideButton` / `setButtonEnabled`, which release it, rather than editing its flags. |
