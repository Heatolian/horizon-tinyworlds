/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Game Content Scripts v7

/**
 * NuxTutorial - one show-once tutorial per player, with the 'seen' status
 * saved in one player variable (PVar). Self-contained: no PVar needs defining
 * first, because the backend creates the variable on its first write.
 *
 * A NUX (new-user experience) is a tutorial shown only until the player
 * dismisses it, and never again on later visits. This component owns the
 * seen-state and its persistence; it renders nothing itself. Game code renders
 * the tutorial panel in the `addListener` callback and calls `dismiss()` from
 * the panel's Continue/Dismiss control.
 *
 * EXAMPLE, NOT PLACED. No scene in this world carries this component, so no
 * world creates a PVar until someone adds it. To use it:
 *   1. Add `NuxTutorial` to its own scene entity and set `variableName`,
 *      e.g. `seen_intro`. Use one entity per tutorial: two components of the
 *      same class on one entity share one set of properties.
 *   2. Render from a client component: show the tutorial UI while the local
 *      player has not seen it, hide it once they have.
 *        NuxTutorial.find('seen_intro')?.addListener((player, seen) => {
 *          if (PlayerService.get().isLocalPlayer(player)) {
 *            tutorialPanel.visible = !seen;
 *          }
 *        });
 *      `isSeen(player)` returns the current state, or undefined until it
 *      arrives. Look the component up in `OnEntityStartEvent` or later, not at
 *      module load. Listeners fire when the state loads and when it changes;
 *      a dismiss notifies at once (optimistic) and the server confirm is
 *      deduped, but keep listeners idempotent regardless.
 *   3. Dismiss from the tutorial UI's Dismiss control, on a client:
 *        NuxTutorial.find('seen_intro')?.dismiss();
 *      The local UI hides at once; the server saves seen for that player.
 *   4. Or mark seen from server code (a finished onboarding quest, a cutscene
 *      ending): `NuxTutorial.find('seen_intro')?.markSeen(player);`
 *
 * How it works:
 * - `PlayerVariablesService` is server only. The server reads the saved value
 *   once when a player joins (`fetchVariable`). A player who has never been
 *   saved counts as unseen; nothing is written until they are marked seen.
 * - A client dismiss that arrives before that read has finished is remembered
 *   and applied when the read lands, so a fast dismiss cannot be lost to a
 *   slow load. Server `markSeen` before the load is refused (returns false),
 *   as in `SavedPlayerNumber`, so a slow load cannot be overwritten with a
 *   default.
 * - If the read fails (for example in an editor or Anvil preview, which has no
 *   world to save to), the player counts as unseen for the session and
 *   dismissing hides the panel for the session, but nothing is written, so a
 *   backend error cannot overwrite saved progress.
 * - The server saves seen exactly once per player (the value 1), retrying a
 *   failed write after `RETRY_DELAY_MS`. Seen is monotonic: it never returns
 *   to 0.
 * - The server sends each state to clients with `EventService.sendGlobally`,
 *   and each client keeps only its own player's
 *   (`PlayerService.isLocalPlayer`). A client asks for its state again when it
 *   starts, in case it started after the state was sent.
 *
 * Limits:
 * - The PVar name is the save slot. Renaming `variableName` shows the
 *   tutorial again to every player.
 * - Values are visible on the network to every client, not only the owner. Do
 *   not gate anything private on seen this way.
 * - A dismiss names its player in the event, so a client could dismiss for
 *   another player. The cost is a skipped tutorial, not corrupted state: seen
 *   carries no value and never flips back.
 * - A dismiss made just before a player leaves can be lost if its write fails.
 *
 * Component Attachment: its own scene entity, one per tutorial.
 * Component Networking: runs everywhere. The server owns the value; each client
 * receives its own player's copy.
 */

