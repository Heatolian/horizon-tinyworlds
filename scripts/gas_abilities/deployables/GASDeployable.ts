/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Ability Scripts v12

import {
  Component,
  component,
  editor,
  property,
  subscribe,
  MeshComponent,
  OnCollisionEnterEvent,
  OnCollisionEnterEventPayload,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  PhysicsBodyComponent,
  TransformComponent,
  Vec3,
  type Entity,
} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';
import {GameplayCueContext} from '../../gas/cues/GameplayCueContext';
import {GameplayCuePresentation} from '../../gas/cues/GameplayCuePresentation';

/**
 * The cue a deployable going off raises, with the deployable as its source
 * object: bind it in the deployable's own `GameplayCuePresentation` (e.g. to a
 * `Detonation` child's VFX and an explosion sound).
 */
export const DETONATE_CUE_TAG = 'cue.deployable.detonate';

/** What a deployable does when its fuse burns out or it lands. */
export interface DeployableConfig {
  /**
   * Seconds before it resolves in place. 0 disables the fuse, leaving
   * `resolveOnImpact` — or a script calling {@link GASDeployable.resolve} — as
   * the trigger.
   */
  fuseSeconds: number;

  /** Resolve on the first collision instead of bouncing and staying live. */
  resolveOnImpact: boolean;

  /** Seconds between resolving and despawning, to let a cue play out. */
  despawnDelaySeconds: number;

  /**
   * Invoked once, on the owner, with where it went off, what it struck — null
   * when the fuse resolved it in mid-air — and the deployable itself, which a
   * blast needs so its own collider is not mistaken for cover.
   *
   * Everything a deployable DOES lives here; this component only decides WHEN.
   */
  onResolve(at: Vec3, hit: Entity | null, self: Entity): void;

  /**
   * The thrower. Never counts as an impact, so it cannot detonate on its own
   * feet, and its GAS shows the detonation on every machine.
   */
  instigator?: Entity;
}

/**
 * Something you deploy — thrown, placed or stuck — that resolves once, on a
 * fuse, on impact, or both.
 *
 * Deliberately does NOT move anything. The entity is expected to carry a
 * DynamicCollider PhysicsBody, so the engine integrates gravity, bounce and
 * rolling; the thrower supplies an initial `linearVelocity` and this component
 * only watches for the moment to go off.
 *
 * That is the whole difference from GASProjectile, which steps a transform by
 * hand every frame and dies on its first hit. A bullet wants a straight line and
 * one target; a grenade wants physics and a fuse. Sharing one component would
 * mean one of them faking the other's model.
 *
 * "When it ends" and "what happens when it ends" are separate on purpose: the
 * same fuse serves a blast, a healing pulse, or a lingering area, and each is
 * just a different `onResolve`.
 *
 * Going off is shown on every machine the way a gun's shot is: the owner
 * raises `DETONATE_CUE_TAG` on the instigator's GAS, which broadcasts it to
 * every machine with this deployable as the source object, and each plays the
 * deployable's own `GameplayCuePresentation` bindings for it. The owner also
 * hides the spent body and takes it out of physics; those properties are
 * networked, so the other machines follow. Keep `despawnDelaySeconds` long
 * enough for the presentation to play out.
 */
@component({
  description: 'A deployable that resolves once, on a fuse or on impact. Motion is left to physics.',
})
export class GASDeployable extends Component {
  @editor({
    description:
      'Linear damping from its first contact on, so it skids to a stop where it lands instead of rolling away. 0 keeps the body\'s own.',
  })
  @property({isNetworked: false})
  public landedDamping: number = 0;

  private config: DeployableConfig | null = null;
  private ageSec: number = 0;
  private despawnAtSec: number | null = null;
  private landed: boolean = false;
  /** Set the instant a trigger lands, so a collision inside `onResolve` cannot set it off again. */
  private fired: boolean = false;

  /** Called by whatever deployed it, right after spawning and before the fuse can run. */
  public configure(config: DeployableConfig): void {
    this.config = config;
    // Legal — a remote charge or a mine waits to be told — but only script can
    // set it off, and a designer who expected a timer gets silence otherwise.
    if (config.fuseSeconds <= 0 && !config.resolveOnImpact) {
      console.warn(
        '[Deployable] has neither a fuse nor an impact trigger, so nothing will ' +
          'set it off unless game code calls resolve().',
      );
    }
  }

