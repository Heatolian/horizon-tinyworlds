/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Navigation Scripts v2

import {
  EntityService,
  NavMeshComponent,
  TransformComponent,
  WorldService,
  type Entity,
  type NavMeshBounds,
  type Vec3,
} from 'meta/worlds';
import {findNavMesh} from './FindNavMesh';
import {getNpcSize, type NpcSize} from './NpcSize';

/**
 * Seconds a cached answer is trusted before it is checked again: the actor's
 * size, the NavMesh `resolveFor()` picked, and every kind of miss.
 */
const RECHECK_SECONDS = 1.0;

interface FoundNavMesh {
  entity: Entity;
  component: NavMeshComponent;
}

interface Miss {
  size: NpcSize;
  // findNavMesh's answer depends only on the sizes and on which boxes hold the
  // agent, so the miss holds while the agent is inside exactly the same boxes.
  bounds: (NavMeshBounds | null)[];
  inside: boolean[];
  until: number;
}

export interface NavMeshLookupOptions {
  /** Prefix for the warnings this lookup emits. */
  owner?: string;
  /** Monotonic clock in seconds that paces the cache. Defaults to world time. */
  now?: () => number;
}

/**
 * Finds the NavMeshComponent to use and remembers it. Use one lookup per actor.
 *
 * - `resolveFor(actor)` picks the NavMesh that matches the NPC's size (see
 *   `getNpcSize`) and covers its position (see `findNavMesh`). When none
 *   does, it falls back to the world's only enabled NavMesh with a warning,
 *   and returns null when there are several. With an unknown size it uses the
 *   world's only enabled NavMesh, and returns null when there are several.
 *   It never throws: when a NavMesh cannot be read, `findNavMesh` fails for
 *   all of them, so nothing is picked until the next check; when the actor's
 *   size or position cannot be read, its size is taken as unknown. On a
 *   runtime whose `NavMeshComponent` lacks `getAgentSize()` /
 *   `getWorldBounds()`, it serves `resolveAny()`'s pick instead.
 * - `resolveAny()` is for callers without an actor: it returns the first
 *   NavMesh, warning once when there are several.
 *
 * "Enabled" means `isEnabled()`, enabled along the whole hierarchy: the
 * `includeDisabled: false` search `findNavMesh` uses skips an entity under a
 * disabled ancestor even when its own `enabledSelf` is true. Each answer is
 * cached for `RECHECK_SECONDS`, so behaviors can call this many times per
 * frame: the actor's size, the pick and its bounds are re-read once per
 * window, and a pick is dropped at once when its entity is disabled or the
 * actor leaves its bounds. A miss holds while the actor keeps its size and
 * stays inside the same NavMesh boxes.
 */
export class NavMeshLookup {
  private cachedEntity: Entity | null = null;
  // The size the cached NavMesh was picked for; null when picked without one.
  private cachedForSize: NpcSize | null = null;
  // Null for the only NavMesh used although it does not fit: it serves every position.
  private cachedBounds: NavMeshBounds | null = null;
  private recheckAt: number = -Infinity;
  private missUntil: number = -Infinity;
  private searchPausedUntil: number = -Infinity;
  // Until then the size API is taken as missing and resolveFor() serves resolveAny()'s pick.
  private sizeApiMissingUntil: number = -Infinity;
  private lastMiss: Miss | null = null;
  private actor: Entity | null = null;
  private actorSize: NpcSize | null = null;
  private actorSizeReadAt: number = -Infinity;
  // Re-warns when the agent or NavMesh sizes change, e.g. once NavMesh assets load after a miss.
  private lastNoFitWarning: string | null = null;
  private lastUnreadableWarning: string | null = null;
  private lastActorUnreadableWarning: string | null = null;
  private warnedSizeApiMissing: boolean = false;
  private warnedMultiple: boolean = false;
  private noNavMeshInWorld: boolean = false;
  private readonly owner: string;
  private readonly now: () => number;

  constructor(options: NavMeshLookupOptions = {}) {
    this.owner = options.owner ?? 'NavMeshLookup';
    this.now = options.now ?? ((): number => WorldService.get().getWorldTime());
  }

  /**
   * Whether the last null from `resolveFor()` meant the world has no enabled
   * NavMesh, as opposed to NavMeshes that do not fit or could not be read.
   * It reflects the most recent world search; a null served from a cached
   * miss or a paused search reuses it, so it is at most `RECHECK_SECONDS` old.
   */
  isWorldWithoutNavMesh(): boolean {
    return this.noNavMeshInWorld;
  }

