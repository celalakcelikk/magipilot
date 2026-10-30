type Listener<T> = (payload: T) => void;

/**
 * A typed event emitter: `on` returns a function that removes the listener.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<E extends keyof Events>(event: E, listener: Listener<Events[E]>): void {
    <FILL>this.listeners.get(event)?.delete(listener as Listener<never>);</FILL>
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<Events[E]>)(payload);
    }
  }
}