  /** True once it has gone off, on the owner; a second trigger is ignored. */
  public get hasResolved(): boolean {
    return this.fired;
  }

  /**
   * Shows it going off on every machine: the instigator's GAS broadcasts the
   * cue, and each machine plays this deployable's presentation for it. With no
   * instigator GAS (a charge placed by script) there is nothing to broadcast
   * through, so only this machine shows it.
   */
  private showDetonation(at: Vec3): void {
    const gas = this.config?.instigator?.getComponent(GASComponent) ?? null;
    const ctx = new GameplayCueContext({source: gas, sourceObject: this.entity, location: at});
    if (gas != null) {
      gas.executeCue(DETONATE_CUE_TAG, ctx);
    } else {
      this.entity.getComponent(GameplayCuePresentation)?.handleCue(DETONATE_CUE_TAG, ctx);
    }
  }

  /**
   * Hides the spent body and takes it out of physics without leaving yet, so the
   * detonation has time to play over the spot and the next blast does not shove
   * it around. Owner only, like every write to these networked properties.
   */
  private retire(): void {
    for (const mesh of this.meshesOf(this.entity)) {
      mesh.isVisibleSelf = false;
    }
    const body = this.entity.getComponent(PhysicsBodyComponent);
    if (body) {
      body.linearVelocity = Vec3.zero;
      body.angularVelocity = Vec3.zero;
      body.collisionEnabled = false;
    }
  }

  /** Templates nest the mesh under the root as often as not. */
  private meshesOf(root: Entity): MeshComponent[] {
    const meshes: MeshComponent[] = [];
    const onRoot = root.getComponent(MeshComponent);
    if (onRoot) {
      meshes.push(onRoot);
    }
    for (const child of root.getChildrenWithComponent(MeshComponent, true)) {
      const mesh = child.getComponent(MeshComponent);
      if (mesh) {
        meshes.push(mesh);
      }
    }
    return meshes;
  }

  /**
   * Resolve now, whatever the fuse says. Public so game code can cook a grenade
   * early, and so the impact and fuse paths share one entry. Owner only.
   */
  public resolve(hit: Entity | null): void {
    const config = this.config;
    if (this.fired || !config || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.fired = true;

    const at = this.entity.getComponent(TransformComponent)?.worldPosition ?? Vec3.zero;
    config.onResolve(at, hit, this.entity);

    // After the payload, which reads the world and this transform, not a
    // half-dismantled body.
    this.showDetonation(at);
    this.retire();

    if (config.despawnDelaySeconds > 0) {
      this.despawnAtSec = this.ageSec + config.despawnDelaySeconds;
    } else {
      this.entity.destroy();
    }
  }

  /**
   * Owner-only: physics already moves the entity on every machine that needs it,
   * and resolving on a proxy would apply the payload once per client.
   */
  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(payload: OnWorldUpdateEventPayload): void {
    const config = this.config;
    if (!config || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.ageSec += payload.deltaTime;

    if (this.despawnAtSec !== null) {
      if (this.ageSec >= this.despawnAtSec) {
        this.entity.destroy();
      }
      return;
    }
    if (config.fuseSeconds > 0 && this.ageSec >= config.fuseSeconds) {
      this.resolve(null);
    }
  }

  @subscribe(OnCollisionEnterEvent)
  onCollisionEnter(payload: OnCollisionEnterEventPayload): void {
    const config = this.config;
    if (!config || this.hasResolved || !this.entity.isOwned()) {
      return;
    }
    const other = payload.getOtherEntity(this.entity);
    if (!other || (config.instigator && other === config.instigator)) {
      return;
    }
    if (!this.landed && this.landedDamping > 0) {
      this.landed = true;
      const body = this.entity.getComponent(PhysicsBodyComponent);
      if (body) {
        body.linearDamping = this.landedDamping;
      }
    }
    if (config.resolveOnImpact) {
      this.resolve(other);
    }
  }
}
