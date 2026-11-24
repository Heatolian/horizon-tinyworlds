/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v30

import {ActorBehavior, TransformComponent, Vec3} from 'meta/worlds';
import type {ActorBehaviorManager, ActorController} from 'meta/worlds';
import {IActorAttackControllerTypeId} from '../../Controllers/Definitions/IActorAttackController';
import {GotoBehavior} from './GotoBehavior';

const DEFAULT_LEASH_RADIUS = 15;
const DEFAULT_ARRIVE_RADIUS = 1.5;
const DEFAULT_RETURN_SPEED = 3;
const MIN_LEASH_GAP = 1;

/**
 * LeashBehavior — walks the actor back to a base position once it is more
 * than `leashRadius` from it, and keeps walking until it is within
 * `arriveRadius`. Idle otherwise: it claims no controller, so lower-priority
 * behaviors (combat, patrol) drive the actor.
 *
 * Unlike the soft `leashRadius` of wander and flee, which only clamps where
 * those behaviors choose to go, this leash pulls the actor back from any
 * lower-priority behavior.
 *
 * While returning it also holds the attack controller without firing, so a
 * combat behavior below it cannot attack on the way home.
 *
 * A fresh `GotoBehavior` is created per return: re-assigning an unchanged
 * target does not repath, so a reused goto would steer along the route it
 * planned from where the previous return started.
 */
export class LeashBehavior extends ActorBehavior {
  override name: string = 'LeashBehavior';

  /** Position to return to. Null means the actor's position at initialize. */
  basePosition: Vec3 | null = null;
  leashRadius: number = DEFAULT_LEASH_RADIUS;
  arriveRadius: number = DEFAULT_ARRIVE_RADIUS;
  returnSpeed: number = DEFAULT_RETURN_SPEED;
  isRemoved: boolean = false;

  private goto: GotoBehavior | null = null;

  get isReturning(): boolean {
    return this.goto !== null;
  }

  /** For live edits after initialize(), which is the only other place the settings are checked. */
  applySettings(leashRadius: number, arriveRadius: number, returnSpeed: number): void {
    this.leashRadius = leashRadius;
    this.arriveRadius = arriveRadius;
    this.returnSpeed = returnSpeed;
    this.sanitizeSettings();
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.sanitizeSettings();
    if (!this.basePosition) {
      const p = this.getEntity().getComponent(TransformComponent)?.worldPosition;
      this.basePosition = p ? new Vec3(p.x, p.y, p.z) : null;
    }
  }

  override update(deltaTime: number): void {
    const distance = this.distanceToBaseXZ();
    if (distance === null) {
      return;
    }
    if (!this.goto) {
      if (distance <= this.leashRadius) {
        return;
      }
      this.goto = this.createGoto();
    } else if (distance <= this.arrivalRadius(this.goto)) {
      this.goto.onRemove();
      this.goto = null;
      return;
    }
    // Re-copied every frame so a live edit reaches a return already under way.
    this.goto.desiredSpeed = this.returnSpeed;
    this.goto.distanceToStop = this.arriveRadius * 0.5;
    this.goto.update(deltaTime);
  }

  override getControllerUsePriority(controllerType: string): number {
    if (!this.goto) {
      return -1;
    }
    if (controllerType === IActorAttackControllerTypeId) {
      return this.basePriority;
    }
    return this.goto.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (this.goto && controllerType !== IActorAttackControllerTypeId) {
      this.goto.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    this.isRemoved = true;
    this.goto?.onRemove();
    this.goto = null;
  }

  private createGoto(): GotoBehavior {
    const goto = new GotoBehavior();
    goto.basePriority = this.basePriority;
    goto.desiredSpeed = this.returnSpeed;
    goto.distanceToStop = this.arriveRadius * 0.5;
    // GotoBehavior.initialize() paths to targetPosition, so it must be set first.
    goto.targetPosition = this.basePosition!;
    goto.initialize(this.behaviorManager!);
    return goto;
  }

  // The goto parks within its runtime stop distance, which widens on slow
  // hosts; arriving inside that band must still count as home.
  private arrivalRadius(goto: GotoBehavior): number {
    return Math.max(this.arriveRadius, goto.getRuntimeStopDistance());
  }

  private distanceToBaseXZ(): number | null {
    const base = this.basePosition;
    const self = this.getEntity().getComponent(TransformComponent)?.worldPosition;
    if (!base || !self) {
      return null;
    }
    const dx = self.x - base.x;
    const dz = self.z - base.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private sanitizeSettings(): void {
    // A return at speed 0 never ends, and holds the attack controller throughout.
    if (!Number.isFinite(this.returnSpeed) || this.returnSpeed <= 0) {
      this.returnSpeed = DEFAULT_RETURN_SPEED;
    }
    if (!Number.isFinite(this.arriveRadius) || this.arriveRadius <= 0) {
      this.arriveRadius = DEFAULT_ARRIVE_RADIUS;
    }
    if (!Number.isFinite(this.leashRadius) || this.leashRadius <= 0) {
      this.leashRadius = DEFAULT_LEASH_RADIUS;
    }
    // A leash inside the arrive radius would start and end a return on the
    // same frame, every frame.
    const minLeash = this.arriveRadius + MIN_LEASH_GAP;
    if (this.leashRadius < minLeash) {
      console.warn(
        `[LeashBehavior] leashRadius (${this.leashRadius}) must exceed arriveRadius ` +
          `(${this.arriveRadius}) by ${MIN_LEASH_GAP} m; using ${minLeash}.`,
      );
      this.leashRadius = minLeash;
    }
  }
}
