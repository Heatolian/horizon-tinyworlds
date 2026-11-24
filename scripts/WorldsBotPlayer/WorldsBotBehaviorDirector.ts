/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v4

// Bot Player Scripts v2

import {
  Component,
  NetworkMode,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  TemplateAsset,
  WorldService,
  component,
  editor,
  property,
  subscribe,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {WorldsBotPlayerService} from './WorldsBotPlayerService';

/**
 * Editor-placeable director for per-bot behavior installation. Place one in
 * the world, next to the WorldsBotFillController that produces the bots. It
 * gives every managed bot its behavior installer as it appears.
 *
 * WHY OUTSIDE THE FILL SERVICE
 * The fill service owns one job -- how many bots exist. WHAT each bot does is
 * a separate decision, and it varies per bot: some bots follow, some attack,
 * some idle. Burying the spawn inside the service forces one template for
 * every bot and re-couples the two lifecycles on every change. Listening from
 * the outside keeps the service closed and puts the per-bot decision -- which
 * template for THIS bot -- in one overridable method below.
 *
 * HOW A BOT GETS ITS INSTALLER -- CALLBACK PLUS CATCH-UP, AND BOTH NEEDED
 * Attachment is driven by WorldsBotPlayerService.addBotCreatedListener, which
 * fires once per bot immediately after it joins the spawn roster (NOT
 * OnPlayerCreate, which fires too early -- before the bot is identifiable).
 * The callback alone only covers bots created from registration onward, so a
 * catch-up sweep covers bots that already exist when this director starts or
 * is re-enabled. A director authored `enabled = false` sweeps nothing until
 * it is turned on.
 *
 * AUTHORITY -- SERVER ONLY, FOR THE SAME REASON BACKFILL IS
 * Every handler bails unless `NetworkingService.isServerContext()`. Bots are
 * server-spawned and server-owned; a client spawning installer children would
 * fork the actor hierarchy.
 *
 * DISABLE SEMANTICS -- STOP SPAWNING, DON'T TEAR DOWN
 * Turning `enabled` off stops installers for NEW bots and leaves existing
 * ones running: destroying an installer entity would orphan the behaviors its
 * starter already attached (removal lives with the starter, not here), while
 * stranding live bots mid-follow. Bots removed by the fill service take their
 * installer children with them, which is the only teardown path.
 *
 * A template CHANGE follows the same no-teardown rule, and the asymmetry is
 * easy to miss: swapping installerTemplate for a different non-null one reaches
 * every bot still without an installer (parked seat-only, or whose spawn
 * failed), but NOT bots already equipped under the old template — they keep
 * the installer they were given. Re-equipping them would
 * mean destroying a live installer, which is the thing this component does not
 * do. To re-template an existing roster, cycle the bots.
 */
@component({
  description:
    'Spawns each managed bot its behavior installer. Place one per world alongside WorldsBotFillController; override resolveInstallerTemplate to vary behavior per bot.',
})
export class WorldsBotBehaviorDirector extends Component {
  @property()
  @editor({
    description:
      'Default installer template spawned as a LocalOnly child under each new bot (e.g. BotBehaviorInstaller). Leave empty for seat-only bots.',
  })
  installerTemplate: Maybe<TemplateAsset> = null;

  @property()
  @editor({
    description:
      'Turn installer spawning on. When off, new bots get no installer; existing ones keep running.',
  })
  enabled: boolean = true;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  private destroyed: boolean = false;
  // Overwritten with `enabled` in onEntityStart, before onWorldUpdate can read
  // it: a director authored disabled would otherwise read as an
  // enabled->disabled transition on frame 1.
  private wasEnabled: boolean = true;
  private registered: boolean = false;

  // Bots this director has already equipped. Pruned when a bot is destroyed,
  // so size is the live count — NOT a sequence number (see
  // nextSequenceNumber). A Set because the sweep membership-tests once per
  // bot per pass, which is O(n^2) over an array.
  private equipped: Set<Entity> = new Set();

  // Bots seen while there was no template to give them. Kept SEPARATE from
  // `equipped` because the two need opposite lifetimes: an equipped bot is
  // done forever, while a seat-only bot is only done until a template shows
  // up. Recording both in one list is the bug this split fixes — the normal
  // install order places this director with `installerTemplate` null and
  // fills it in once implementing-bot-brains has authored the template, so
  // every bot alive during that window would otherwise be marked handled and
  // skipped by every later sweep.
  private seatOnly: Set<Entity> = new Set();

  // Last observed installerTemplate, polled alongside `enabled`. The property
  // is designer-settable with no change event, so a mid-session fill is only
  // visible by comparison.
  private wasInstallerTemplate: Maybe<TemplateAsset> = null;

  // Monotonic equip sequence for per-bot decisions. Unlike equipped.size,
  // this never shrinks when bots leave, so resolveInstallerTemplate can
  // alternate (n % 2) or escalate (n >= k) on ids that are never reused.
  private nextSequenceNumber: number = 0;

  // Each bot's n, assigned on its first resolve and reused on every later
  // one. A seat-only bot is re-resolved whenever a template arrives or the
  // director is re-enabled; a fresh n each time would let an `n % 2` override
  // flip that bot's decision. Pruned with the bot.
  private sequenceByBot: Map<Entity, number> = new Map();

  // Bound once and stored, so add/remove match by identity.
  private readonly onBotCreated = (bot: Entity): void => {
    if (this.isTornDown() || !this.enabled) {
      return;
    }
    void this.equipBot(bot).catch((error) => {
      console.warn(
        '[WorldsBotBehaviorDirector] Unexpected error while equipping bot.',
        error,
      );
    });
  };

  @subscribe(OnEntityStartEvent)
  onEntityStart(): void {
    if (!this.isServer()) {
      return;
    }
    WorldsBotPlayerService.get().addBotCreatedListener(this.onBotCreated);
    this.registered = true;
    this.wasEnabled = this.enabled;
    this.wasInstallerTemplate = this.installerTemplate;
    if (!this.enabled) {
      return;
    }
    // Bots may already exist: the fill controller commonly reconciles before
    // this component starts, and the callback only covers what comes next.
    void this.sweep();
  }

  @subscribe(OnPlayerDestroyEvent)
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!this.isServer()) {
      return;
    }
    // Prune-only: the installer child dies with its bot. detachBrain-style
    // service calls are not needed -- nothing here holds the bot.
    const bot = payload.entity;
    if (bot != null) {
      this.equipped.delete(bot);
      this.seatOnly.delete(bot);
      this.sequenceByBot.delete(bot);
    }
  }

  // Polls both the toggle and the template: each is a designer-settable
  // @property with no change event, so a mid-session edit is only visible by
  // comparison. Acts on transitions only.
  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(_payload: OnWorldUpdateEventPayload): void {
    if (!this.isServer() || this.isTornDown()) {
      return;
    }

    // Checked before the enabled transition and independently of it: filling
    // in the template is the second half of the normal install, and it
    // usually happens with the director already enabled, so gating it on an
    // enabled-transition would miss the case it exists for.
    if (this.installerTemplate !== this.wasInstallerTemplate) {
      this.wasInstallerTemplate = this.installerTemplate;
      // Not gated on seatOnly being non-empty: a bot whose spawn failed is in
      // neither set, and a template change is the creator's fix for it.
      if (this.installerTemplate != null) {
        this.log('installer template set; sweeping bots without an installer');
        this.seatOnly.clear();
        if (this.enabled) {
          void this.sweep();
        }
      }
    }

    if (this.enabled === this.wasEnabled) {
      return;
    }
    this.wasEnabled = this.enabled;
    if (!this.enabled) {
      this.log('disabled: new bots will not be equipped');
    } else {
      this.log('enabled');
      // Bots created while disabled never fired the callback for us, and a
      // bot parked as seat-only may now have a template waiting.
      this.seatOnly.clear();
      void this.sweep();
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onEntityDestroy(): void {
    this.destroyed = true;
    // Deregister BEFORE anything else: the service holds listeners strongly,
    // so one left behind would keep equipping bots on behalf of a director
    // that no longer exists.
    if (this.registered) {
      WorldsBotPlayerService.get().removeBotCreatedListener(this.onBotCreated);
      this.registered = false;
    }
  }

  /**
   * Decide which installer template THIS bot gets. Override point for
   * per-bot variety -- the whole reason spawning lives outside the service:
   *
   *   protected override resolveInstallerTemplate(bot, n) {
   *     return n % 2 === 0 ? this.installerTemplate : this.enemyTemplate;
   *   }
   *
   * Default is every bot gets `installerTemplate` (null = seat-only bot).
   * `n` is the bot's equip sequence number: assigned on its first resolve,
   * then the same for that bot on every re-resolve under this director.
   */
  protected resolveInstallerTemplate(
    _bot: Entity,
    _n: number,
  ): Maybe<TemplateAsset> {
    return this.installerTemplate;
  }

  /**
   * Equip every current bot that lacks an installer. Not a per-frame path.
   *
   * Wrapped by `sweep()` for the fire-and-forget callers: an unexpected throw
   * in here would otherwise land as an unhandled rejection that `void`
   * swallows silently.
   */
  private async equipExistingBots(): Promise<void> {
    for (const bot of WorldsBotPlayerService.get().getBots()) {
      // Re-check every iteration: each equipBot yields at its spawn await,
      // so the director can be disabled or destroyed mid-sweep. Remaining
      // bots must not be equipped on behalf of an inactive director.
      if (this.isTornDown() || !this.enabled || !this.isServer()) {
        return;
      }
      // getBots() is unpruned: skip destroyed handles, already-equipped bots,
      // and bots already parked as seat-only for the CURRENT template state
      // (that list is cleared when a template arrives, so parking is not
      // permanent).
      if (
        bot.isDestroyed() ||
        this.equipped.has(bot) ||
        this.seatOnly.has(bot)
      ) {
        continue;
      }
      await this.equipBot(bot);
    }
  }

  /**
   * Fire-and-forget entry point for the sweep. Every caller reaches it with
   * `void`, so without this catch an unexpected error anywhere outside
   * equipBot's own try/catch would vanish rather than reach the console.
   */
  private sweep(): Promise<void> {
    return this.equipExistingBots().catch((error) => {
      console.warn(
        '[WorldsBotBehaviorDirector] Unexpected error while sweeping bots.',
        error,
      );
    });
  }

  /** Spawn the resolved installer template as a LocalOnly child of one bot. */
  private async equipBot(bot: Entity): Promise<void> {
    // getBots() is unpruned, so a handle here may already be destroyed;
    // spawning under it would orphan an installer with no actor above it.
    if (bot.isDestroyed() || this.equipped.has(bot)) {
      return;
    }
    // Assigned at READ time, not after the spawn. equipBot runs concurrently
    // from the fire-and-forget creation callback and from the awaited catch-up
    // sweep, so assigning after the await would let two in-flight equips of
    // different bots both observe the same n. A failed or rolled-back spawn
    // keeps its n with the bot, so the retry resolves the same way.
    let n = this.sequenceByBot.get(bot);
    if (n === undefined) {
      n = this.nextSequenceNumber++;
      this.sequenceByBot.set(bot, n);
    }
    const template = this.resolveInstallerTemplate(bot, n);
    if (template == null) {
      // Seat-only by configuration, not by failure. Recorded in `seatOnly`
      // rather than `equipped` so the sweep stops retrying it every pass but
      // a template arriving later still reaches this bot — `onWorldUpdate`
      // clears this list the moment `installerTemplate` becomes non-null.
      this.seatOnly.add(bot);
      return;
    }
    // Reserve BEFORE the await: the catch-up sweep and the creation callback
    // both cover newly created bots, so two overlapping calls for the same
    // bot would otherwise both pass the membership guard above and spawn two
    // installers under one bot. Rolled back on failure below.
    this.equipped.add(bot);
    try {
      await WorldService.get().spawnTemplate({
        templateAsset: template,
        networkMode: NetworkMode.LocalOnly,
        position: undefined,
        rotation: undefined,
        parent: bot,
      });
    } catch (error) {
      // WHY: non-fatal — the bot is valid, it just runs without behavior. It is
      // rolled back so a later sweep (start, enabled off->on, or a non-null
      // installerTemplate change) can retry it, but nothing here loops: this
      // component cannot tell a transient failure from a permanent one. The
      // one retry below covers a template change that landed mid-spawn — that
      // sweep skipped this bot because it was still reserved in `equipped`.
      this.equipped.delete(bot);
      console.warn(
        '[WorldsBotBehaviorDirector] Failed to spawn installer under bot; ' +
          'the bot itself is still valid.',
        error,
      );
      if (
        this.enabled &&
        !this.isTornDown() &&
        this.resolveInstallerTemplate(bot, n) !== template
      ) {
        void this.equipBot(bot).catch((retryError) => {
          console.warn(
            '[WorldsBotBehaviorDirector] Unexpected error while equipping bot.',
            retryError,
          );
        });
      }
      return;
    }
    // Re-check after the await: the bot may have been destroyed mid-spawn
    // (its installer child dies with it), or the director torn down. Either
    // way the record must not claim an equipped bot.
    if (bot.isDestroyed() || this.isTornDown()) {
      this.equipped.delete(bot);
      return;
    }
    // log() gates on debugLogEnabled itself.
    this.log(`equipped bot #${n}`);
  }

  private isServer(): boolean {
    return NetworkingService.get().isServerContext();
  }

  private isTornDown(): boolean {
    return this.destroyed || !(this.entity?.valid ?? false);
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log('[WorldsBotBehaviorDirector]', ...args);
    }
  }
}