import {
  Component,
  component,
  editor,
  EventService,
  ExecuteOn,
  NetworkEvent,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnPlayerDestroyEvent,
  OnWorldUpdateEvent,
  PlayerService,
  PlayerVariablesService,
  property,
  serializable,
  subscribe,
  type Entity,
  type Maybe,
  type OnPlayerCreateEventPayload,
  type OnPlayerDestroyEventPayload,
} from 'meta/worlds';

/** Shortest gap between two writes of one player's value, under the backend's 3 a second. */
export const MIN_WRITE_INTERVAL_MS = 400;
/** Wait before retrying a failed write. */
export const RETRY_DELAY_MS = 2000;

/** Called when a player's seen state loads and every time it changes. */
export type NuxTutorialListener = (player: Entity, seen: boolean) => void;

/**
 * One player's seen state and write queue on the server. It decides what to
 * write and when; `NuxTutorial` performs the reads and writes. Kept free of
 * the backend so it can be unit tested.
 */
export class NuxSeenSlot {
  private loaded = false;
  private saveDisabled = false;
  private seenState = false;
  private writing = false;
  private dirty = false;
  private nextWriteAt = 0;

  /** The seen state, or undefined until the saved value has loaded. */
  get seen(): boolean | undefined {
    return this.loaded ? this.seenState : undefined;
  }

  /** True when nothing is being written and nothing is waiting to be. */
  get idle(): boolean {
    return !this.writing && !this.dirty;
  }

  /** The read finished. `saved` is the stored number, 1 when seen. */
  load(saved: unknown): boolean {
    this.seenState = saved === 1;
    this.loaded = true;
    return this.seenState;
  }

  /** The read failed: show the tutorial this session, but never write. */
  loadUnsaved(): boolean {
    this.saveDisabled = true;
    this.seenState = false;
    this.loaded = true;
    return this.seenState;
  }

  /** Mark seen. Returns false until the saved value has loaded. Idempotent. */
  markSeen(): boolean {
    if (!this.loaded) {
      return false;
    }
    if (!this.seenState) {
      this.seenState = true;
      this.dirty = true;
    }
    return true;
  }

  /** The value to write at `nowMs`, or null while a write is in flight, too soon after the last, or nothing changed. */
  beginWrite(nowMs: number): number | null {
    if (this.saveDisabled) {
      this.dirty = false;
      return null;
    }
    if (this.writing || !this.dirty || nowMs < this.nextWriteAt) {
      return null;
    }
    this.writing = true;
    this.dirty = false;
    return 1;
  }

  /** The write finished at `nowMs`. A failed write leaves a retry waiting. */
  endWrite(succeeded: boolean, nowMs: number): void {
    this.writing = false;
    if (succeeded) {
      this.nextWriteAt = nowMs + MIN_WRITE_INTERVAL_MS;
    } else {
      this.dirty = true;
      this.nextWriteAt = nowMs + RETRY_DELAY_MS;
    }
  }
}

/** Server to clients: a player's seen state. */
@serializable()
export class NuxTutorialSeenPayload {
  @property() public readonly variableName: string = '';
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly seen: boolean = false;
  constructor(variableName: string = '', player: Maybe<Entity> = null, seen: boolean = false) {
    this.variableName = variableName;
    this.player = player;
    this.seen = seen;
  }
}

export const NuxTutorialSeenEvent = new NetworkEvent('NuxTutorialSeen', NuxTutorialSeenPayload);

/** Client to server: this client's player dismissed `variableName`. */
@serializable()
export class NuxTutorialDismissPayload {
  @property() public readonly variableName: string = '';
  @property() public readonly player: Maybe<Entity> = null;
  constructor(variableName: string = '', player: Maybe<Entity> = null) {
    this.variableName = variableName;
    this.player = player;
  }
}

export const NuxTutorialDismissEvent = new NetworkEvent('NuxTutorialDismiss', NuxTutorialDismissPayload);

/** Client to server: send the current states of `variableName` again. */
@serializable()
export class NuxTutorialRequestPayload {
  @property() public readonly variableName: string = '';
  constructor(variableName: string = '') {
    this.variableName = variableName;
  }
}

