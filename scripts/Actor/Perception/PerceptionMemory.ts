/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v37

import {
  Vec3,
  type Entity,
} from 'meta/worlds';

/**
 * What one sense reports. Kinds mirror the audio-perception plan: visual and
 * damage now, audio next. The bus format for audio (type string, loudness
 * radius, emission timestamp) is defined by the hearing work in the neutral
 * layer; the hearing sense translates audibility at the observer's position
 * into `strength` here, so memory never handles propagation or radii.
 */
export type StimulusKind = 'visual' | 'damage' | 'audio';

export interface Stimulus {
  kind: StimulusKind;
  /** Instigator when known; null for world events. */
  source: Entity | null;
  position: Vec3;
  /**
   * 0..1. Visual observations are 1 while visible; damage is 1; audio carries
   * loudness-derived audibility, so a distant footstep never outranks a fresh
   * sighting. A stale replay weaker than memory is ignored (anti-thrash).
   */
  strength: number;
  /** Elapsed-seconds clock at sensing. */
  atSeconds: number;
}

/**
 * What is known, from any sense. Senses write stimuli; behavior reads
 * knowledge. A stimulus never grants sight — `visible` lives in the sense —
 * and one memory window (`memorySeconds`) decays everything alike, so a heard
 * gunshot is hunted exactly as long as a glimpsed target.
 */
export class PerceptionMemory {
  /** Seconds anything known is kept hunting after its last stimulus. */
  memorySeconds: number = 6;
  /** While true with a last known position, memory pins instead of expiring. */
  keepHunting: () => boolean = () => false;
  /** Runs when a target is forgotten; decision state belonged to it. */
  onForget: () => void = () => undefined;

  /** True while anything is known (seen or stimmed within `memorySeconds`). */
  aware: boolean = false;
  /** Seconds since the last stimulus of any kind. */
  secondsSinceSeen: number = 0;
  /** Where the last stimulus placed its subject. */
  lastKnownPosition: Vec3 | null = null;

  private nowSeconds: number = 0;
  private lastStimulus: Stimulus | null = null;

  /**
   * Integrates one frame of visual observation. Continuous sightings refresh;
   * silence ages out past the window unless kept hunting. A live sighting is
   * present-tense and always records: freshness arbitration (see `remember`)
   * is for timestamped replays, and no replay suppresses what is seen now.
   */
  observe(dt: number, visible: boolean, target: Entity | null, position: Vec3 | null): void {
    this.nowSeconds += dt;
    if (visible && target && position) {
      // Snapshot: the caller's Vec3 may be live (a transform read), so memory
      // keeps its own copy — later caller mutation never moves what is known.
      const snapshot = new Vec3(position.x, position.y, position.z);
      this.secondsSinceSeen = 0;
      this.lastKnownPosition = snapshot;
      this.aware = true;
      this.lastStimulus = {kind: 'visual', source: target, position: snapshot, strength: 1, atSeconds: this.nowSeconds};
      return;
    }
    this.secondsSinceSeen += dt;
    if (this.aware && this.secondsSinceSeen > this.memorySeconds) {
      if (this.keepHunting() && this.lastKnownPosition) {
        this.secondsSinceSeen = Math.min(this.secondsSinceSeen, this.memorySeconds);
      } else {
        this.forgetMemory();
      }
    }
  }

  /**
   * Records one stimulus: damage, and later audio. Sets knowledge from the
   * stimulus position with no sight implied. `atSeconds` defaults to now;
   * bus replays pass their emission time. Freshness wins: anything newer
   * applies, and ties keep the stronger — so a stale replay never restarts
   * the hunt from old data, however loud, while a fresh stimulus always does.
   */
  remember(stimulus: {
    kind: StimulusKind;
    source: Entity | null;
    position: Vec3;
    strength: number;
    atSeconds?: number;
  }): void {
    const atSeconds = stimulus.atSeconds ?? this.nowSeconds;
    const current = this.lastStimulus;
    if (current && (atSeconds < current.atSeconds || (atSeconds === current.atSeconds && stimulus.strength < current.strength))) {
      return;
    }
    this.aware = true;
    this.secondsSinceSeen = 0;
    const snapshot = new Vec3(stimulus.position.x, stimulus.position.y, stimulus.position.z);
    this.lastKnownPosition = snapshot;
    this.lastStimulus = {
      kind: stimulus.kind,
      source: stimulus.source,
      position: snapshot,
      strength: stimulus.strength,
      atSeconds,
    };
  }

  /** Treats the subject as freshly stimmed (a retreat ending behind cover). */
  markSeen(): void {
    this.secondsSinceSeen = 0;
  }

  /** Drops what is known. Decision state belonged to it (see `onForget`). */
  forgetMemory(): void {
    this.aware = false;
    this.lastKnownPosition = null;
    this.lastStimulus = null;
    this.onForget();
  }
}
