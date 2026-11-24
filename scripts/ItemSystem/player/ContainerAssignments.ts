/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

/**
 * Which player owns which container entity, including the window where a
 * spawn is in flight. Generic over the key/value types so it stays pure.
 */
export class ContainerAssignments<Player, Holder> {
  private readonly pending = new Set<Player>();
  private readonly assigned = new Map<Player, Holder>();

  /** True when the caller should spawn a container entity for `player` now. */
  claim(player: Player): boolean {
    if (this.pending.has(player) || this.assigned.has(player)) {
      return false;
    }
    this.pending.add(player);
    return true;
  }

  /** Records a finished spawn. False means the player left meanwhile: destroy `holder`. */
  fulfil(player: Player, holder: Holder): boolean {
    if (!this.pending.delete(player)) {
      return false;
    }
    this.assigned.set(player, holder);
    return true;
  }

  /** Forgets a failed spawn so a later claim can retry. */
  abandon(player: Player): void {
    this.pending.delete(player);
  }

  /** The player left: returns their container entity to dispose of, if it exists yet. */
  release(player: Player): Holder | null {
    this.pending.delete(player);
    const holder = this.assigned.get(player) ?? null;
    this.assigned.delete(player);
    return holder;
  }

  holderOf(player: Player): Holder | null {
    return this.assigned.get(player) ?? null;
  }
}