export const NuxTutorialRequestEvent = new NetworkEvent('NuxTutorialRequest', NuxTutorialRequestPayload);

@component({
  description:
    'Example: shows one tutorial once per player, saving seen = 1 in a player variable and restoring it when they rejoin. Renders nothing itself: game code shows its panel from addListener and calls dismiss(). Not placed in any scene.',
})
export class NuxTutorial extends Component {
  private static readonly byName = new Map<string, NuxTutorial>();

  /** The component saving `variableName`, or null if no scene carries one. Works on the server and on clients. */
  public static find(variableName: string): Maybe<NuxTutorial> {
    const found = NuxTutorial.byName.get(variableName) ?? null;
    return found != null && found.isAlive() ? found : null;
  }

  @editor({
    description:
      'Required. The player variable to save seen = 1 into, e.g. seen_intro. This is the save slot: renaming it shows the tutorial again to every player.',
  })
  @property()
  public variableName: string = '';

  private readonly listeners: NuxTutorialListener[] = [];
  private registered = false;
  private registeredName = '';
  private isServer = false;

  // Server only.
  private readonly slots = new Map<Entity, NuxSeenSlot>();
  private readonly pending = new Set<Entity>();
  private readonly leaving = new Set<Entity>();
  /** Dismisses that arrived before a player's saved value finished loading. */
  private readonly bufferedDismiss = new Set<Entity>();

  // Client only: the local player's seen state once it has arrived.
  private localSeen: boolean | undefined = undefined;

  /** The player's seen state, or undefined until it has loaded. On a client, only the local player's. */
  public isSeen(player: Entity): boolean | undefined {
    if (this.isServer) {
      return this.slots.get(this.keyFor(player))?.seen;
    }
    return PlayerService.get().isLocalPlayer(player) ? this.localSeen : undefined;
  }

  /**
   * Server: mark the player's tutorial seen and save it. Returns false on a
   * client or until their saved value has loaded. Idempotent.
   */
  public markSeen(player: Entity): boolean {
    if (!this.isServer) {
      return false;
    }
    const canonical = this.keyFor(player);
    const slot = this.slots.get(canonical);
    const before = slot?.seen;
    if (slot == null || !slot.markSeen()) {
      return false;
    }
    if (before !== true) {
      this.publish(canonical, true);
      this.pending.add(canonical);
      this.writeNext(canonical, slot);
    }
    return true;
  }

  /**
   * Client: dismiss the local player's tutorial. Listeners fire at once, and
   * the server saves seen. Returns false when there is no local player yet.
   * Server code calls markSeen(player) instead.
   */
  public dismiss(): boolean {
    if (this.isServer || !this.registered) {
      return false;
    }
    const localPlayer = PlayerService.get().getLocalPlayer();
    if (localPlayer == null) {
      return false;
    }
    if (this.localSeen !== true) {
      this.localSeen = true;
      this.notify(localPlayer, true);
    }
    EventService.sendGlobally(
      NuxTutorialDismissEvent,
      new NuxTutorialDismissPayload(this.variableName, localPlayer),
    );
    return true;
  }

