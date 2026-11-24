/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */

// Character Scripts v15

/**
 * DodgeRollAbility — moves the character a fixed distance along its facing (or a
 * commanded direction), only between `moveStartPhase` and `moveEndPhase` of the
 * roll.
 *
 * The travel is scripted rather than read from the clip: the roll plays on an
 * overlay layer, and only the BASE layer's root motion reaches script.
 * Movement goes through `addMoveDelta()` because the character controller
 * reasserts any direct `worldPosition` write.
 *
 * The roll is the GAS ability `character.dodge` (`DodgeRollGASAbility`): GAS checks its cooldown
 * and `blockedByTags` (dead, staggered, already rolling), raises `state.dodging` while it runs,
 * and ticks it. This component holds the settings, binds the button and starts the ability; a
 * body without a GASComponent cannot roll. The roll pose is played by `DodgeAnimationModule`,
 * which watches `state.dodging`.
 *
 * A roll starts with `activate()`, from the bound button or a driver such as
 * ActorDodgeController. It keeps the stick off the body by blocking MovementAbility until the
 * roll's blend-out. It never goes through CharacterStateMachine, which the character team treats
 * as legacy.
 *
 * Component Attachment: character root.
 * Component Networking: Owner-only; other clients see the travel through the replicated
 * transform and the pose through the animation channel.
 */

import {
  CharacterControllerBase,
  Component,
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  InputVisualConfigAsset,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  PlayerInputAction,
  PlayerInputActionCallbackPayload,
  PlayerInputService,
  PlayerInputState,
  PlayerInputSubscription,
  TransformComponent,
  Vec3,
  type Maybe,
} from 'meta/worlds';

import {MovementAbility} from './MovementAbility';
import {GASComponent} from '../../gas/core/GASComponent';
import {GASAbility} from '../../gas/abilities/GASAbility';
import {GASAbilityData} from '../../gas/abilities/GASAbilityData';
import {DEAD_TAG, DODGING_TAG, STAGGERED_TAG} from '../gas/CharacterTags';

// Match the DodgeRoll -> empty_state blend authored in Dodge_Roll_Layer.
const exitBlendTimeSec: number = 0.2;

// Named rather than the whole `state` hierarchy, which also holds sprinting and swimming.
const blockingTags: readonly string[] = [DEAD_TAG, STAGGERED_TAG, DODGING_TAG];

/** Everything one roll needs, captured when it starts. */
interface DodgeRollRequest {
  direction: Vec3;
  controller: Maybe<CharacterControllerBase>;
  movement: Maybe<MovementAbility>;
  distance: number;
  durationSec: number;
  moveStartPhase: number;
  moveEndPhase: number;
}

/**
 * One dodge roll, run by GAS: activated by `DodgeRollAbility.activate()`, ticked by the owner's
 * ability manager, and ended when the roll finishes, when the body dies, or by `cancel()`.
 */
export class DodgeRollGASAbility extends GASAbility {
  private request: DodgeRollRequest | null = null;
  private elapsedSec: number = 0;
  private released: boolean = true;

  /** True once the stick may drive the body again: idle, or in the roll's blend-out. */
  public get movementReleased(): boolean {
    return this.released;
  }

  override onActivate(userData: unknown): void {
    this.request = userData as DodgeRollRequest;
    this.elapsedSec = 0;
    this.released = false;
    this.request.movement?.setMovementBlocked(true);
  }

  override tick(delta: number): void {
    const request = this.request;
    if (request == null) {
      return;
    }
    // The roll moves through addMoveDelta, which MovementAbility's block does not stop.
    if (this.isDead()) {
      this.owner.endAbility(this.data.abilityId);
      return;
    }
    const duration = request.durationSec;
    const phaseBefore = this.elapsedSec / duration;
    this.elapsedSec = Math.min(this.elapsedSec + delta, duration);
    const phaseAfter = this.elapsedSec / duration;

    // Move by the slice of this frame that overlaps the travel window, so the
    // total is exactly `distance` however frames straddle the window edges.
    const start = Math.min(request.moveStartPhase, request.moveEndPhase);
    const end = Math.max(request.moveStartPhase, request.moveEndPhase);
    const overlap = Math.min(phaseAfter, end) - Math.max(phaseBefore, start);
    if (request.controller && overlap > 0 && end > start) {
      request.controller.addMoveDelta(
        request.direction.mul((request.distance * overlap) / (end - start)),
      );
    }

    // Never before the travel window closes, or a short roll would hand the
    // joystick back while the scripted travel is still moving the character.
    if (
      this.elapsedSec >= Math.max(duration - exitBlendTimeSec, end * duration)
    ) {
      this.releaseMovement();
    }
    if (this.elapsedSec >= duration) {
      this.owner.endAbility(this.data.abilityId);
    }
  }

