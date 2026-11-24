/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {OnWorldUpdateEvent, service, Service, subscribe, type OnWorldUpdateEventPayload} from 'meta/worlds';

/** Per-frame work an actor component runs while it is registered with {@link ActorFrameTicker}. */
export interface FrameTickable {
  onFrameTick(deltaTime: number): void;
}

/** World seconds between logs of a tick that keeps throwing. */
const REPEAT_LOG_INTERVAL_SEC = 5;

/** A started tick whose last frame threw. */
interface FailureLog {
  secondsSinceLog: number;
  errorsSinceLog: number;
}

/**
 * Runs actor components' per-frame work only while they have some, from this
 * service's one world-update subscription. A component joins with `start`
 * when work begins and leaves with `stop` when it ends, so an idle component
 * costs nothing per frame.
 *
 * Use it for work that starts and stops repeatedly, such as holding a prop.
 * `Component.subscribe` suits work armed a bounded number of times: each call
 * adds an entry to the component's subscription cache that `disconnect()`
 * does not remove, so arming per pickup would grow it until the entity is
 * destroyed.
 *
 * A local service, so it ticks on every machine; each component decides what
 * its tick does there. A component stops its work when it is destroyed.
 */
@service()
export class ActorFrameTicker extends Service {
  private readonly ticking = new Set<FrameTickable>();
  private readonly failing = new Map<FrameTickable, FailureLog>();

  /**
   * Runs every started tick. One that throws does not stop the others, and it
   * keeps ticking: its component still counts the work as running, and a
   * passing failure recovers.
   */
  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(payload: OnWorldUpdateEventPayload): void {
    for (const tickable of this.ticking) {
      try {
        tickable.onFrameTick(payload.deltaTime);
        if (this.failing.size > 0) {
          this.failing.delete(tickable);
        }
      } catch (error) {
        this.reportFailure(tickable, error, payload.deltaTime);
      }
    }
  }

  /**
   * Logs a failing tick's first error at once and, while it keeps throwing,
   * one more every {@link REPEAT_LOG_INTERVAL_SEC} world seconds with the count
   * since: a signal for the whole failure without a line per frame.
   */
  private reportFailure(tickable: FrameTickable, error: unknown, deltaTime: number): void {
    const log = this.failing.get(tickable);
    if (log == null) {
      this.failing.set(tickable, {secondsSinceLog: 0, errorsSinceLog: 0});
      console.error('[ActorFrameTicker] A frame tick threw; it keeps ticking.', error);
      return;
    }
    log.secondsSinceLog += deltaTime;
    log.errorsSinceLog++;
    if (log.secondsSinceLog >= REPEAT_LOG_INTERVAL_SEC) {
      console.error(
        `[ActorFrameTicker] A frame tick is still throwing: ${log.errorsSinceLog} errors in the last ${log.secondsSinceLog.toFixed(1)} s.`,
        error,
      );
      log.secondsSinceLog = 0;
      log.errorsSinceLog = 0;
    }
  }

  /** Runs `tickable` every frame until {@link stop}. Starting a ticking one changes nothing. */
  start(tickable: FrameTickable): void {
    this.ticking.add(tickable);
  }

  stop(tickable: FrameTickable): void {
    this.ticking.delete(tickable);
    this.failing.delete(tickable);
  }

  isTicking(tickable: FrameTickable): boolean {
    return this.ticking.has(tickable);
  }
}