  /** Call `listener` when a player's seen state loads and whenever it changes. On a client, for the local player only. Returns an unsubscribe function. */
  public addListener(listener: NuxTutorialListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    if (this.variableName === '') {
      console.warn('[NuxTutorial] variableName is not set; nothing is saved.');
      return;
    }
    const existing = NuxTutorial.byName.get(this.variableName);
    if (existing != null && existing !== this && existing.isAlive()) {
      console.warn(`[NuxTutorial] two components save '${this.variableName}'; only the first is used.`);
      return;
    }
    NuxTutorial.byName.set(this.variableName, this);
    this.registered = true;
    this.registeredName = this.variableName;
    this.isServer = NetworkingService.get().isServerContext();
    if (this.isServer) {
      for (const player of PlayerService.get().getAllPlayers()) {
        this.load(player);
      }
    } else {
      this.requestStates();
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    // The entity's data is not safe to read during destroy, so use the name saved at registration.
    if (this.registered && NuxTutorial.byName.get(this.registeredName) === this) {
      NuxTutorial.byName.delete(this.registeredName);
    }
    this.registered = false;
  }

  // The registry is static and outlives its components: when the entity is
  // destroyed and a new copy starts in the same script context (as when a preview
  // runtime restarts the world), the old registration can still be here. A
  // registration counts only while its entity is alive.
  private isAlive(): boolean {
    return !this.entity.isDestroyed();
  }

  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (!this.registered || payload.entity == null) {
      return;
    }
    if (this.isServer) {
      this.load(payload.entity);
    } else if (payload.isLocal) {
      this.requestStates();
    }
  }

  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    const incoming = payload.entity;
    if (!this.registered || !this.isServer || incoming == null) {
      return;
    }
    const player = this.keyFor(incoming);
    this.deleteBuffered(player);
    const slot = this.slots.get(player);
    if (slot == null || slot.idle) {
      this.slots.delete(player);
      this.deleteFromSet(this.pending, player);
    } else {
      // Let the queued change finish first.
      this.leaving.add(player);
    }
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(): void {
    if (!this.registered || !this.isServer || this.pending.size === 0) {
      return;
    }
    for (const player of this.pending) {
      const slot = this.slots.get(player);
      if (slot == null) {
        this.pending.delete(player);
      } else {
        this.writeNext(player, slot);
      }
    }
  }

  @subscribe(NuxTutorialSeenEvent, {execution: ExecuteOn.Everywhere})
  private onSeen(payload: NuxTutorialSeenPayload): void {
    if (!this.registered || this.isServer || payload.variableName !== this.variableName) {
      return;
    }
    const playerService = PlayerService.get();
    const localPlayer = playerService.getLocalPlayer();
    // Entities in a network payload are new references, so compare with isLocalPlayer, not ===.
    if (localPlayer == null || !playerService.isLocalPlayer(payload.player)) {
      return;
    }
    if (this.localSeen !== payload.seen) {
      this.localSeen = payload.seen;
      this.notify(localPlayer, payload.seen);
    }
  }

  @subscribe(NuxTutorialDismissEvent, {execution: ExecuteOn.Everywhere})
  private onDismiss(payload: NuxTutorialDismissPayload): void {
    if (!this.registered || !this.isServer || payload.variableName !== this.variableName) {
      return;
    }
    const incoming = payload.player;
    if (incoming == null || incoming.isDestroyed() || !incoming.valid) {
      return;
    }
    // Entities in a network payload are new references, so resolve to the
    // canonical player before the identity-keyed lookup.
    const player = this.keyFor(incoming);
    const slot = this.slots.get(player);
    if (slot == null) {
      console.warn('[NuxTutorial] dismiss for an untracked player; ignoring.');
      return;
    }
    if (slot.seen === undefined) {
      // Their saved value is still loading: apply the dismiss when it lands.
      this.bufferedDismiss.add(player);
      return;
    }
    this.markSeen(player);
  }

  @subscribe(NuxTutorialRequestEvent, {execution: ExecuteOn.Everywhere})
  private onRequest(payload: NuxTutorialRequestPayload): void {
    if (!this.registered || !this.isServer || payload.variableName !== this.variableName) {
      return;
    }
    for (const [player, slot] of this.slots) {
      const seen = slot.seen;
      if (seen !== undefined) {
        this.broadcast(player, seen);
      }
    }
  }

  private requestStates(): void {
    EventService.sendGlobally(NuxTutorialRequestEvent, new NuxTutorialRequestPayload(this.variableName));
  }

  private load(incoming: Entity): void {
    const player = this.keyFor(incoming);
    if (this.slots.has(player)) {
      return;
    }
    const slot = new NuxSeenSlot();
    this.slots.set(player, slot);
    PlayerVariablesService.get()
      .fetchVariable<number>(player, this.variableName)
      .then(saved => {
        if (this.slots.get(player) !== slot) {
          return; // The player left before their value arrived.
        }
        this.completeLoad(player, slot, slot.load(saved));
      })
      .catch((error: unknown) => {
        console.warn(
          `[NuxTutorial] could not read '${this.variableName}' for '${String(player.name)}'; showing the tutorial without saving this session.`,
          error,
        );
        if (this.slots.get(player) === slot) {
          this.completeLoad(player, slot, slot.loadUnsaved());
        }
      });
  }

