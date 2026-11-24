/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v25

// scripts/Interaction/InteractionControlsBridge.ts -- project glue between the
// touch controls and InteractionController. Attach to the SAME interactor child
// that carries InteractionController.
// Bridges the on-screen 'Interact' action + HUD button to the controller, and
// installs a candidate selector so that, with several interactables in reach,
// the one nearest the centre of the camera's view is selected
// (`selectByCameraFacing`), or with `selectAlongHeading` the first one along the
// camera's heading from the player (both rankings in FacingSelection.ts).
import {
  Component,
  component,
  subscribe,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
  CandidateSelectionService,
  CapsuleAxis,
  ColliderBoxComponent,
  ColliderCapsuleComponent,
  ColliderSphereComponent,
  InteractorComponent,
  property,
  TransformComponent,
} from 'meta/worlds';
import type {
  CandidateSelectorContext,
  CandidateSelectorFn,
  Entity,
  EventSubscription,
  Maybe,
  OnWorldUpdateEventPayload,
} from 'meta/worlds';
import {CameraManager} from '../Camera/CameraManager';
import {isPlayerAimedMode} from '../Camera/CameraModeTypes';
import {rankAlongHeading, rankByFacing, type FacingCandidate, type HeadingCandidate} from './FacingSelection';

import {
  InputActionsManager,
  InputActionChangeEvent,
} from '../Input/InputActionsManager';
import {TouchControlsHud} from '../Input/TouchControlsHud';
import {TouchTapTarget} from '../Input/TouchTapTarget';
import {
  InteractionController,
  OnInteractCandidateEnterEvent,
  OnInteractCandidateExitEvent,
} from './InteractionController';

// Seconds between attempts to install the selector while the interactor is not
// yet registered with the selection service (each failed attempt logs a warning).
const SELECTOR_RETRY_SECONDS = 1;

/**
 * How far a sensor reaches from its centre across the ground, taking it as
 * upright: a sphere's radius times its largest scale axis (as the physics
 * engine sizes a scaled sphere), half a box's horizontal diagonal, a capsule's
 * radius plus half its length when it lies down. Any other shape counts as a
 * point.
 */
function sensorReach(entity: Entity, transform: TransformComponent): number {
  const scale = transform.worldScale;
  const sphere = entity.getComponent(ColliderSphereComponent);
  if (sphere != null) {
    return sphere.radius * Math.max(scale.x, scale.y, scale.z);
  }
  const box = entity.getComponent(ColliderBoxComponent);
  if (box != null) {
    return Math.hypot(box.halfExtents.x * scale.x, box.halfExtents.z * scale.z);
  }
  const capsule = entity.getComponent(ColliderCapsuleComponent);
  if (capsule != null) {
    const lying = capsule.axis === CapsuleAxis.X ? scale.x : capsule.axis === CapsuleAxis.Z ? scale.z : 0;
    return capsule.radius * Math.max(scale.x, scale.z) + (capsule.length / 2) * lying;
  }
  return 0;
}

@component({
  description:
    'Bridges the Interact action + HUD button to InteractionController, and selects the interactable the camera faces.',
})
export class InteractionControlsBridge extends Component {
  /**
   * With several interactables in reach, select the one the camera faces, in the
   * camera modes the player aims (ThirdPerson, FirstPerson, Follow, AutoFollow,
   * Orbit, Chase). Off, and in the fixed-angle modes (TopDown, Isometric,
   * SideScroll, Static), the closest one wins. Applied live, including when
   * `CameraManager.cameraMode` changes.
   *
   * Works by setting `InteractorComponent.cameraEntity` to the scene's
   * `CameraManager` camera and installing a candidate selector
   * (`CandidateSelectionService.setCandidateSelector`) with the native
   * screen-mode ranking (see FacingSelection.ts for why the SDK's own camera
   * ranking cannot switch between nearby objects with an orbit camera). If a
   * world drives its own camera instead of `CameraManager`, sets `cameraEntity`
   * itself, or installs its own candidate selector, set this to false: the
   * bridge would otherwise replace them whenever the camera mode changes. With
   * no `CameraManager` in the scene the closest one wins.
   */
  @property()
  selectByCameraFacing: boolean = true;

  /**
   * With `selectByCameraFacing`, judge from the player instead of the camera:
   * select the first interactable whose sensor the line from the player along
   * the camera's heading passes through, else the one nearest that line
   * (`rankAlongHeading`). Off: the one nearest the centre of the camera's view.
   * Suits a third-person camera behind the player: seen from there, of two
   * objects in line ahead of the player the farther one is nearer the centre
   * of the view, so the one at the player's feet is hard to select.
   */
  @property()
  selectAlongHeading: boolean = false;

