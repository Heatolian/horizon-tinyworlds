/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v2

import {
  AudioEmitterType,
  AudioService,
  Component,
  component,
  editor,
  property,
  serializable,
  SoundAsset,
  TransformComponent,
  VfxComponent,
  type Entity,
  type Maybe,
  type Vec3,
} from 'meta/worlds';
import type {GameplayCueContext} from './GameplayCueContext';

@serializable()
export class GameplayCueBinding {
  @property()
  public readonly cueTag: string = '';

  @property()
  public readonly presentationEntity: Maybe<Entity> = null;

  @property()
  public readonly sound: Maybe<SoundAsset> = null;
}

@component({
  description: 'Local VFX and audio presentation for gameplay cues emitted by this entity.',
})
export class GameplayCuePresentation extends Component {
  @editor({
    description:
      'Cue presentation bindings. Multiple entries may share a tag to play several effects.',
  })
  @property({isNetworked: false})
  public readonly bindings: readonly GameplayCueBinding[] = [];

  public worldPositionFor(cueTag: string): Vec3 | undefined {
    const binding = this.bindings.find(
      (candidate: GameplayCueBinding): boolean => candidate.cueTag === cueTag,
    );
    return (binding?.presentationEntity ?? this.entity).getComponent(TransformComponent)
      ?.worldPosition;
  }

  public handleCue(tag: string, context: GameplayCueContext): void {
    for (const binding of this.bindings) {
      if (binding.cueTag !== tag) {
        continue;
      }
      (binding.presentationEntity ?? this.entity).getComponent(VfxComponent)?.play();
      if (binding.sound) {
        AudioService.get().playOneShotAsset({
          soundAsset: binding.sound,
          emitterType: AudioEmitterType.Spatial,
          position: context.location,
        });
      }
    }
  }
}