  private writeNext(player: Entity, slot: NuxSeenSlot): void {
    const value = slot.beginWrite(Date.now());
    if (value === null) {
      if (slot.idle) {
        this.pending.delete(player);
        this.forgetIfLeft(player, slot);
      }
      return;
    }
    PlayerVariablesService.get()
      .setVariable(player, this.variableName, value)
      .then(() => {
        slot.endWrite(true, Date.now());
        if (slot.idle) {
          this.pending.delete(player);
          this.forgetIfLeft(player, slot);
        }
      })
      .catch((error: unknown) => {
        slot.endWrite(false, Date.now());
        console.warn(`[NuxTutorial] could not save '${this.variableName}' = ${value}; retrying.`, error);
        if (this.leaving.has(player)) {
          this.pending.delete(player);
          this.forgetIfLeft(player, slot, true);
        }
      });
  }

  /**
   * The canonical reference for a player: entities in a network payload are
   * new references, so match by identity string against the tracked slots,
   * then the live players, before falling back to the incoming reference.
   */
  private keyFor(player: Entity): Entity {
    const tag = player.toString();
    for (const known of this.slots.keys()) {
      if (known.toString() === tag) {
        return known;
      }
    }
    for (const known of PlayerService.get().getAllPlayers()) {
      if (known.toString() === tag) {
        return known;
      }
    }
    return player;
  }

  /** Remove a buffered dismiss, matching by identity string when the reference is new. */
  private deleteBuffered(player: Entity): boolean {
    if (this.bufferedDismiss.delete(player)) {
      return true;
    }
    return this.deleteFromSet(this.bufferedDismiss, player);
  }

  /** Remove from an entity set, falling back to an identity-string scan for new references. */
  private deleteFromSet(set: Set<Entity>, player: Entity): boolean {
    const tag = player.toString();
    for (const known of [...set]) {
      if (known.toString() === tag) {
        set.delete(known);
        return true;
      }
    }
    return false;
  }

  /**
   * Publish a loaded value, collapsing a buffered dismiss into a single
   * final seen=true so the panel never flashes back. An already-saved seen
   * publishes with no redundant write; an unsaved session still funnels
   * through writeNext, which is a no-op cleanup while saving is disabled.
   */
  private completeLoad(player: Entity, slot: NuxSeenSlot, loadedSeen: boolean): void {
    if (!this.deleteBuffered(player)) {
      this.publish(player, loadedSeen);
      return;
    }
    if (loadedSeen) {
      this.publish(player, true);
      return;
    }
    if (slot.markSeen()) {
      this.publish(player, true);
      this.pending.add(player);
      this.writeNext(player, slot);
    }
  }

  /** Drop a player who has left once their writes are done, or as soon as one fails. */
  private forgetIfLeft(player: Entity, slot: NuxSeenSlot, writeFailed: boolean = false): void {
    if (!this.leaving.has(player) || this.slots.get(player) !== slot) {
      return;
    }
    if (slot.idle || writeFailed) {
      this.leaving.delete(player);
      this.slots.delete(player);
    }
  }

  /** Server: tell server listeners and the player's client about a loaded or changed state. */
  private publish(player: Entity, seen: boolean): void {
    this.notify(player, seen);
    this.broadcast(player, seen);
  }

  private broadcast(player: Entity, seen: boolean): void {
    EventService.sendGlobally(NuxTutorialSeenEvent, new NuxTutorialSeenPayload(this.variableName, player, seen));
  }

  private notify(player: Entity, seen: boolean): void {
    for (const listener of [...this.listeners]) {
      listener(player, seen);
    }
  }
}