  private subscription: Maybe<EventSubscription> = null;
  private manager: Maybe<InputActionsManager> = null;
  private hud: Maybe<TouchControlsHud> = null;
  private shownCandidate: Maybe<boolean> = null;
  private candidateActive: boolean = false;
  // Tap-to-world wiring: routes taps through the shared TouchTapTarget layer when
  // it is installed, so layering (a HUD button consuming a tap) also gates pickup.
  private tapSub: Maybe<EventSubscription> = null;
  // The TouchTapTarget instance the tap path is currently wired to (null when the
  // raw fallback owns taps). Reconciled each frame so a destroyed-and-recreated
  // singleton is re-subscribed instead of silently dropping tap-to-interact.
  private tapTargetInstance: Maybe<TouchTapTarget> = null;
  // Whether the author's enableTapToInteract has been captured yet (captured once,
  // before we ever take the path over).
  private tapCaptured: boolean = false;
  // The controller's enableTapToInteract as the author set it, captured at wire
  // time so teardown restores THAT value instead of forcing it true (which would
  // silently enable tap-to-interact on a world that deliberately disabled it).
  private priorEnableTap: boolean = true;
  // The camera entity last written to the interactor (null = distance ranking),
  // so the per-frame sync writes only on a change.
  private appliedCamera: Maybe<Entity> = null;
  private cameraApplied: boolean = false;
  private selectorRetryIn: number = 0;
  private readonly facingSelector: CandidateSelectorFn = (ctx: CandidateSelectorContext) =>
    this.rankCandidates(ctx);

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.wire();
    this.reconcileTapWiring();
    this.syncHud();
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(payload?: OnWorldUpdateEventPayload): void {
    this.wire();
    this.reconcileTapWiring();
    this.syncHud();
    this.syncCameraRanking(payload?.deltaTime ?? 0);
  }

  private wire(): void {
    const manager = InputActionsManager.instance;
    if (manager === this.manager) {
      return;
    }
    this.subscription?.disconnect();
    this.subscription = null;
    this.manager = manager;
    if (manager == null) {
      return;
    }
    this.subscription = manager.subscribeAction(
      'Interact',
      (event: InputActionChangeEvent) => {
        if (event.newValue as boolean) {
          this.entity.getComponent(InteractionController)?.activate();
        }
      },
    );
  }

  // Keep the tap path reconciled to the CURRENT TouchTapTarget singleton. Called
  // every frame: wires the shared layer when the target is present, restores the
  // controller's raw touch-down fallback when it is absent, and re-subscribes when
  // the target is destroyed and a new instance replaces it (a one-shot wire would
  // leave taps dead after a singleton swap). Respects the author's tap switch: if
  // taps were disabled, it never touches either path.
  private reconcileTapWiring(): void {
    const controller = this.entity.getComponent(InteractionController);
    if (controller == null) {
      return;
    }
    // Capture the author's tap switch ONCE, before we ever take the path over, so
    // a later restore uses the authored value rather than one we forced.
    if (!this.tapCaptured) {
      this.priorEnableTap = controller.enableTapToInteract;
      this.tapCaptured = true;
    }
    if (!this.priorEnableTap) {
      return; // Author disabled tap-to-interact; leave both paths off.
    }
    const current = TouchTapTarget.instance;
    if (current === this.tapTargetInstance) {
      return; // Already reconciled to this instance (or to its absence).
    }
    // The singleton changed (installed, destroyed, or replaced): drop the stale
    // subscription and rewire to the new state.
    this.tapSub?.disconnect();
    this.tapSub = null;
    this.tapTargetInstance = current;
    if (current != null) {
      // Shared layer owns taps: suppress the raw touch-down path and drive
      // interact from the tap layer.
      controller.enableTapToInteract = false;
      this.tapSub = current.subscribeTap(e => {
        controller.interactAtHit(e.actorEntity) || controller.interactAtHit(e.shapeEntity);
      });
    } else {
      // No shared layer present: re-enable the controller's raw touch-down path as
      // the fallback (restore the author's value, which is on in this branch).
      controller.enableTapToInteract = this.priorEnableTap;
    }
  }