  /** The NavMesh for an NPC at its current position, or null. */
  resolveFor(actor: Entity | null): NavMeshComponent | null {
    const now = this.now();
    if (actor == null) {
      return this.resolveSole(now);
    }
    if (now < this.sizeApiMissingUntil) {
      return this.resolveWithoutSizeApi();
    }
    const size = this.sizeOf(actor, now);
    const position = this.positionOf(actor);
    if (size == null || position == null) {
      return this.resolveSole(now);
    }
    const cached = this.cachedComponent();
    if (
      cached != null &&
      this.cachedForSize != null &&
      sameSize(this.cachedForSize, size) &&
      now < this.recheckAt &&
      this.cachedEntity?.isEnabled() === true &&
      (this.cachedBounds == null || contains(this.cachedBounds, position))
    ) {
      return cached;
    }
    if (now < this.searchPausedUntil || this.isKnownMiss(size, position, now)) {
      return null;
    }
    let selected: NavMeshComponent | null;
    try {
      selected = findNavMesh(size, position);
    } catch (error) {
      if (error instanceof TypeError) {
        // An older runtime without the NavMesh size getters throws "is not a function".
        this.warnSizeApiMissing(error);
        this.sizeApiMissingUntil = now + RECHECK_SECONDS;
        return this.resolveWithoutSizeApi();
      }
      this.warnUnreadable(error);
      this.forget();
      this.noNavMeshInWorld = false;
      this.searchPausedUntil = now + RECHECK_SECONDS;
      return null;
    }
    if (selected != null) {
      this.noNavMeshInWorld = false;
      const bounds = this.readBounds(selected);
      if (bounds != null) {
        this.cacheFor(selected.entity, size, bounds, now);
      } else {
        this.forget();
      }
      return selected;
    }
    const all = this.findAll(false);
    this.noNavMeshInWorld = all.length === 0;
    if (all.length === 0) {
      this.forget();
      this.searchPausedUntil = now + RECHECK_SECONDS;
      return null;
    }
    this.warnNoFit(size, all);
    if (all.length === 1) {
      this.cacheFor(all[0].entity, size, null, now);
      return all[0].component;
    }
    this.forget();
    const bounds = all.map(({component}) => this.readBounds(component));
    this.lastMiss = {
      size,
      bounds,
      inside: bounds.map(box => box != null && contains(box, position)),
      until: now + RECHECK_SECONDS,
    };
    return null;
  }

  /** The first NavMesh in the world, for callers without an actor. */
  resolveAny(): NavMeshComponent | null {
    const cached = this.cachedComponent();
    if (cached != null) {
      return cached;
    }
    const now = this.now();
    if (now < this.missUntil) {
      return null;
    }
    const found = this.findAll(true);
    if (found.length > 1 && !this.warnedMultiple) {
      this.warnedMultiple = true;
      console.warn(
        `[${this.owner}] ${found.length} NavMesh entities found; using the first. ` +
          'Pass the actor to resolveFor() to pick the right one.',
      );
    }
    return this.remember(found[0] ?? null, now);
  }

  // Sizing scans the actor's hierarchy and NPC sizes rarely change, so it is
  // re-read once per window; a size that cannot be read is cached as unknown.
  private sizeOf(actor: Entity, now: number): NpcSize | null {
    if (actor !== this.actor || now >= this.actorSizeReadAt + RECHECK_SECONDS) {
      this.actor = actor;
      this.actorSizeReadAt = now;
      try {
        this.actorSize = getNpcSize(actor);
      } catch (error) {
        this.warnActorUnreadable(error);
        this.actorSize = null;
      }
    }
    return this.actorSize;
  }

  private positionOf(actor: Entity): Vec3 | null {
    try {
      return actor.getComponent(TransformComponent)?.worldPosition ?? null;
    } catch (error) {
      this.warnActorUnreadable(error);
      return null;
    }
  }

  // The pre-size-API behavior: the first NavMesh in the world.
  private resolveWithoutSizeApi(): NavMeshComponent | null {
    const found = this.resolveAny();
    this.noNavMeshInWorld = found == null;
    return found;
  }

  private resolveSole(now: number): NavMeshComponent | null {
    const cached = this.cachedComponent();
    if (
      cached != null &&
      this.cachedForSize == null &&
      now < this.recheckAt &&
      this.cachedEntity?.isEnabled() === true
    ) {
      return cached;
    }
    if (now < this.missUntil) {
      return null;
    }
    const found = this.findAll(false);
    this.noNavMeshInWorld = found.length === 0;
    if (found.length > 1) {
      if (!this.warnedMultiple) {
        this.warnedMultiple = true;
        console.warn(
          `[${this.owner}] ${found.length} NavMesh entities found but the agent size is unknown; ` +
            'not picking one.',
        );
      }
      this.forget();
      this.missUntil = now + RECHECK_SECONDS;
      return null;
    }
    return this.remember(found[0] ?? null, now);
  }

  private isKnownMiss(size: NpcSize, position: Vec3, now: number): boolean {
    const miss = this.lastMiss;
    return (
      miss != null &&
      now < miss.until &&
      sameSize(miss.size, size) &&
      miss.bounds.every((box, i) => (box != null && contains(box, position)) === miss.inside[i])
    );
  }

