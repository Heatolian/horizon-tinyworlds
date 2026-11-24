/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Persistence Scripts v2

/**
 * SavedPlayerNumber - one number per player (coins, best score, level reached)
 * that survives leaving and rejoining the world, stored in one player variable
 * (PVar). Self-contained: no PVar needs defining first, because the backend
 * creates the variable on its first write.
 *
 * EXAMPLE, NOT PLACED. No scene in this world carries this component, so no
 * world creates a PVar until someone adds it. To use it:
 *   1. Add `SavedPlayerNumber` to its own scene entity and set `variableName`,
 *      e.g. `coins`. Use one entity per saved number: two components of the
 *      same class on one entity share one set of properties.
 *   2. Change the value from server code (a pickup, a kill, a finished round):
 *        SavedPlayerNumber.find('coins')?.add(player, 10);
 *      `set(player, value)` replaces it. Both return false on a client, and on
 *      the server until that player's saved value has loaded.
 *   3. Show it in UI from a client component: the local player's value is sent
 *      to their client on join and after every change.
 *        SavedPlayerNumber.find('coins')?.addListener((player, value) => {
 *          this.viewModel.coins = value;
 *        });
 *      `get(player)` returns the current value, or undefined until it arrives.
 *      Look the component up in `OnEntityStartEvent` or later, not at module load.
 *
 * How it works:
 * - `PlayerVariablesService` is server only. The server reads the saved value
 *   once when a player joins (`fetchVariable`). A player who has never been
 *   saved gets `defaultValue`; nothing is written until the value first changes.
 * - Changes are refused until that read has finished, so a slow load cannot
 *   overwrite saved progress with the default. If the read fails (for example
 *   in an editor or Anvil preview, which has no world to save to), the player
 *   counts from `defaultValue` for the session but nothing is written, so a
 *   backend error cannot overwrite saved progress.
 * - Writes go out one at a time per player, at most one every
 *   `MIN_WRITE_INTERVAL_MS`, carrying the latest value. The backend allows 3
 *   writes a second per player per variable and rejects a write while the first
 *   one is still creating the variable. A failed write is retried after
 *   `RETRY_DELAY_MS`.
 * - The server sends each value to clients with `EventService.sendGlobally`, and
 *   each client keeps only its own player's (`PlayerService.isLocalPlayer`). A
 *   client asks for its value again when it starts, in case it started after the
 *   value was sent.
 *
 * Limits:
 * - The PVar name is the save slot. Renaming `variableName` starts every player
 *   from `defaultValue` again.
 * - Values are visible on the network to every client, not only the owner. Do
 *   not save anything private this way.
 * - A PVar holds a number or a JSON object of at most 10,000 characters. For
 *   several related values, save one object instead of many PVars: copy this
 *   script and change `SavedNumberSlot` and the events to carry the object.
 * - A change made just before a player leaves can be lost if its write fails.
 *
 * Component Attachment: its own scene entity, one per saved number.
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

/** Called when a player's value loads and every time it changes. */
export type SavedNumberListener = (player: Entity, value: number) => void;

/**
 * One player's value and write queue on the server. It decides what to write and
 * when; `SavedPlayerNumber` performs the reads and writes. Kept free of the
 * backend so it can be unit tested.
 */
export class SavedNumberSlot {
  private loaded = false;
  private saveDisabled = false;
  private current = 0;
  private writing = false;
  private dirty = false;
  private nextWriteAt = 0;

  /** The value, or undefined until the saved value has loaded. */
  get value(): number | undefined {
    return this.loaded ? this.current : undefined;
  }

  /** True when nothing is being written and nothing is waiting to be. */
  get idle(): boolean {
    return !this.writing && !this.dirty;
  }

  /** The read finished. `saved` is undefined for a player who has never been saved. */
  load(saved: unknown, defaultValue: number): number {
    this.current = isSavableNumber(saved) ? saved : defaultValue;
    this.loaded = true;
    return this.current;
  }

  /** The read failed: count from `defaultValue` this session, but never write. */
  loadUnsaved(defaultValue: number): number {
    this.saveDisabled = true;
    this.current = defaultValue;
    this.loaded = true;
    return this.current;
  }

