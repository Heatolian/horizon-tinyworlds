/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v8

import type {MeshComponent} from 'meta/worlds';

/** Reversible hide for a local-only body mesh; never writes replicated visibility. */
export class FirstPersonBodyVisibility {
  private mesh: MeshComponent | null = null;
  private readonly previousVisibility = new Map<MeshComponent, boolean>();

  public hide(mesh: MeshComponent | null): boolean {
    if (mesh !== this.mesh) {
      this.restore();
    }
    this.retryRestores();
    if (!mesh || mesh.entity.isDestroyed() || mesh.entity.networked || !mesh.entity.isOwned()) {
      return false;
    }
    if (this.mesh === mesh) {
      return true;
    }

    this.previousVisibility.set(mesh, mesh.isVisibleSelf);
    this.mesh = mesh;
    if (mesh.isVisibleSelf) {
      mesh.isVisibleSelf = false;
    }
    return true;
  }

  public restore(): void {
    this.mesh = null;
    this.retryRestores();
  }

  public retryRestores(): void {
    for (const [mesh, wasVisible] of this.previousVisibility) {
      if (mesh === this.mesh) {
        continue;
      }
      if (mesh.entity.isDestroyed()) {
        this.previousVisibility.delete(mesh);
        continue;
      }
      if (mesh.entity.networked || !mesh.entity.isOwned()) {
        continue;
      }
      if (mesh.isVisibleSelf !== wasVisible) {
        mesh.isVisibleSelf = wasVisible;
      }
      this.previousVisibility.delete(mesh);
    }
  }
}
