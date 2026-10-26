import type { ServerEvent } from "../shared/contracts.ts";

export class EventBus {
  private listeners = new Set<(event: ServerEvent) => void>();

  subscribe(listener: (event: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
