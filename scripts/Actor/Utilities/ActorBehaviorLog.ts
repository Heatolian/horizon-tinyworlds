/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v35

import { WorldService, type ActorBehavior, type Entity } from 'meta/worlds';

/** Most lines one {@link TargetLog} writes per second of world time; the rest are counted. */
export const TARGET_LINES_PER_SECOND: number = 5;

/**
 * `Name(Id: <id> NetId: <netId>)`, the label the Actor Framework's `[ActorBehavior]`
 * lines and the `[GotoTrace]` and `[CharacterHealth]` lines give an entity.
 */
export function entityLabel(entity: Entity | null | undefined): string {
  if (!entity || entity.valid === false) {
    return '<destroyed>';
  }
  return `${entity.name}${entity.toString()}`;
}

/**
 * `GotoBehavior "GoToCastle"`, or just `GotoBehavior` when the behavior has no
 * name of its own, as the Actor Framework labels a behavior.
 */
export function behaviorLabel(behavior: ActorBehavior): string {
  const className = behavior.constructor.name;
  const name = behavior.name;
  return name === '' || name === 'ActorBehavior' || name === className
    ? className
    : `${className} "${name}"`;
}

/**
 * Writes `[ActorBehavior] <actor> <behavior> <text>. worldTime=<t>`, the line
 * the Actor Framework writes for behavior changes, so eval judges read a stock
 * behavior's choices in the same view.
 */
export function logActorBehavior(behavior: ActorBehavior, text: string): void {
  const actor = behavior.behaviorManager ? entityLabel(behavior.getEntity()) : '<no actor>';
  const worldTime = WorldService.get().getWorldTime().toFixed(3);
  console.log(`[ActorBehavior] ${actor} ${behaviorLabel(behavior)} ${text}. worldTime=${worldTime}`);
}

/**
 * Writes a line when the entity a behavior is acting on changes: `is now
 * targeting Player(Id: 77 NetId: 0)`, `is now targeting nothing`. Fed the
 * current entity every frame; an unchanged entity costs one comparison.
 *
 * Capped at {@link TARGET_LINES_PER_SECOND} lines per second of world time, so a
 * target flipping between two equidistant candidates cannot flood the log; once
 * that second is over, one line says how many changes went unlogged and what
 * the behavior is acting on now.
 */
export class TargetLog {
  private logged: Entity | null = null;
  private windowStart: number = Number.NEGATIVE_INFINITY;
  private linesInWindow: number = 0;
  private suppressed: number = 0;

  /** `verb` names the relation: `targeting`, `following`, `looking at`. */
  constructor(private readonly verb: string) {}

  note(behavior: ActorBehavior, entity: Entity | null): void {
    if (entity === this.logged && this.suppressed === 0) {
      return;
    }
    const now = WorldService.get().getWorldTime();
    if (now - this.windowStart >= 1) {
      if (this.suppressed > 0) {
        logActorBehavior(
          behavior,
          `changed what it is ${this.verb} ${this.suppressed} more times, not logged; ` +
            `it is now ${this.verb} ${this.describe(entity)}`,
        );
        this.logged = entity;
      }
      this.windowStart = now;
      this.linesInWindow = 0;
      this.suppressed = 0;
    }
    if (entity === this.logged) {
      return;
    }
    this.logged = entity;
    if (this.linesInWindow >= TARGET_LINES_PER_SECOND) {
      this.suppressed++;
      return;
    }
    this.linesInWindow++;
    logActorBehavior(behavior, `is now ${this.verb} ${this.describe(entity)}`);
  }

  private describe(entity: Entity | null): string {
    return entity ? entityLabel(entity) : 'nothing';
  }
}
