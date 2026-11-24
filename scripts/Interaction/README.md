# Interaction

The player can already interact. Its `Interactor` child in
`Templates/PlayerCharacter.hstf` carries `InteractorComponent`,
`InteractionController` and `InteractionControlsBridge`. The bridge shows the
`Interact` HUD button while an object is in range and activates it on press; a
tap on the object activates it too. With several interactables in reach, in
the camera modes the player aims, the bridge picks by the camera
(`selectByCameraFacing`); in the fixed-angle modes (TopDown, Isometric,
SideScroll, Static) the closest wins. Set `selectByCameraFacing` to false for
closest-wins everywhere. `PlayerCharacter` also sets `selectAlongHeading`,
which judges from the player instead of the camera: the first object whose
sensor the line from the player along the camera's heading passes through is
selected, so of two objects in line ahead the nearer one wins. Turn it off to
select the object nearest the centre of the view instead (from a third-person
camera, the farther of two objects in line). Do not add or rebuild any of this.

To make an object interactable, copy an example template and change it.

## Example templates (unplaced)

| Template | What it does |
|---|---|
| `Templates/Interaction/InteractableLever.hstf` | A lever. Interacting tilts the handle between off and on. |
| `Templates/Interaction/InteractableDoor.hstf` | A door that swings 90 degrees on its hinge and blocks the player while closed. |

Both use `SimpleInteractableToggle`: each interaction flips a replicated on/off
state for every player and turns the `pivot` entity from its authored rotation
to `onRotation`. Both are verified against the rules below, so they highlight,
show the button and activate as shipped.

To make a new interactable:

1. Place the closer template and rename it. For a new object type that will be
   placed several times, duplicate the template's `.hstf` instead. Either way,
   start from the template rather than rebuilding its entities by hand: it
   carries the networked root, the sensor layout and the highlight setup, and a
   hand-built copy that misses one of them looks right but does nothing.
2. Swap the meshes on the `*Mesh` / `Handle` entities. Every mesh entity that
   should glow keeps its `HighlightPlatformComponent`.
3. Resize the physical collider (`Body` on the lever, `Panel` on the door) and
   the `InteractionSensor` collider to fit. The sensor sets the reach: keep it a
   little larger than the object. Sensors of nearby interactables may overlap;
   the one the camera faces is selected (see `selectByCameraFacing` above).
4. Set `onRotation` (degrees) and `turnSeconds` on `SimpleInteractableToggle`,
   or remove the component and add your own (see "Reacting in code").

## Reacting in code

```ts
const toggle = leverEntity.getComponent(SimpleInteractableToggle);
toggle?.addListener(on => {
  if (NetworkingService.get().isServerContext()) {
    // shared change, e.g. open a gate or start a platform
  }
});
```

Listeners run on every machine when the state flips. `toggle.toggle()` flips it
from code; `toggle.on` reads it.

For something other than an on/off switch, write a component for the object
root that subscribes `OnInteractionEvent` with `ExecuteOn.Everywhere` and
checks `isMyInteractionTarget(payload.interactable, this.entity)`. The event
fires only on the interacting player's client, never on the server, so change
shared state through an `@rpc` to the object's owner and a
`@property({isNetworked: true})`, as `SimpleInteractableToggle` does.

## Rules for an interactable built by hand

The templates already follow these. A missed rule leaves the object silently
inert: everything compiles and no error appears.

| Rule | Why |
|---|---|
| `InteractionTargetComponent` goes on a separate `InteractionSensor` child, with a `PhysicsBodyPlatformComponent` of `DynamicCollider` / `Kinematic` and a collider on `Layer3`. | The player's interactor is a `Layer3` trigger and only overlaps that. A `Trigger` sensor never registers; `KinematicCollider` is not a valid type. |
| The sensor is a child of the entity with the object's physical collider. | The line-of-sight check ignores the sensor's ancestors only. A physical collider beside the sensor blocks the check, so the object never comes into range. |
| `SimpleInteractablePromptComponent` and any gameplay component go on the object root, above the sensor. | Events name the sensor; `isMyInteractionTarget` matches only the sensor or its ancestors. |
| The object root is networked: in a template, its `attributes` hold `horizon::NetworkableTemplateEntityAttribute` with `isNetworkable: true`. | Without it every machine has its own local copy, so an `@rpc` to the owner reaches nobody and the object never changes. The runtime logs `Ignoring event 'Rpc:...' ... because no event subscriptions are listening for it`. |
| Each mesh entity that should glow carries `HighlightPlatformComponent` (that exact name), with `enabled: false`. | The prompt component drives an existing highlight and cannot add one at runtime. It must sit on the entity with the `MeshComponent`. |
| `outlineWidth` stays small (0.02). | It is in world units; above 0.1 looks exaggerated. |
| Set `directTouchEnabled: false` on the sensor's `InteractionTargetComponent` for button-only objects. | Taps on the object then do nothing; the button still works. |

## Symptoms

| Symptom | Check |
|---|---|
| No `Interact` button near the object | Sensor layer, body type and parent (first three rules); sensor size. |
| Button shows but nothing glows | `HighlightPlatformComponent` on each mesh entity. |
| Button works, nothing happens (only `[SimpleInteract] activated` is logged) | The object root is networked (rule above); the gameplay component is on the root and matches with `isMyInteractionTarget`; shared changes go through an `@rpc` to the owner. |
| Works for one player only | State changed on the interacting client instead of through the owner. |
| The wrong one of two nearby objects is selected | Facing selection needs `selectByCameraFacing` on, a `CameraManager` in the scene and an aimed camera mode; otherwise the closest wins. A script that sets `InteractorComponent.cameraEntity` or installs its own candidate selector needs `selectByCameraFacing` off. Setting `cameraEntity` alone does not switch between objects near the player with an orbit camera (the SDK ranking's incumbent bonus is larger than their angle difference); see `FacingSelection.ts`. |
| The object behind the one at the player's feet is selected | `selectAlongHeading` is off on this character: camera-facing selection picks the farther of two objects in line, which is nearer the centre of the view. Turn it on. |