  override onEnd(): void {
    this.releaseMovement();
    this.request = null;
    // GAS starts the cooldown at activation; restarting it here makes `cooldownSec` run from
    // the end of the roll, however the roll ended.
    this.remainingCooldown = this.data.cooldown;
  }

  /** Stop a roll GAS has dropped (its ability manager was rebuilt), so the stick comes back. */
  public abandon(): void {
    this.releaseMovement();
    this.request = null;
    this.isActive = false;
  }

  private isDead(): boolean {
    return (this.owner as unknown as GASComponent).hasTag(DEAD_TAG);
  }

  /**
   * WHY: a blocked MovementAbility skips its update, so its acceleration and the
   * velocity the animator reads for Speed stay frozen at the pre-roll run. Let go
   * mid-roll, that replays as one extra step and reveals a run pose; clearing
   * drops it, and releasing at the blend-out lets locomotion settle unseen.
   */
  private releaseMovement(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    // Death blocks the same flag; unblocking a dead body would let it walk again.
    if (this.isDead()) {
      return;
    }
    this.request?.movement?.clearMotion();
    this.request?.movement?.setMovementBlocked(false);
  }
}

@component({
  description: `Dodge roll: moves the character along its facing for a fixed distance, as the GAS ability character.dodge. Needs a GASComponent on the body. The roll pose is played by DodgeAnimationModule.`,
})
export class DodgeRollAbility extends Component {
  static readonly abilityId: string = 'character.dodge';

  @editor({description: `Metres travelled along the character's facing.`})
  @property({isNetworked: false, minValue: 0.0, maxValue: 10.0})
  public distance: number = 4.0;

  @editor({
    description: `Seconds the whole roll takes. The layer retimes the clip to finish in exactly this long; the clip's authored length is 1.8 s.`,
  })
  @property({isNetworked: false, minValue: 0.05, maxValue: 5.0})
  public rollDodgeDuration: number = 1.0;

  @editor({
    description: `Point in the roll (0 = start, 1 = end) where travel begins. Before it the character stays put, so the wind-up does not slide the feet.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 1.0})
  public moveStartPhase: number = 0.05;

  @editor({
    description: `Point in the roll (0 = start, 1 = end) where travel stops. After it the character stays put while the clip stands up.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 1.0})
  public moveEndPhase: number = 0.7;

  @editor({description: `Seconds after a roll ends before another can start.`})
  @property({isNetworked: false, minValue: 0.0, maxValue: 5.0})
  public cooldownSec: number = 0.2;

  @editor({
    description: `Dodge button config (.inputconfig), bound to TertiaryRight. With built-in controls suppressed, PlayerActionController shows the touch HUD's Dodge button instead. Unassigned = no button, no binding. Only one component may subscribe to TertiaryRight (T216638120).`,
  })
  @property({isNetworked: false})
  public dodgeRollInputConfig: Maybe<InputVisualConfigAsset> = null;

  private controller: Maybe<CharacterControllerBase> = null;
  private transform: Maybe<TransformComponent> = null;
  private movement: Maybe<MovementAbility> = null;
  private inputSub: Maybe<PlayerInputSubscription> = null;
  private referencesResolved: boolean = false;
  private liveRoll: DodgeRollGASAbility | null = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onEntityStart(): void {
    this.refreshOwnership();
  }

