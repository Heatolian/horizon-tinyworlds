# Music and ambience with SoundComponent

Use `Templates/Audio/MusicAmbienceArea.hstf` for persistent music and spatial
ambience controlled by game state. It provides a networked root with
`MusicAmbienceArea` and two local children carrying `SoundComponent`: nonspatial
music and spatial ambience. These emitter types are this helper's choices, not
content-type rules: music from an in-world radio can be spatial.

## Playback choice

For independent event sounds, [GameplayCuePresentation](../../gas/cues/GameplayCuePresentation.ts)
uses `AudioService.playOneShotAsset` locally on each client receiving the cue.
Use `SoundComponent` for following, looping or controllable playback. On networked
entities its configuration and playback commands can replicate; service one-shots
do not. Choose who hears a cue separately from Spatial/NonSpatial.

## Install

1. Place or copy the template.
2. Assign a sound asset on each child's `SoundComponent` in the editor. The
   template has no assigned clips and starts with `audioEnabled` false.
3. Configure `radius`, `fadeSeconds`, calm/action volumes, ambience reverb send,
   and attenuation distances on `MusicAmbienceArea`.
4. Enable the area from game code:

```ts
const audio = audioAreaEntity.getComponent(MusicAmbienceArea);
audio?.setState(0);          // Calm; enables playback
audio?.setState(1);          // Action; enables playback
audio?.setState(0.5);        // An intermediate mix; enables playback
audio?.setState(0.5, false); // Fade to silence
```

`enabled` defaults to `true`, so a one-argument call turns playback back on. To
change intensity without changing playback, pass the current `audioEnabled` as
the second argument.

Call `setState` from combat, weather, quest or GAS state changes. Nonowner
requests go to the root's owner, which replicates `intensity` and `audioEnabled`.
Each client plays its own sound children while its local player is inside the
area. Keep these children local so each client's play/stop calls are not also
replicated to other clients. The server does not play audio.

`MusicAmbienceArea` makes both sounds loop with start/stop conditions set to
`None`. The template also fixes their pitch at `1`; a `minMaxPitch` range picks
a new pitch on every `play()`. `MusicAmbienceArea` calls `SoundComponent.play()`
and `stop()` as each volume fades from or to silence.

While a loop's calm and action volumes are both above `0`, changing intensity
adjusts it without restarting it. A loop restarts when its volume falls to `0`
and rises again, for example after re-entering the area or when one state's
volume is `0`. With the template's settings, music restarts from the top and
ambience from a random point. With a Shuffle, Random or Sequential playlist
asset, each restart picks a clip by that mode.

`radius` is a sphere in world meters around the area's root, checked against
the local player's position; `0` plays throughout the world. Spatial attenuation
is measured from the audio listener. With a custom camera the listener is at the
camera, so allow for its distance behind the character when setting
`calmDistance` and `actionDistance`. With the built-in third-person or follow
camera it is at the player's head. `AudioService` listener overrides replace
both. In each distance pair, X is the full-volume distance and Y the inaudible
distance. Reverb send needs a world reverb zone around the listener to produce
an audible effect.