  // InteractorComponent.cameraEntity is per client and null by default, which ranks
  // candidates by distance only. CameraManager may start after this component and
  // its mode can change at any time, so this re-checks every frame. The selector
  // is re-installed if the service dropped it (the interactor re-registers on an
  // ownership change).
  private syncCameraRanking(deltaTime: number): void {
    const camera = CameraManager.get();
    const wanted: Maybe<Entity> =
      this.selectByCameraFacing && camera != null && isPlayerAimedMode(camera.cameraMode)
        ? camera.entity
        : null;
    const interactor = this.entity.getComponent(InteractorComponent);
    if (interactor == null) {
      return;
    }
    if (!this.cameraApplied || wanted !== this.appliedCamera) {
      interactor.cameraEntity = wanted;
      this.appliedCamera = wanted;
      this.cameraApplied = true;
    }
    const service = CandidateSelectionService.get();
    const installed = service.hasCandidateSelector(this.entity);
    if (wanted == null) {
      if (installed) {
        service.setCandidateSelector(this.entity, null);
      }
      return;
    }
    if (installed) {
      return;
    }
    this.selectorRetryIn -= deltaTime;
    if (this.selectorRetryIn > 0) {
      return;
    }
    this.selectorRetryIn = SELECTOR_RETRY_SECONDS;
    service.setCandidateSelector(this.entity, this.facingSelector);
  }

  private rankCandidates(ctx: CandidateSelectorContext): ReadonlyArray<Entity> {
    const cameraTransform = CameraManager.get()?.entity.getComponent(TransformComponent) ?? null;
    if (cameraTransform == null) {
      return [...ctx.candidates.keys()];
    }
    if (this.selectAlongHeading) {
      return rankAlongHeading(this.headingCandidates(ctx), {
        origin: ctx.interactorPosition,
        cameraForward: cameraTransform.worldForward,
      });
    }
    const items: FacingCandidate<Entity>[] = [];
    for (const entity of ctx.candidates.keys()) {
      const transform = entity.getComponent(TransformComponent);
      if (transform != null) {
        items.push({id: entity, position: transform.worldPosition});
      }
    }
    return rankByFacing(items, {
      cameraPosition: cameraTransform.worldPosition,
      cameraForward: cameraTransform.worldForward,
      origin: ctx.interactorPosition,
      current: CandidateSelectionService.get().getCurrentCandidate(ctx.interactor),
    });
  }

  /** Each candidate with the radius on the ground of its sensor (`sensorReach`). */
  private headingCandidates(ctx: CandidateSelectorContext): HeadingCandidate<Entity>[] {
    const items: HeadingCandidate<Entity>[] = [];
    for (const entity of ctx.candidates.keys()) {
      const transform = entity.getComponent(TransformComponent);
      if (transform != null) {
        items.push({id: entity, position: transform.worldPosition, radius: sensorReach(entity, transform)});
      }
    }
    return items;
  }

  @subscribe(OnInteractCandidateEnterEvent, {execution: ExecuteOn.Owner})
  onCandidateEnter(): void {
    this.candidateActive = true;
    this.syncHud();
  }

  @subscribe(OnInteractCandidateExitEvent, {execution: ExecuteOn.Owner})
  onCandidateExit(): void {
    this.candidateActive = false;
    this.syncHud();
  }

  private syncHud(): void {
    const hud = TouchControlsHud.instance;
    if (hud !== this.hud) {
      this.hud = hud;
      this.shownCandidate = null;
    }
    if (hud == null || this.shownCandidate === this.candidateActive) {
      return;
    }
    if (this.candidateActive) {
      hud.showButton('Interact');
    } else {
      hud.hideButton('Interact');
    }
    this.shownCandidate = this.candidateActive;
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  onDestroy(): void {
    this.subscription?.disconnect();
    this.subscription = null;
    this.manager = null;
    this.tapSub?.disconnect();
    this.tapSub = null;
    // Restore the tap switch to whatever the author set, but only if we captured
    // it. Forcing it true here would enable tap-to-interact on a world that
    // deliberately disabled it.
    if (this.tapCaptured) {
      const controller = this.entity.getComponent(InteractionController);
      if (controller != null) {
        controller.enableTapToInteract = this.priorEnableTap;
      }
    }
    this.tapCaptured = false;
    this.tapTargetInstance = null;
    if (this.hud != null && TouchControlsHud.instance === this.hud) {
      this.hud.hideButton('Interact');
    }
    this.hud = null;
    this.shownCandidate = null;
    this.candidateActive = false;
  }
}