  // Ownership can arrive after start, and losing it stops the owner-only update
  // mid-roll — without this the button stays dead or a roll is left half-run.
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  private onOwnershipTransfer(): void {
    this.refreshOwnership();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onEntityDestroy(): void {
    this.cancel();
    this.unbindInput();
  }

  private refreshOwnership(): void {
    if (!this.entity.isOwned()) {
      this.cancel();
      this.unbindInput();
      return;
    }
    this.resolveReferences();
    this.clearStaleDodgingTag();
    this.bindInput();
  }

  /**
   * A roll cancelled on the endpoint that lost ownership ends its ability there, but a proxy
   * cannot publish tag changes, so `state.dodging` can arrive here with no roll behind it. Left
   * in place, `blockedByTags` would refuse every later roll.
   */
  private clearStaleDodgingTag(): void {
    if (this.getIsRolling()) {
      return;
    }
    const gas = this.gas();
    const stacks = gas?.getTagStackCount(DODGING_TAG) ?? 0;
    if (gas != null && stacks > 0) {
      gas.removeLooseTag(DODGING_TAG, stacks);
    }
  }

  private bindInput(): void {
    if (this.inputSub != null || this.dodgeRollInputConfig == null) {
      return;
    }
    this.inputSub = PlayerInputService.get().subscribePlayerInputAction(
      this,
      PlayerInputAction.TertiaryRight,
      (payload: PlayerInputActionCallbackPayload) => {
        if (payload.inputState === PlayerInputState.Pressed) {
          this.onDodgePressed();
        }
      },
      this.dodgeRollInputConfig,
    );
  }

  public onDodgePressed(): void {
    this.activate();
  }

  private unbindInput(): void {
    this.inputSub?.disconnect();
    this.inputSub = null;
  }

  private resolveReferences(): void {
    if (this.referencesResolved) {
      return;
    }
    this.referencesResolved = true;
    this.transform = this.entity.getComponent(TransformComponent);
    this.movement = this.entity.getComponent(MovementAbility);
    const controllerHosts = this.entity.getChildrenWithComponent(
      CharacterControllerBase,
      true,
    );
    this.controller =
      this.entity.getComponent(CharacterControllerBase) ??
      (controllerHosts.length > 0
        ? controllerHosts[0].getComponent(CharacterControllerBase)
        : null);
    if (!this.controller) {
      console.warn(
        `[DodgeRollAbility] no CharacterControllerBase under ${this.entity.toString()}; the roll will play in place`,
      );
    }
  }

  private gas(): GASComponent | null {
    return this.entity.getComponent(GASComponent);
  }

  /**
   * Granted when a roll starts rather than at start: GASComponent rebuilds its ability manager
   * when the entity starts, which would drop an earlier grant. Built fresh at each grant, so a
   * re-grant reads the current timings.
   */
  private grantDodge(gas: GASComponent): void {
    if (gas.isAbilityGranted(DodgeRollAbility.abilityId)) {
      return;
    }
    gas.grantAbility(
      new GASAbilityData({
        abilityId: DodgeRollAbility.abilityId,
        cooldown: this.cooldownSec,
        blockedByTags: [...blockingTags],
        tagsAppliedToOwner: [DODGING_TAG],
      }),
      DodgeRollGASAbility,
    );
  }

  /** Whether a roll could start now. Side-effect free: it never grants the ability. */
  public canDodge(): boolean {
    const gas = this.gas();
    if (gas == null || this.getIsRolling()) {
      return false;
    }
    if (gas.isAbilityGranted(DodgeRollAbility.abilityId)) {
      return gas.canActivateAbility(DodgeRollAbility.abilityId);
    }
    return !gas.hasAnyTag(blockingTags);
  }

  /**
   * Whether `activate(direction)` would start a roll: `canDodge()`, and a direction (or facing)
   * with a horizontal component to roll along.
   */
  public canRollAlong(direction?: Vec3): boolean {
    return this.canDodge() && this.horizontalRollDirection(direction) != null;
  }

  /** `direction`, or the facing when omitted, flattened and normalised; null if near-vertical. */
  private horizontalRollDirection(direction?: Vec3): Vec3 | null {
    if (!this.transform) {
      return null;
    }
    const source =
      direction ?? this.transform.worldRotation.mulVec3(Vec3.forward);
    const flat = new Vec3(source.x, 0, source.z);
    return flat.magnitudeSquared() < 0.0001 ? null : flat.normalize();
  }

  /**
   * Start a roll along `direction` (flattened), or along the facing when omitted. Returns
   * whether it started: GAS refuses a dead, staggered or rolling body and one in cooldown, and
   * a direction with no horizontal component or a body this endpoint does not own is refused
   * here.
   */
  public activate(direction?: Vec3): boolean {
    // Only the owner ticks the roll; elsewhere it would never end and keep movement blocked.
    if (!this.entity.isOwned()) {
      return false;
    }
    const gas = this.gas();
    if (gas == null) {
      return false;
    }
    const rollDirection = this.horizontalRollDirection(direction);
    if (rollDirection == null) {
      return false;
    }
    this.grantDodge(gas);
    const request: DodgeRollRequest = {
      direction: rollDirection,
      controller: this.controller,
      movement: this.movement,
      distance: this.distance,
      durationSec: this.rollDodgeDuration,
      moveStartPhase: this.moveStartPhase,
      moveEndPhase: this.moveEndPhase,
    };
    if (!gas.tryActivateAbility(DodgeRollAbility.abilityId, request)) {
      return false;
    }
    this.liveRoll = gas.getAbility(
      DodgeRollAbility.abilityId,
    ) as DodgeRollGASAbility;
    return true;
  }

  public getIsRolling(): boolean {
    return this.liveRoll?.isActive ?? false;
  }

  /** True once the stick may drive the body again: idle, or in the roll's blend-out. */
  public hasReleasedMovement(): boolean {
    return !this.getIsRolling() || (this.liveRoll?.movementReleased ?? true);
  }

  /** Stop a roll early (lost ownership, teardown). No-op when idle. */
  public cancel(): void {
    if (this.getIsRolling()) {
      this.gas()?.endAbility(DodgeRollAbility.abilityId);
    }
  }

  /**
   * GASComponent rebuilds its ability manager when the entity starts again, dropping a roll in
   * progress without ending it. Without this the stick would stay blocked.
   */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  private releaseDroppedRoll(): void {
    const roll = this.liveRoll;
    if (roll == null || !roll.isActive) {
      return;
    }
    if (this.gas()?.getAbility(DodgeRollAbility.abilityId) !== roll) {
      roll.abandon();
    }
  }
}
