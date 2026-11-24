/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v10

import type {Entity} from 'meta/worlds';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';
import {AnimKey} from '../AnimationGraphContract';
import {MovementAbility} from '../../Character/Abilities/MovementAbility';
import {CharacterForceControllerBase} from '../../Character/Force/CharacterForceControllerBase';
import {WorldsGroundInfoComponent} from '../../Character/Physics/WorldsGroundInfoComponent';
import {CharacterStateMachine, StateId} from '../../Character/State/CharacterStateMachine';
import type {
  AnimationContext,
  AnimationFrame,
  AnimationModule,
} from './AnimationModule';

const LAYER_NAME = 'Airborne_Layer';

/** Drives the authored jump, in-air, and landing pass from character physics. */
export class AirborneAnimationModule implements AnimationModule {
  readonly netKeys: readonly string[] = [
    AnimKey.JUMP_TRIGGER,
    AnimKey.IS_JUMPING,
    AnimKey.IS_GROUNDED,
  ];

  private readonly maxTimeTillLandSeconds: number = 3.0;
  private readonly minAirborneDurationSeconds: number = 0.3;

  private context!: AnimationContext;
  private stateMachine: CharacterStateMachine | null = null;
  private forceController: CharacterForceControllerBase | null = null;
  private groundInfo: WorldsGroundInfoComponent | null = null;
  private ownerDriven: boolean = false;
  private passRunning: boolean = false;
  private netJumping: boolean = false;
  private netGrounded: boolean = true;
  private lastJumpTimeMs: number = -1;

  attach(context: AnimationContext): void {
    this.context = context;
    context.mountLayer(LAYER_NAME);
  }

  onCharacterReady(characterRootEntity: Entity, characterSimulatedEntity: Entity): void {
    this.ownerDriven = characterRootEntity.getComponent(MovementAbility) !== null;
    this.stateMachine = characterRootEntity.getComponent(CharacterStateMachine);
    this.forceController =
      characterSimulatedEntity.getComponent(CharacterForceControllerBase) ??
      characterRootEntity.getComponent(CharacterForceControllerBase);
    this.groundInfo =
      characterSimulatedEntity.getComponent(WorldsGroundInfoComponent) ??
      characterRootEntity.getComponent(WorldsGroundInfoComponent);
  }

  onNetValue(key: string, value: ReplicatedValue, _replayed: boolean): void {
    if (key === AnimKey.IS_JUMPING) {
      this.netJumping = value === true;
    } else if (key === AnimKey.IS_GROUNDED) {
      this.netGrounded = value === true;
    }
  }

  /**
   * Per-frame on a PROXY — the endpoint that renders a server-owned NPC, and the one the
   * owner-side {@link onOwnerUpdate} never reaches.
   *
   * The authored graph walks `jump state -> inAir state -> landing state -> empty state` off
   * `Jumping` and `TimeTillLand`, and both are written with `setGraphVariable`, which is
   * local to whoever writes it. So an owner that computes them perfectly changes nothing on
   * the machine drawing the character: the replicated trigger put the proxy's layer into
   * `jump state` and then nothing ever advanced or released it.
   *
   * A proxy cannot run projectile prediction: owner-only readiness gives it no ground
   * distance or sampled velocity. Replicated stance drives `Grounded`, which the graph
   * checks on every tick to release the airborne pose at touchdown. `TimeTillLand` is only
   * an airborne-entry prediction, with the same 3.0 fallback as missing owner physics.
   */
  onUpdate(_frame: AnimationFrame): void {
    if (this.ownerDriven) {
      return;
    }
    const grounded = this.netGrounded;
    const inLaunchGrace = this.isInLaunchGrace();

    // A proxy that joins mid-flight has stance but no trigger: `bindStateReplication` replays
    // the VALUE snapshot and triggers are never replayed, so `onNetTrigger` — the only other
    // way into the pass — has already been missed. Without this the graph variables below are
    // written to a layer sitting in `empty state`, and the character finishes its jump with no
    // airborne pose at all.
    //
    // Seed only while jumping AND airborne: stance channels can arrive separately, and a
    // grounded flag arriving before the jumping flag clears must not replay the pass.
    // Falling without a jump trigger must not seed a jump state either.
    if (this.netJumping && !this.netGrounded && !this.passRunning) {
      this.context.playState(LAYER_NAME, 'jump state');
      this.passRunning = true;
    } else if (!this.netJumping && !inLaunchGrace) {
      // No longer jumping: the pass is over however it ended — a landing, or the flag clearing
      // mid-air before a re-trigger — so a later seed can re-enter it. Grounded is deliberately
      // neither required nor sufficient: a re-trigger that clears IS_JUMPING while still airborne
      // must reset, and a touchdown while IS_JUMPING is still latched must not, or a ground
      // flicker would replay the pass. The graph's `Grounded` edges own touchdown recovery. The
      // launch-grace guard stops a value that arrives a frame after the trigger from resetting a
      // pass `onNetTrigger` just started.
      this.passRunning = false;
    }

    this.context.setGraphVariable('Grounded', grounded && !inLaunchGrace);
    this.context.setGraphVariable('Jumping', this.netJumping);
    this.context.setGraphVariable(
      'TimeTillLand',
      grounded && !inLaunchGrace ? 0 : this.maxTimeTillLandSeconds,
    );
  }

