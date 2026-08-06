import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Observable, Subject } from 'rxjs';
import type { Env } from '../config/env.validation';
import { QUEUE_CONNECTION } from '../queue/queue.constants';
import { createRedisConnection } from '../queue/redis.connection';
import { channelFor, type LiveEvent, type PublishedEvent } from './events.types';

/**
 * Fans live events out to connected browsers.
 *
 * WHY REDIS AND NOT AN IN-PROCESS EMITTER: the thing that produces most of
 * these events is a queue worker, and the browser waiting for them is attached
 * to whichever API instance happened to serve its request. With one process
 * those are the same; with two they are not, and a plain EventEmitter would
 * deliver to roughly half the users. Publishing through Redis makes the number
 * of instances irrelevant — which also means the SSE endpoint keeps working the
 * first time this is scaled, rather than becoming a mystery bug then.
 *
 * SUBSCRIPTION IS PER TENANT AND ON DEMAND. A company's channel is subscribed
 * when its first listener connects and dropped when its last one leaves, so an
 * instance serving one customer never has another customer's events pass
 * through its memory. Filtering a single global channel locally would have been
 * fewer lines and would have made tenant isolation a matter of getting an `if`
 * right, in a system whose central rule is that isolation is not left to
 * individual call sites.
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);

  /**
   * A second connection, separate from the publisher. A Redis client in
   * subscriber mode may issue nothing but (un)subscribe commands, so the same
   * connection cannot also publish.
   */
  private readonly subscriber: Redis;

  /** Live listeners, keyed by company then by an id unique to each connection. */
  private readonly listeners = new Map<string, Map<symbol, Listener>>();

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly publisher: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.subscriber = createRedisConnection(config.get('REDIS_URL', { infer: true }), 'events');

    this.subscriber.on('message', (channel: string, raw: string) => {
      this.dispatch(channel, raw);
    });
  }

  /**
   * Sends an event to a company, or to one person within it.
   *
   * Never throws. A dropped live update is a cosmetic problem — the data is
   * already committed and the next page load shows it — and letting Redis take
   * down a document upload would be a real one.
   */
  async publish(payload: PublishedEvent): Promise<void> {
    try {
      await this.publisher.publish(channelFor(payload.companyId), JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(`Could not publish a ${payload.event.type} event`, error);
    }
  }

  /**
   * An SSE stream for one signed-in browser.
   *
   * The returned Observable is cold-per-subscriber: subscribing registers the
   * listener, and unsubscribing — which Nest does when the HTTP connection
   * closes — removes it and releases the Redis subscription if it was the last
   * one for that company.
   */
  stream(companyId: string, userId: string): Observable<LiveEvent> {
    return new Observable<LiveEvent>((observer) => {
      const subject = new Subject<LiveEvent>();
      const key = Symbol('sse-listener');
      const subscription = subject.subscribe(observer);

      void this.attach(companyId, key, { userId, subject });

      return () => {
        subscription.unsubscribe();
        subject.complete();
        void this.detach(companyId, key);
      };
    });
  }

  private async attach(companyId: string, key: symbol, listener: Listener): Promise<void> {
    let company = this.listeners.get(companyId);

    if (!company) {
      company = new Map();
      this.listeners.set(companyId, company);

      try {
        await this.subscriber.subscribe(channelFor(companyId));
      } catch (error) {
        this.logger.error(`Could not subscribe to events for company ${companyId}`, error);
      }
    }

    company.set(key, listener);
  }

  private async detach(companyId: string, key: symbol): Promise<void> {
    const company = this.listeners.get(companyId);

    if (!company) {
      return;
    }

    company.delete(key);

    if (company.size === 0) {
      this.listeners.delete(companyId);

      try {
        await this.subscriber.unsubscribe(channelFor(companyId));
      } catch (error) {
        this.logger.warn(`Could not unsubscribe from events for company ${companyId}`, error);
      }
    }
  }

  /** Routes one Redis message to the browsers it belongs to. */
  private dispatch(channel: string, raw: string): void {
    let payload: PublishedEvent;

    try {
      payload = JSON.parse(raw) as PublishedEvent;
    } catch {
      this.logger.warn(`Discarded an unparseable event on ${channel}`);
      return;
    }

    for (const listener of this.listeners.get(payload.companyId)?.values() ?? []) {
      // An addressed event reaches only its recipient; an unaddressed one
      // reaches everyone in the company.
      if (payload.userId && payload.userId !== listener.userId) {
        continue;
      }

      listener.subject.next(payload.event);
    }
  }

  /**
   * Closes every open stream so clients see a clean end rather than a hung
   * connection, then drops the Redis socket — an open one keeps the event loop
   * alive and turns a graceful stop into a timeout.
   *
   * Synchronous: `disconnect()` is immediate and there is nothing to await.
   * Using `quit()` here would be async but would also wait on a socket that is
   * about to be torn down anyway.
   */
  onModuleDestroy(): void {
    for (const company of this.listeners.values()) {
      for (const listener of company.values()) {
        listener.subject.complete();
      }
    }

    this.listeners.clear();
    this.subscriber.disconnect();
  }
}

interface Listener {
  userId: string;
  subject: Subject<LiveEvent>;
}
