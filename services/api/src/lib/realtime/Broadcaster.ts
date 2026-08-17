// Broadcaster abstraction — see adr/0010-realtime-abstraction-first.md.
// A real transport (WebSocket + Redis pub/sub leading candidate) is introduced on
// the first real use case. Callers program to this interface only.

export type Channel = string;

export type BroadcastHandler<T = unknown> = (event: string, payload: T) => void;

export interface Broadcaster {
  publish<T>(channel: Channel, event: string, payload: T): Promise<void>;
  /**
   * Returns an `unsubscribe` function to remove the handler.
   * Channel scoping (e.g. per-tenant) is a caller convention at MVP; the concrete
   * transport enforces it at the transport boundary when it lands.
   */
  subscribe<T>(channel: Channel, handler: BroadcastHandler<T>): () => void;
}
