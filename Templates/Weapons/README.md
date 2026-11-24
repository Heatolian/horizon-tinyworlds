# Weapon Templates

Weapons are ItemSystem items, defined in `scripts/GameContent/ItemCatalog.ts`
(`pistol`, `rifle`, `sword`, `fists`, `fireball`, ...). This folder holds only
the templates those items point at:

| Template | Used as | By |
|----------|---------|----|
| `PistolVisual.hstf`, `RifleVisual.hstf`, `SwordVisual.hstf` | the model in hand (`Weapon.visual`) and on the ground (`WorldModel`) | `pistol`, `npc_test_pistol`, `rifle`, `sniper`, `shotgun`, `sword` |
| `GrenadeVisual.hstf`, `MolotovVisual.hstf` | the model in hand, hidden from a throw's release until the arm is back, and on the ground | `grenade`, `molotov` |
| `Grenade.hstf`, `Molotov.hstf` | the body a `Throw` delivery spawns: a `GASDeployable` with a 7.5 cm sphere collider, the same mesh on a `Visual` child, and a `Detonation` child whose VFX and sound its `cue.deployable.detonate` binding plays | `grenade`, `molotov` |
| `FireArea.hstf` | the burning patch a molotov leaves: `DeployableArea` and a `Flames` child playing a fire effect, whose extent is the effect's own `Box Size`, not the molotov's `area.radius` | `molotov` |
| `Fireball.hstf` | the projectile a `Projectile` delivery spawns: a `GASProjectile` with a trigger sphere | `fireball` |

In 3D_Template_V2, grenade/molotov model, material, VFX and SFX assets are fetched
on demand; their presentation bindings are empty. Use the asset inventory in
`Docs/INSTALLED_PACKAGE.md`.

A visual template is a pure visual, spawned locally on every machine with
networking off: a root carrying `GameplayCuePresentation` (the `cue.weapon.fire`
/ `cue.weapon.reload` sounds play from the model), a `Visual` child with the
mesh and material, and for a gun a `Muzzle` child with the muzzle-flash VFX. An
`AnchorPoint` child, if present, marks the grip.

To arm a character, put the item id in one of its containers: a player's
`Templates/GameContent/PlayerContainers.hstf` (see "Giving the player a
weapon" in `scripts/ItemSystem/README.md`), or an NPC's `ItemSystem` child
loadout (`initialItems`, e.g. `rifle` and `ammo_556*90`). A new weapon is one
`defineItem` in the catalog; copy a visual template for its model.

## Crosshair trigger

The supplied player templates aim with `CrosshairTrigger`: while the weapon in
hand has `aimMode: 'auto'` (the pistol and the rifle), it fires whenever the
screen-centre ray, the same ray a camera-aimed shot travels, first meets a
target within the weapon's reach. A target has GAS, carries the weapon's
`targetTag` (or `fallbackTargetTag`, default `enemy`) and not
`blockedTargetTag` (default `state.dead`); with neither tag it never fires,
rather than fire at teammates. Cooldown, ammo and reload stay with
the weapon. A `manual` weapon (the default, and every melee weapon) fires only
from Use. So does a `scoped` weapon (the `sniper`), and each tap of the touch
HUD's Aim button looks through its sight or back out: the camera zooms to its
`scopeFov` from the player's eyes (`CameraManager.setZoom`), so the view is not
the zoomed back of the player's own head, and the HUD shows the scope overlay
(a black mask, a lens and a duplex reticle, under every control) instead of the
crosshair. Look input slows by as much as the zoom narrows the view; recoil
does not. While firing or scoped, the body turns to the camera heading
(`faceAimWhileFiring`). The HUD crosshair shows for an `auto` weapon and for a
`manual` one aimed along the camera (`aimSource: 'camera'`, the default), and
turns red on a target; only an `auto` weapon fires on it.

Shots by the player have feel, however they are fired. A weapon's `recoil`
(`pitchDeg`, `yawDeg`, `recoverDegPerSec`) kicks the camera up, and a little
sideways at random, on every round and settles it back; since shots follow the
camera, the next ones climb too. Its `bloom` (`baseDeg`, `perShotDeg`, `maxDeg`,
`recoverDegPerSec`, `movingDeg`, `steadyFactor`) adds spread on top of the
delivery's `spreadDeg`: each round adds some up to a cap, it recovers over time,
moving adds up to `movingDeg` in proportion to the holder's speed (all of it at
its `MovementAbility.moveSpeed`), and a scoped weapon aimed multiplies it by
`steadyFactor`.
The crosshair ring frames the whole spread, the delivery's own `spreadDeg` (a
shotgun's pellets) plus the bloom, as the camera's field of view puts it on
screen, so it is larger zoomed in; it eases toward a change over
`crosshairEaseSec`. `CrosshairTrigger` runs only on the local player's
character: a bot player built from the same template is owned by the server and
keeps its AI aim. Bloom applies only while
`CrosshairTrigger` drives the weapon; NPC aim keeps its own error. A kick can
lift the crosshair off a target, so an automatic weapon keeps firing for
`targetGraceSec` (default 0.15 s) after it leaves one.

## Targeting properties

`AutoTargetWeaponController` is optional and is still present on the supplied
player templates, with both `autoTargetEnabled` and `autoAttackEnabled` off so
it does not compete with `CrosshairTrigger`; the defaults below are the
component's own. It drives the ItemSystem weapon in
hand. Targeting and
attacking are independent: targeting needs a held weapon with a usable target
tag, while attacking without targeting fires through the weapon's normal aim.

| Property | Default | What it controls |
|----------|---------|------------------|
| `autoTargetEnabled` | `false` | Selects a visible target, faces it, and overrides the held weapon aim. It does not fire. |
| `autoAttackEnabled` | `false` | Fires at `fireRate`. With auto-targeting it waits for an aligned, visible target; without auto-targeting it uses the weapon's current aim. |
| `targetRange` | `30` m | Target acquisition radius. |
| `targetRefreshIntervalSec` | `0.15` s | Delay between asynchronous target-selection queries. |
| `maxCandidateChecks` | `8` | Maximum candidates checked for line of sight per refresh. |
| `targetHeightOffset` | `1` m | Aim-point height above the target root. |
| `alignmentToleranceDegrees` | `4` | Maximum horizontal facing error before firing. |
| `requiredTargetTag` | empty | Required GAS target tag. Empty falls back to the held weapon's `targetTag`; if both are empty, auto-targeting remains inactive. |
| `blockedTargetTag` | `state.dead` | GAS tag that excludes a target. |

| Auto target | Auto attack | Behavior |
|-------------|-------------|----------|
| Off | Off | Manual aim and manual fire. |
| On | Off | Automatically select, face, and aim; the player still fires manually. |
| Off | On | Automatically fire through the weapon's current aim. |
| On | On | Automatically select, face, aim, and fire after alignment and line-of-sight checks. |
