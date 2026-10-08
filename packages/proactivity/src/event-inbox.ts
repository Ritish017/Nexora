/**
 * Nexora Deduplicated Event Inbox
 * 
 * Filters duplicate webhooks and external event triggers using a sliding TTL cache.
 */

import type { IncomingEvent } from "./types.ts";

export type EventHandler = (event: IncomingEvent) => Promise<void> | void;

export class EventInbox {
  private readonly processedKeys: Map<string, number> = new Map();
  private readonly handlers: Map<string, EventHandler[]> = new Map();
  readonly ttlMs: number;

  constructor(ttlMs: number = 3600000) { // 1 hour TTL default
    this.ttlMs = ttlMs;
  }

  /**
   * Registers a callback handler for a specific event topic.
   */
  subscribe(topic: string, handler: EventHandler): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
  }

  /**
   * Ingests an event and executes topic subscribers if new.
   * Returns whether the event was processed or rejected as duplicate.
   */
  async ingest(event: IncomingEvent): Promise<{ accepted: boolean; reason?: string }> {
    const dedupeKey = `${event.source}:${event.eventId}`;
    const now = Date.now();

    // Check duplicate
    const seenAt = this.processedKeys.get(dedupeKey);
    if (seenAt && now - seenAt < this.ttlMs) {
      return { accepted: false, reason: "Duplicate event discarded" };
    }

    this.processedKeys.set(dedupeKey, now);

    // Clean old keys if map exceeds 5000 items
    if (this.processedKeys.size > 5000) {
      for (const [k, time] of this.processedKeys.entries()) {
        if (now - time > this.ttlMs) this.processedKeys.delete(k);
      }
    }

    // Dispatch to topic subscribers
    const subscribers = this.handlers.get(event.topic) ?? [];
    for (const sub of subscribers) {
      await sub(event);
    }

    return { accepted: true };
  }
}
