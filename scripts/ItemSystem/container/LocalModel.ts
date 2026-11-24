/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import {
  NetworkMode,
  Quaternion,
  TransformComponent,
  Vec3,
  WorldService,
  type Entity,
  type TemplateAsset,
} from 'meta/worlds';

/**
 * One non-networked model under a parent, spawned on the machine that asks
 * for it. Handles the async spawn race: a model that arrives after it was
 * replaced or disposed is destroyed instead of shown. An `AnchorPoint` child
 * on the template is aligned onto the parent.
 */
export class LocalModel {
  private template: TemplateAsset | null = null;
  private parent: Entity | null = null;
  private entity: Entity | null = null;
  private generation = 0;

  get current(): Entity | null {
    return this.entity;
  }

  /** Shows `template` under `parent`; null hides. The same template and parent again is a no-op. */
  show(template: TemplateAsset | null, parent: Entity): void {
    if (template === this.template && parent === this.parent) {
      return;
    }
    this.clear();
    this.template = template;
    this.parent = parent;
    if (template == null) {
      return;
    }
    const generation = this.generation;
    WorldService.get()
      .spawnTemplate({templateAsset: template, networkMode: NetworkMode.LocalOnly, parent, position: null, rotation: null, scale: null})
      .then(entity => {
        if (generation !== this.generation || !parent.valid) {
          destroyLocal(entity);
          return;
        }
        alignGrip(entity);
        this.entity = entity;
      })
      .catch((error: unknown) => {
        console.error(`[LocalModel] failed to spawn a model under '${String(parent.name)}'.`, error);
      });
  }

  dispose(): void {
    this.clear();
    this.template = null;
    this.parent = null;
  }

  private clear(): void {
    this.generation++;
    destroyLocal(this.entity);
    this.entity = null;
  }
}

function destroyLocal(entity: Entity | null): void {
  if (entity != null && entity.valid && !entity.isDestroyed()) {
    entity.destroy();
  }
}

/** Puts the template's `AnchorPoint` child on the parent, matching how held objects align. */
function alignGrip(entity: Entity): void {
  const transform = entity.getComponent(TransformComponent);
  if (transform == null) {
    return;
  }
  const grip = entity.findChildrenWithName('AnchorPoint', false)[0]?.getComponent(TransformComponent) ?? null;
  if (grip != null) {
    const rotation = grip.localRotation.inverse();
    transform.localRotation = rotation;
    transform.localPosition = rotation.mulVec3(grip.localPosition.componentMul(transform.localScale)).mul(-1);
  } else {
    transform.localRotation = Quaternion.identity;
    transform.localPosition = Vec3.zero;
  }
}