  /** Change the value. Returns false while unloaded or for a non-finite number. */
  set(next: number): boolean {
    if (!this.loaded || !isSavableNumber(next)) {
      return false;
    }
    if (next !== this.current) {
      this.current = next;
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
    return this.current;
  }

  /** The write finished at `nowMs`. A failed write leaves the value waiting for a retry. */
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

function isSavableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Server to clients: a player's current value. */
@serializable()
export class SavedPlayerNumberValuePayload {
  @property() public readonly variableName: string = '';
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly value: number = 0;
  constructor(variableName: string = '', player: Maybe<Entity> = null, value: number = 0) {
    this.variableName = variableName;
    this.player = player;
    this.value = value;
  }
}

export const SavedPlayerNumberValueEvent = new NetworkEvent('SavedPlayerNumberValue', SavedPlayerNumberValuePayload);

/** Client to server: send the current values of `variableName` again. */
@serializable()
export class SavedPlayerNumberRequestPayload {
  @property() public readonly variableName: string = '';
  constructor(variableName: string = '') {
    this.variableName = variableName;
  }
}

export const SavedPlayerNumberRequestEvent = new NetworkEvent('SavedPlayerNumberRequest', SavedPlayerNumberRequestPayload);

@component({
  description:
    'Example: saves one number per player (coins, best score) in a player variable, restores it when they rejoin and sends it to their client for UI. Not placed in any scene.',
})
export class SavedPlayerNumber extends Component {
  private static readonly byName = new Map<string, SavedPlayerNumber>();

  /** The component saving `variableName`, or null if no scene carries one. Works on the server and on clients. */
  public static find(variableName: string): Maybe<SavedPlayerNumber> {
    const found = SavedPlayerNumber.byName.get(variableName) ?? null;
    return found != null && found.isAlive() ? found : null;
  }

  @editor({
    description:
      'Required. The player variable to save into, e.g. coins. This is the save slot: renaming it starts every player from defaultValue.',
  })
  @property()
  public variableName: string = '';

  @editor({description: 'The value for a player who has never been saved.'})
  @property()
  public defaultValue: number = 0;

  private readonly listeners: SavedNumberListener[] = [];
  private registered = false;
  private registeredName = '';
  private isServer = false;

  // Server only.
  private readonly slots = new Map<Entity, SavedNumberSlot>();
  private readonly pending = new Set<Entity>();
  private readonly leaving = new Set<Entity>();

  // Client only: the local player's value once it has arrived.
  private localValue: number | undefined = undefined;

  /** The player's value, or undefined until it has loaded. On a client, only the local player's. */
  public get(player: Entity): number | undefined {
    if (this.isServer) {
      return this.slots.get(player)?.value;
    }
    return PlayerService.get().isLocalPlayer(player) ? this.localValue : undefined;
  }

  /** Server: set the player's value and save it. Returns false on a client or until their value has loaded. */
  public set(player: Entity, value: number): boolean {
    const slot = this.isServer ? this.slots.get(player) : null;
    const before = slot?.value;
    if (slot == null || !slot.set(value)) {
      return false;
    }
    if (value !== before) {
      this.publish(player, value);
      this.pending.add(player);
      this.writeNext(player, slot);
    }
    return true;
  }

  /** Server: add to the player's value (negative to subtract) and save it. Returns false on a client or until it has loaded. */
  public add(player: Entity, amount: number): boolean {
    const current = this.isServer ? this.get(player) : undefined;
    return current !== undefined && this.set(player, current + amount);
  }

  /** Call `listener` when a player's value loads and whenever it changes. On a client, for the local player only. Returns an unsubscribe function. */
  public addListener(listener: SavedNumberListener): () => void {
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
      console.warn('[SavedPlayerNumber] variableName is not set; nothing is saved.');
      return;
    }
    const existing = SavedPlayerNumber.byName.get(this.variableName);
    if (existing != null && existing !== this && existing.isAlive()) {
      console.warn(`[SavedPlayerNumber] two components save '${this.variableName}'; only the first is used.`);
      return;
    }
    SavedPlayerNumber.byName.set(this.variableName, this);
    this.registered = true;
    this.registeredName = this.variableName;
    this.isServer = NetworkingService.get().isServerContext();
    if (this.isServer) {
      for (const player of PlayerService.get().getAllPlayers()) {
        this.load(player);
      }
    } else {
      this.requestValue();
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    // The entity's data is not safe to read during destroy, so use the name saved at registration.
    if (this.registered && SavedPlayerNumber.byName.get(this.registeredName) === this) {
      SavedPlayerNumber.byName.delete(this.registeredName);
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
      this.requestValue();
    }
  }

  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    const player = payload.entity;
    if (!this.registered || !this.isServer || player == null) {
      return;
    }
    const slot = this.slots.get(player);
    if (slot == null || slot.idle) {
      this.slots.delete(player);
      this.pending.delete(player);
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

  @subscribe(SavedPlayerNumberValueEvent, {execution: ExecuteOn.Everywhere})
  private onValue(payload: SavedPlayerNumberValuePayload): void {
    if (!this.registered || this.isServer || payload.variableName !== this.variableName) {
      return;
    }
    const playerService = PlayerService.get();
    const localPlayer = playerService.getLocalPlayer();
    // Entities in a network payload are new references, so compare with isLocalPlayer, not ===.
    if (localPlayer == null || !playerService.isLocalPlayer(payload.player)) {
      return;
    }
    this.localValue = payload.value;
    this.notify(localPlayer, payload.value);
  }

  @subscribe(SavedPlayerNumberRequestEvent, {execution: ExecuteOn.Everywhere})
  private onRequest(payload: SavedPlayerNumberRequestPayload): void {
    if (!this.registered || !this.isServer || payload.variableName !== this.variableName) {
      return;
    }
    for (const [player, slot] of this.slots) {
      const value = slot.value;
      if (value !== undefined) {
        this.broadcast(player, value);
      }
    }
  }

  private requestValue(): void {
    EventService.sendGlobally(SavedPlayerNumberRequestEvent, new SavedPlayerNumberRequestPayload(this.variableName));
  }

  private load(player: Entity): void {
    if (this.slots.has(player)) {
      return;
    }
    const slot = new SavedNumberSlot();
    this.slots.set(player, slot);
    PlayerVariablesService.get()
      .fetchVariable<number>(player, this.variableName)
      .then(saved => {
        if (this.slots.get(player) !== slot) {
          return; // The player left before their value arrived.
        }
        this.publish(player, slot.load(saved, this.defaultValue));
      })
      .catch((error: unknown) => {
        console.warn(
          `[SavedPlayerNumber] could not read '${this.variableName}' for '${String(player.name)}'; counting from ${this.defaultValue} without saving this session.`,
          error,
        );
        if (this.slots.get(player) === slot) {
          this.publish(player, slot.loadUnsaved(this.defaultValue));
        }
      });
  }

  private writeNext(player: Entity, slot: SavedNumberSlot): void {
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
        console.warn(`[SavedPlayerNumber] could not save '${this.variableName}' = ${value}; retrying.`, error);
        if (this.leaving.has(player)) {
          this.pending.delete(player);
          this.forgetIfLeft(player, slot, true);
        }
      });
  }

  /** Drop a player who has left once their writes are done, or as soon as one fails. */
  private forgetIfLeft(player: Entity, slot: SavedNumberSlot, writeFailed: boolean = false): void {
    if (!this.leaving.has(player) || this.slots.get(player) !== slot) {
      return;
    }
    if (slot.idle || writeFailed) {
      this.leaving.delete(player);
      this.slots.delete(player);
    }
  }

  /** Server: tell server listeners and the player's client about a loaded or changed value. */
  private publish(player: Entity, value: number): void {
    this.notify(player, value);
    this.broadcast(player, value);
  }

  private broadcast(player: Entity, value: number): void {
    EventService.sendGlobally(SavedPlayerNumberValueEvent, new SavedPlayerNumberValuePayload(this.variableName, player, value));
  }

  private notify(player: Entity, value: number): void {
    for (const listener of [...this.listeners]) {
      listener(player, value);
    }
  }
}
