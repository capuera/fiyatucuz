import type { Broadcaster, BroadcastHandler, Channel } from './Broadcaster.js';

/**
 * Default Broadcaster implementation. Fans out within the current process only.
 * Intended as a placeholder so callers can program to `Broadcaster` from day one.
 * Do not use this in production for cross-process realtime.
 */
export class InProcessBroadcaster implements Broadcaster {
  private readonly subscribers = new Map<Channel, Set<BroadcastHandler<unknown>>>();

  async publish<T>(channel: Channel, event: string, payload: T): Promise<void> {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event, payload);
      } catch {
        // Swallow subscriber errors; publishers cannot recover from them.
      }
    }
  }

  subscribe<T>(channel: Channel, handler: BroadcastHandler<T>): () => void {
    const typed = handler as BroadcastHandler<unknown>;
    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(typed);
    return () => {
      set?.delete(typed);
    };
  }
}
