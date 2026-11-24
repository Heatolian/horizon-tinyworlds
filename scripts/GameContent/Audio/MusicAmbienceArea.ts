/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v4

import {
  AudioEmitterType,
  AudioFalloff,
  Component,
  component,
  editor,
  type Entity,
  ExecuteOn,
  type Maybe,
  NetworkingService,
  OnEntityDisableEvent,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  PlayerService,
  property,
  rpc,
  Service,
  SoundComponent,
  SoundStartCondition,
  SoundStopCondition,
  subscribe,
  TransformComponent,
  Vec2,
} from 'meta/worlds';

import {approach, LoopingSoundMix, unitValue} from './LoopingSoundMix';

@component({description: 'Music and spatial ambience using two SoundComponents. Copy Templates/Audio/MusicAmbienceArea.hstf, assign sound assets on its music and ambience children, then call setState(intensity, enabled). Each client fades its own loops while its local player is inside the area.'})
export class MusicAmbienceArea extends Component {
  @editor({description: 'Local child carrying a SoundComponent with a looping music asset.'})
  @property()
  music: Maybe<Entity> = null;

  @editor({description: 'Local child carrying a SoundComponent with a looping ambience asset.'})
  @property()
  ambience: Maybe<Entity> = null;

  @editor({description: 'World-space radius in meters around this entity. 0 plays throughout the world.'})
  @property({minValue: 0})
  radius: number = 4;

  @editor({description: 'Seconds for a full-range volume or game-state transition. 0 snaps.'})
  @property({minValue: 0})
  fadeSeconds: number = 1;

  @editor({description: 'Music volume at calm (X) and action (Y) intensity.'})
  @property()
  musicVolumes: Vec2 = new Vec2(0.25, 0.6);

  @editor({description: 'Ambience volume at calm (X) and action (Y) intensity.'})
  @property()
  ambienceVolumes: Vec2 = new Vec2(0.5, 0.2);

  @editor({description: 'Ambience reverb send at calm (X) and action (Y) intensity. Requires a world reverb zone to hear reverb.'})
  @property()
  ambienceReverb: Vec2 = new Vec2(0.1, 0.35);

  @editor({description: "Calm ambience full-volume (X) and inaudible (Y) distances from the audio listener: the camera with a custom camera, the player's head with the built-in third-person camera."})
  @property()
  calmDistance: Vec2 = new Vec2(10, 16);

  @editor({description: 'Action ambience full-volume (X) and inaudible (Y) distances in meters from the audio listener.'})
  @property()
  actionDistance: Vec2 = new Vec2(12, 20);

  @editor({description: 'Replicated game state: 0 is calm, 1 is action. The owner writes it; other machines call setState.'})
  @property({isNetworked: true, minValue: 0, maxValue: 1})
  intensity: number = 0;

  @editor({description: 'Replicated playback permission. Disabling fades both loops to silence.'})
  @property({isNetworked: true})
  audioEnabled: boolean = true;

  private musicMix: Maybe<LoopingSoundMix> = null;
  private ambienceMix: Maybe<LoopingSoundMix> = null;
  private ambienceSound: Maybe<SoundComponent> = null;
  private areaTransform: Maybe<TransformComponent> = null;
  private players: Maybe<PlayerService> = null;
  private localPlayer: Maybe<Entity> = null;
  private localPlayerTransform: Maybe<TransformComponent> = null;
  private currentIntensity = 0;
  private reverbSendLevel: Maybe<number> = null;
  private distance: Maybe<Vec2> = null;

  /** Call from combat, weather, quest or GAS state changes. */
  public setState(intensity: number, enabled: boolean = true): void {
    if (this.entity.networked && !this.entity.isOwned()) {
      this.RpcSetState(unitValue(intensity), enabled);
    } else {
      this.intensity = unitValue(intensity);
      this.audioEnabled = enabled;
    }
  }