  onNetTrigger(key: string): void {
    if (key !== AnimKey.JUMP_TRIGGER) {
      return;
    }
    this.lastJumpTimeMs = Date.now();
    this.context.setGraphVariable('Grounded', false);
    this.context.playState(LAYER_NAME, 'jump state');
    this.passRunning = true;
  }

  onOwnerUpdate(_frame: AnimationFrame): void {
    this.ownerDriven = true;
    const state = this.stateMachine?.getCurrentState() ?? StateId.Movement;
    const isGrounded = this.stateMachine?.isGrounded() ?? true;
    this.context.setGraphVariable('Grounded', isGrounded && !this.isInLaunchGrace());
    this.context.setGraphVariable('Jumping', state === StateId.Jumping);
    this.context.setGraphVariable('TimeTillLand', this.computeTimeTillLandSeconds(isGrounded));
  }

  /**
   * Predicted seconds until touchdown, from `d = -v·t + 0.5·g·t²` solved for t, with v the
   * current vertical velocity (up positive), g the gravity magnitude, and d the distance from
   * feet to the ground directly below. Returns 0 when grounded after takeoff grace; the
   * independent `Grounded` graph input owns touchdown recovery. Clamps to
   * {@link maxTimeTillLandSeconds} when no ground is within cast range.
   *
   * WHY g is read off the force controller rather than held as a constant: the graph takes
   * `empty state -> inAir state` on `TimeTillLand > 0.2` with `Jumping == false`, so this
   * prediction alone decides whether walking off a ledge plays the jump loop. A hardcoded
   * 9.81 under-reads a world that configures stronger gravity and inflates the prediction by
   * `sqrt(gConfigured / 9.81)`, dropping the trip height by the same factor. This package
   * itself runs 9.8, so the constant was accidentally right here; in the derived world that
   * surfaced this, running 20 m/s², a 0.2 m kerb read as a 0.2 s fall and animated a jump
   * nobody asked for. The simulation's own value is the only one that matches the arc being
   * predicted.
   */
  private computeTimeTillLandSeconds(isGrounded: boolean): number {
    const inLaunchGrace = this.isInLaunchGrace();
    if (isGrounded && !inLaunchGrace) {
      return 0;
    }
    if (!this.groundInfo || !this.forceController) {
      return this.maxTimeTillLandSeconds;
    }
    const g = this.forceController.gravity.magnitude();
    // `!(g > 0)` rather than `g <= 0`: a runtime read can be NaN, and NaN fails both
    // comparisons, so the `g <= 0` form would let it through into the solve below and write a
    // NaN `TimeTillLand` the graph's `> 0.2` edge can neither trip nor clear.
    if (!(g > 0) || !Number.isFinite(g)) {
      return this.maxTimeTillLandSeconds;
    }
    const d = this.groundInfo.groundDistance;
    const v = this.forceController.sampledVelocity.y;
    const t = (v + Math.sqrt(v * v + 2 * g * d)) / g;
    const bounded = Number.isFinite(t)
      ? Math.min(Math.max(0, t), this.maxTimeTillLandSeconds)
      : this.maxTimeTillLandSeconds;
    return inLaunchGrace ? Math.max(bounded, this.maxTimeTillLandSeconds) : bounded;
  }

  private isInLaunchGrace(): boolean {
    return this.lastJumpTimeMs >= 0 &&
      Date.now() - this.lastJumpTimeMs < this.minAirborneDurationSeconds * 1000;
  }
}