  private readBounds(navMesh: NavMeshComponent): NavMeshBounds | null {
    try {
      return navMesh.getWorldBounds();
    } catch (error) {
      this.warnUnreadable(error);
      return null;
    }
  }

  private warnUnreadable(error: unknown): void {
    const message = String(error);
    if (message === this.lastUnreadableWarning) {
      return;
    }
    this.lastUnreadableWarning = message;
    console.warn(
      `[${this.owner}] A NavMesh's agent size or bounds could not be read (${message}); ` +
        `no NavMesh is picked for this agent until the next check in ${RECHECK_SECONDS}s.`,
    );
  }

  private warnActorUnreadable(error: unknown): void {
    const message = String(error);
    if (message === this.lastActorUnreadableWarning) {
      return;
    }
    this.lastActorUnreadableWarning = message;
    console.warn(
      `[${this.owner}] The agent's size or position could not be read (${message}); ` +
        'treating its size as unknown.',
    );
  }

  private warnSizeApiMissing(error: TypeError): void {
    if (this.warnedSizeApiMissing) {
      return;
    }
    this.warnedSizeApiMissing = true;
    console.warn(
      `[${this.owner}] NavMeshComponent.getAgentSize()/getWorldBounds() are unavailable on this runtime ` +
        `(${String(error)}); using the first NavMesh in the world instead of picking one per agent size.`,
    );
  }

  private warnNoFit(size: NpcSize, all: FoundNavMesh[]): void {
    const sizes = all.map(({component}) => describeAgentSize(component)).join(', ');
    const signature = `${size.radius}/${size.height}|${sizes}`;
    if (signature === this.lastNoFitWarning) {
      return;
    }
    this.lastNoFitWarning = signature;
    const rule =
      'A NavMesh fits when both its agent radius and height are at least the agent\'s, ' +
      'and its bounds contain the agent.';
    if (all.length === 1) {
      console.warn(
        `[${this.owner}] The world's only NavMesh (agent radius/height ${sizes}) does not fit an ` +
          `agent of radius ${size.radius} and height ${size.height} at its position. ${rule} ` +
          'Using it anyway, so the agent may clip walls or ceilings; bake a NavMesh for this size.',
      );
      return;
    }
    console.warn(
      `[${this.owner}] No NavMesh fits an agent of radius ${size.radius} and height ` +
        `${size.height} at its position. ${rule} Available NavMeshes (agent radius/height): ` +
        `${sizes}. Navigation falls back to the caller's no-navmesh path.`,
    );
  }

  private cachedComponent(): NavMeshComponent | null {
    const cached = this.cachedEntity;
    if (cached == null) {
      return null;
    }
    const component = cached.valid ? cached.getComponent(NavMeshComponent) : null;
    if (component == null) {
      this.forget();
    }
    return component;
  }

  private cacheFor(entity: Entity, size: NpcSize, bounds: NavMeshBounds | null, now: number): void {
    this.cachedEntity = entity;
    this.cachedForSize = size;
    this.cachedBounds = bounds;
    this.recheckAt = now + RECHECK_SECONDS;
    this.lastMiss = null;
    this.searchPausedUntil = -Infinity;
  }

  private remember(found: FoundNavMesh | null, now: number): NavMeshComponent | null {
    if (found == null) {
      this.forget();
      this.missUntil = now + RECHECK_SECONDS;
      return null;
    }
    this.cachedEntity = found.entity;
    this.cachedForSize = null;
    this.cachedBounds = null;
    this.recheckAt = now + RECHECK_SECONDS;
    this.missUntil = -Infinity;
    return found.component;
  }

  private forget(): void {
    this.cachedEntity = null;
    this.cachedForSize = null;
    this.cachedBounds = null;
  }

  private findAll(includeDisabled: boolean): FoundNavMesh[] {
    const found: FoundNavMesh[] = [];
    const entities = includeDisabled
      ? EntityService.findEntitiesWithComponent(NavMeshComponent)
      : EntityService.findEntitiesWithComponent(NavMeshComponent, {includeDisabled: false});
    for (const entity of entities) {
      const component = entity.getComponent(NavMeshComponent);
      if (component != null) {
        found.push({entity, component});
      }
    }
    return found;
  }
}

function sameSize(a: NpcSize, b: NpcSize): boolean {
  return a.radius === b.radius && a.height === b.height;
}

function describeAgentSize(navMesh: NavMeshComponent): string {
  try {
    const {radius, height} = navMesh.getAgentSize();
    return `${radius}/${height}`;
  } catch {
    return 'unreadable';
  }
}

function contains(bounds: NavMeshBounds, position: Vec3): boolean {
  const {min, max} = bounds;
  return (
    position.x >= min.x &&
    position.x <= max.x &&
    position.y >= min.y &&
    position.y <= max.y &&
    position.z >= min.z &&
    position.z <= max.z
  );
}