  @rpc({execution: ExecuteOn.Owner})
  // eslint-disable-next-line @typescript-eslint/naming-convention -- @rpc method naming idiom
  RpcSetState(intensity: number, enabled: boolean): void {
    this.intensity = unitValue(intensity);
    this.audioEnabled = enabled;
  }

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    const music = this.music?.getComponent(SoundComponent);
    const ambience = this.ambience?.getComponent(SoundComponent);
    this.areaTransform = this.entity.getComponent(TransformComponent);
    if (music == null || ambience == null || music === ambience || this.areaTransform == null) {
      console.warn('[MusicAmbienceArea] Assign separate music and ambience SoundComponent children.');
      return;
    }
    this.players = Service.get(PlayerService);
    this.configureSound(music, AudioEmitterType.NonSpatial);
    this.configureSound(ambience, AudioEmitterType.Spatial);
    ambience.setFalloff(AudioFalloff.Linear);
    this.musicMix = new LoopingSoundMix(music);
    this.ambienceMix = new LoopingSoundMix(ambience);
    this.ambienceSound = ambience;
    this.currentIntensity = unitValue(this.intensity);
  }

  private configureSound(sound: SoundComponent, type: AudioEmitterType): void {
    sound.soundEmitterType = type;
    sound.loop = true;
    sound.startCondition = SoundStartCondition.None;
    sound.stopCondition = SoundStopCondition.None;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.musicMix == null || this.ambienceMix == null || this.ambienceSound == null) {
      return;
    }
    const dt = Number.isFinite(payload.deltaTime) ? Math.max(0, payload.deltaTime) : 0;
    this.currentIntensity = approach(this.currentIntensity, unitValue(this.intensity), dt, this.fadeSeconds);
    const active = this.audioEnabled && this.isLocalPlayerInside();
    const reverb = unitValue(this.mix(this.ambienceReverb));
    if (reverb !== this.reverbSendLevel) {
      this.ambienceSound.reverbSendLevel = reverb;
      this.reverbSendLevel = reverb;
    }
    const near = Math.max(0, this.calmDistance.x + (this.actionDistance.x - this.calmDistance.x) * this.currentIntensity);
    const far = Math.max(near + 0.01, this.calmDistance.y + (this.actionDistance.y - this.calmDistance.y) * this.currentIntensity);
    if (near !== this.distance?.x || far !== this.distance?.y) {
      // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- Vec2 is immutable; allocate only when the distance changes
      this.distance = new Vec2(near, far);
      this.ambienceSound.minMaxDistance = this.distance;
    }
    this.musicMix.update(active ? this.mix(this.musicVolumes) : 0, dt, this.fadeSeconds);
    this.ambienceMix.update(active ? this.mix(this.ambienceVolumes) : 0, dt, this.fadeSeconds);
  }

  private mix(values: Vec2): number {
    return values.x + (values.y - values.x) * this.currentIntensity;
  }

  private isLocalPlayerInside(): boolean {
    const localPlayer = this.players?.getLocalPlayer() ?? null;
    if (localPlayer !== this.localPlayer || this.localPlayerTransform == null) {
      this.localPlayer = localPlayer;
      this.localPlayerTransform = localPlayer?.getComponent(TransformComponent) ?? null;
    }
    const player = this.localPlayerTransform;
    if (player == null || this.areaTransform == null) {
      return false;
    }
    if (this.radius <= 0) {
      return true;
    }
    const position = player.worldPosition;
    const center = this.areaTransform.worldPosition;
    const dx = position.x - center.x;
    const dy = position.y - center.y;
    const dz = position.z - center.z;
    return dx * dx + dy * dy + dz * dz <= this.radius * this.radius;
  }

  @subscribe(OnEntityDisableEvent, {execution: ExecuteOn.Everywhere})
  private onDisable(): void {
    this.musicMix?.stop();
    this.ambienceMix?.stop();
  }
}
